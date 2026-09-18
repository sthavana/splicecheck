/**
 * Inband SCTE-35: reading the cue from the segments themselves, and checking
 * it agrees with what the manifest claims.
 *
 * The manifest is a transcription. An encoder emits SCTE-35 into the transport
 * stream or into an `emsg`, and a packager then writes a tag describing it. The
 * two can disagree — in which time the break occupies, in whether it is there
 * at all — and nothing in a manifest-only view can see that. This is the layer
 * that can.
 */

import type { AdBreak, Finding, RenditionAnalysis, Severity } from "./analyze";
import { fillTemplate, parseMpd, type DashAdaptationSet, type DashPeriod, type MpdDocument } from "./dash";
import type { HlsSegment } from "./hls";
import { resolveUri } from "./hls";
import { findEmsgBoxes, readBaseMediaDecodeTime } from "./mp4";
import { looksLikeTransportStream, scanTransportStream } from "./ts";
import { parseSpliceInfoSection, START_TYPES, type SpliceInfoSection } from "./scte35";
import { assertPublicUrl } from "./runner";

/** The PTS clock is 33 bits at 90kHz — a little over 26.5 hours. */
const PTS_MODULUS = 2 ** 33;
const PTS_HZ = 90_000;

export interface InbandSignal {
  carriage: "mpeg-ts" | "emsg";
  segmentUri: string;
  /** MPEG-TS: the PID the cue arrived on */
  pid?: number;
  /** MPEG-TS: whether it was a section or an ID3 PRIV frame in a PES */
  tsCarriage?: "section" | "id3-pes";
  /** ID3 PRIV owner identifier */
  owner?: string;
  /** emsg: the box's scheme and id */
  schemeIdUri?: string;
  emsgId?: number;
  /** splice point on the PTS clock, in seconds, where the signal states one */
  splicePts?: number;
  /** splice point resolved to wall clock, where the segment could be anchored */
  pdt?: number;
  eventId?: number;
  outOfNetwork?: boolean;
  durationSeconds?: number;
  section?: SpliceInfoSection;
  decodeError?: string;
  hex: string;
}

export interface SegmentProbe {
  attempted: number;
  fetched: number;
  bytes: number;
  /** how many segments the window holds, so a null result can be qualified */
  available?: number;
  format: "mpeg-ts" | "cmaf" | "mixed" | "unknown";
  signals: InbandSignal[];
  findings: Finding[];
  fetchErrors: string[];
}

export interface ProbeOptions {
  /** how many segments to fetch at most */
  maxSegments?: number;
  /** per-request timeout */
  timeoutMs?: number;
  /** cap on a single segment, to avoid pulling a whole programme */
  maxBytes?: number;
}

const DEFAULTS: Required<ProbeOptions> = {
  maxSegments: 8,
  timeoutMs: 15_000,
  maxBytes: 24 * 1024 * 1024,
};

async function fetchSegment(url: string, opts: Required<ProbeOptions>): Promise<Uint8Array> {
  assertPublicUrl(url);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      cache: "no-store",
      headers: { "User-Agent": "SpliceCheck/0.1 (ad-signalling inspector)" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = await res.arrayBuffer();
    if (buf.byteLength > opts.maxBytes) throw new Error("segment is unreasonably large");
    return new Uint8Array(buf);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Chooses which segments are worth fetching: the ones a break starts in, then
 * a spread across the window so a signal present only inband is still found.
 */
export function chooseSegments(rendition: RenditionAnalysis, limit: number): HlsSegment[] {
  const segs = rendition.playlist?.segments ?? [];
  if (segs.length === 0) return [];
  const picked = new Map<number, HlsSegment>();

  for (const b of rendition.breaks) {
    // The cue sits in the first segment of the avail, or in the one before it.
    const at = segs.findIndex((s) => Math.abs(s.startTime - b.startTime) < 0.001);
    if (at >= 0) {
      if (at > 0) picked.set(at - 1, segs[at - 1]);
      picked.set(at, segs[at]);
    }
    if (picked.size >= limit) break;
  }

  if (picked.size < limit) {
    const stride = Math.max(1, Math.floor(segs.length / (limit - picked.size)));
    for (let i = 0; i < segs.length && picked.size < limit; i += stride) picked.set(i, segs[i]);
  }

  return [...picked.entries()].sort((a, b) => a[0] - b[0]).slice(0, limit).map(([, s]) => s);
}

/** Smallest signed distance between two 33-bit PTS values, in ticks. */
function ptsDelta(a: number, b: number): number {
  let d = (a - b) % PTS_MODULUS;
  if (d > PTS_MODULUS / 2) d -= PTS_MODULUS;
  if (d < -PTS_MODULUS / 2) d += PTS_MODULUS;
  return d;
}

function summarise(section: SpliceInfoSection): {
  eventId?: number;
  splicePts?: number;
  outOfNetwork?: boolean;
  durationSeconds?: number;
} {
  const seg = section.descriptors.find((d) => d.tag === 0x02 && "typeId" in d) as
    | { typeId: number; segmentationEventId: number; segmentationDurationSeconds?: number }
    | undefined;
  const si = section.spliceInsert;
  const base = section.ptsAdjustment / PTS_HZ;
  return {
    eventId: seg?.segmentationEventId ?? si?.spliceEventId,
    splicePts:
      section.timeSignal?.ptsSeconds !== undefined
        ? section.timeSignal.ptsSeconds + base
        : si?.spliceTime?.ptsSeconds !== undefined
          ? si.spliceTime.ptsSeconds + base
          : undefined,
    outOfNetwork: seg ? START_TYPES.has(seg.typeId) : si?.outOfNetwork,
    durationSeconds: seg?.segmentationDurationSeconds ?? si?.breakDuration?.seconds,
  };
}

function decodeSection(bytes: Uint8Array): { section?: SpliceInfoSection; error?: string; hex: string } {
  const hex = Buffer.from(bytes).toString("hex");
  try {
    return { section: parseSpliceInfoSection("0x" + hex), hex };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e), hex };
  }
}

/** Extracts every inband signal from one segment. */
export function readSegment(buf: Uint8Array, uri: string, segmentPdt?: number): InbandSignal[] {
  const signals: InbandSignal[] = [];

  if (looksLikeTransportStream(buf)) {
    const scan = scanTransportStream(buf);
    for (const cue of scan.cues) {
      const { section, error, hex } = decodeSection(cue.data);
      const s: InbandSignal = {
        carriage: "mpeg-ts",
        segmentUri: uri,
        pid: cue.pid,
        tsCarriage: cue.carriage,
        owner: cue.owner,
        hex,
        section,
        decodeError: error,
      };
      if (section) {
        Object.assign(s, summarise(section));
        // Place the cue on the clock. Prefer the splice point the section
        // states; fall back to the PTS of the PES that carried it, which is
        // where an immediate splice actually lands.
        //
        // The anchor must be the segment's first presentation timestamp, which
        // is what program date-time names. The PCR leads it by the decoder
        // buffer delay, so using that instead offsets every cue by a constant.
        const anchor = scan.firstPts ?? scan.firstPcr;
        const target =
          s.splicePts !== undefined ? s.splicePts * PTS_HZ : cue.pts !== undefined ? cue.pts : undefined;
        if (target !== undefined && anchor !== undefined && segmentPdt !== undefined) {
          s.pdt = segmentPdt + (ptsDelta(target, anchor) / PTS_HZ) * 1000;
        }
      }
      signals.push(s);
    }
    return signals;
  }

  // A version-1 emsg states an absolute media time, which only becomes wall
  // clock relative to where this segment sits on the timeline.
  const baseDecodeTime = readBaseMediaDecodeTime(buf);

  for (const e of findEmsgBoxes(buf)) {
    if (!/scte35/i.test(e.schemeIdUri)) continue;
    const { section, error, hex } = decodeSection(e.messageData);
    const s: InbandSignal = {
      carriage: "emsg",
      segmentUri: uri,
      schemeIdUri: e.schemeIdUri,
      emsgId: e.id,
      hex,
      section,
      decodeError: error,
    };
    if (section) Object.assign(s, summarise(section));
    if (segmentPdt !== undefined) {
      if (e.presentationTimeDelta !== undefined) {
        // Version 0 is timed from the start of the segment carrying it.
        s.pdt = segmentPdt + (e.presentationTimeDelta / e.timescale) * 1000;
      } else if (e.presentationTime !== undefined && baseDecodeTime !== undefined) {
        // Version 1 is absolute, so anchor it against this segment's own
        // decode time. Only trust the result if the two are on the same clock,
        // which a wild offset would say they are not.
        const offset = (e.presentationTime - baseDecodeTime) / e.timescale;
        if (Math.abs(offset) < 3600) s.pdt = segmentPdt + offset * 1000;
      }
    }
    signals.push(s);
  }
  return signals;
}

/** Fetches a bounded set of segments from an HLS rendition and reads their signals. */
export async function probeRendition(
  rendition: RenditionAnalysis,
  options: ProbeOptions = {},
): Promise<SegmentProbe> {
  const opts = { ...DEFAULTS, ...options };
  const probe: SegmentProbe = {
    attempted: 0,
    fetched: 0,
    bytes: 0,
    format: "unknown",
    signals: [],
    findings: [],
    fetchErrors: [],
  };

  const chosen = chooseSegments(rendition, opts.maxSegments);
  probe.available = rendition.playlist?.segments.length;
  probe.attempted = chosen.length;
  const formats = new Set<string>();

  const results = await Promise.allSettled(
    chosen.map(async (seg) => {
      const url = resolveUri(rendition.uri, seg.uri);
      const buf = await fetchSegment(url, opts);
      return { seg, url, buf };
    }),
  );

  for (const r of results) {
    if (r.status === "rejected") {
      probe.fetchErrors.push(r.reason instanceof Error ? r.reason.message : String(r.reason));
      continue;
    }
    const { seg, url, buf } = r.value;
    probe.fetched++;
    probe.bytes += buf.length;
    formats.add(looksLikeTransportStream(buf) ? "mpeg-ts" : "cmaf");
    probe.signals.push(...readSegment(buf, url, seg.pdt));
  }

  probe.format =
    formats.size === 0 ? "unknown" : formats.size > 1 ? "mixed" : ([...formats][0] as "mpeg-ts" | "cmaf");
  probe.findings = compareWithManifest(rendition, probe);
  return probe;
}

/** The point of the exercise: does the inband signal match the manifest's? */
export function compareWithManifest(rendition: RenditionAnalysis, probe: SegmentProbe): Finding[] {
  const findings: Finding[] = [];
  const add = (severity: Severity, code: string, title: string, detail: string, extra: Partial<Finding> = {}) =>
    findings.push({ severity, code, title, detail, rendition: rendition.label, ...extra });

  for (const s of probe.signals) {
    if (s.decodeError) {
      add(
        "error",
        "INBAND_SCTE35_UNDECODABLE",
        `Inband SCTE-35 could not be decoded${s.pid !== undefined ? ` on PID 0x${s.pid.toString(16)}` : ""}`,
        `A section was found in ${s.segmentUri.split("/").pop()} but does not parse as a splice_info_section: ${s.decodeError}. The encoder is emitting something the rest of the chain cannot read.`,
      );
    } else if (s.section && !s.section.crcValid) {
      add(
        "warning",
        "INBAND_SCTE35_CRC_INVALID",
        "Inband SCTE-35 CRC-32 does not validate",
        `The section carried in ${s.segmentUri.split("/").pop()} decodes but its CRC is wrong. Because this is the signal as the encoder emitted it, the fault is upstream of the packager rather than introduced by it.`,
      );
    }
  }

  if (probe.fetched === 0) return findings;

  const manifestHasBreaks = rendition.breaks.filter((b) => !b.windowClipped).length > 0;
  if (probe.signals.length === 0) {
    add(
      "info",
      "NO_INBAND_SCTE35",
      "No SCTE-35 in the segments that were read",
      (() => {
        const coverage =
          probe.available && probe.available > probe.fetched
            ? ` That is ${probe.fetched} of the ${probe.available} segments in the window, so a cue carried in one of the rest would not have been seen.`
            : "";
        return manifestHasBreaks
          ? `${probe.fetched} segment(s) were read and none carried a cue, so for this stream the manifest is the only carriage. That is normal where the packager generates the signalling, but it also means there is nothing to check the manifest against — a tag that is wrong is wrong unopposed.${coverage}`
          : `${probe.fetched} segment(s) were read and none carried a cue, consistent with a stream that signals no avails.${coverage}`;
      })(),
    );
    return findings;
  }

  const inbandOpens = probe.signals.filter((s) => s.section && s.outOfNetwork !== false);
  // Drift is only measurable on a break whose extent the window fully covers…
  const manifestBreaks = rendition.breaks.filter((b) => !b.windowClipped);
  // …but "did the packager transcribe this cue at all" must consider every
  // break the manifest carries, clipped or not. A break the window opened
  // inside of is still a tag that exists.
  const allManifestBreaks = rendition.breaks;

  // A manifest break with no inband signal anywhere near it.
  for (const b of manifestBreaks) {
    if (b.pdt === undefined) continue;
    const near = inbandOpens.filter((s) => s.pdt !== undefined && Math.abs(s.pdt - b.pdt!) < 10_000);
    const byId = inbandOpens.filter((s) => s.eventId !== undefined && s.eventId === b.eventId);
    if (near.length === 0 && byId.length === 0) continue; // not necessarily in a fetched segment

    const match = byId[0] ?? near[0];
    if (match.pdt !== undefined && b.pdt !== undefined) {
      const drift = (match.pdt - b.pdt) / 1000;
      if (Math.abs(drift) > 0.5) {
        add(
          "error",
          "INBAND_MANIFEST_TIME_MISMATCH",
          `The inband cue and the manifest disagree by ${Math.abs(drift).toFixed(3)}s`,
          `The manifest places this break at ${new Date(b.pdt).toISOString()}, but the SCTE-35 carried in the segments resolves to ${new Date(match.pdt).toISOString()} — ${Math.abs(drift).toFixed(3)}s ${drift > 0 ? "later" : "earlier"}. The packager transcribed the cue to a different instant than the encoder signalled. Systems that act on the manifest and systems that act on the stream will splice at different points.`,
          { breakIndex: b.index, atTime: b.startTime },
        );
      }
    }
    if (
      match.eventId !== undefined &&
      b.eventId !== undefined &&
      match.eventId !== b.eventId
    ) {
      add(
        "warning",
        "INBAND_MANIFEST_EVENT_ID_MISMATCH",
        `Event id differs between the stream (${match.eventId}) and the manifest (${b.eventId})`,
        "Ad platforms deduplicate and report on the event id. When the two carriages disagree, the same avail is counted as two different events.",
        { breakIndex: b.index, atTime: b.startTime },
      );
    }
  }

  // A cue in the stream that the manifest never mentions. This only means the
  // packager dropped something if the manifest is transcribing cues at all —
  // a stream that signals inband only was never claiming to carry them.
  const manifestTranscribes = allManifestBreaks.length > 0;
  for (const s of inbandOpens) {
    if (s.pdt === undefined) continue;
    const covered = allManifestBreaks.some(
      (b) => b.pdt !== undefined && Math.abs(b.pdt - s.pdt!) < 10_000,
    );
    const idMatch = allManifestBreaks.some((b) => b.eventId !== undefined && b.eventId === s.eventId);
    if (!covered && !idMatch) {
      add(
        manifestTranscribes ? "error" : "info",
        manifestTranscribes ? "INBAND_SIGNAL_NOT_IN_MANIFEST" : "INBAND_ONLY_SIGNALLING",
        manifestTranscribes
          ? `A cue in the stream at ${new Date(s.pdt).toISOString()} has no tag in the manifest`
          : `Avail at ${new Date(s.pdt).toISOString()} exists only in the segments`,
        manifestTranscribes
          ? `The encoder signalled an avail${s.eventId !== undefined ? ` (event ${s.eventId})` : ""} that the packager did not transcribe, while transcribing others. Players and SSAI read the manifest, so this break does not exist as far as anything downstream is concerned — the inventory is simply lost.`
          : `The manifest carries no avails at all, so this stream signals inband only and nothing has been dropped. Anything downstream that reads the manifest will still see no ad breaks, which is worth knowing before a player or an SSAI service is pointed at it.`,
      );
    }
  }

  return findings;
}


// ---------------------------------------------------------------- DASH ----

interface DashSegmentRef {
  url: string;
  /** presentation time of the segment on the MPD timeline, seconds */
  start: number;
  /** wall clock of the segment's start, where availabilityStartTime allows it */
  pdt?: number;
  period: DashPeriod;
}

/** Resolves a SegmentTemplate into fetchable segment URLs. */
export function resolveDashSegments(
  mpd: MpdDocument,
  period: DashPeriod,
  as: DashAdaptationSet,
): { init?: string; segments: DashSegmentRef[] } {
  const rep = as.representations[0];
  if (!rep || !as.mediaTemplate) return { segments: [] };

  const base = as.baseUrl ? resolveUri(mpd.uri, as.baseUrl) : mpd.uri;
  const vars = { RepresentationID: rep.id, Bandwidth: rep.bandwidth };

  const init = as.initTemplate
    ? resolveUri(base, fillTemplate(as.initTemplate, vars))
    : undefined;

  // Streams addressed by @duration have no timeline to walk, so the numbers
  // have to be derived: segment N covers presentation time N × duration, with
  // @startNumber aligned to @presentationTimeOffset. On a live stream only the
  // part of that range still inside the time-shift buffer actually exists.
  if (as.segments.length === 0 && as.segmentDuration !== undefined) {
    const segDur = as.segmentDuration / as.timescale;
    if (segDur <= 0) return { init, segments: [] };

    // @startNumber addresses the first segment of the period, and
    // @presentationTimeOffset is the media time that period start corresponds
    // to. Presentation time and media time are different frames: mixing them
    // puts every segment number out by the offset.
    const ptoSeconds = as.presentationTimeOffset / as.timescale;
    const numberAt = (presentationTime: number) =>
      as.startNumber + Math.floor((presentationTime - period.start) / segDur);

    let from: number;
    let to: number;
    if (mpd.type === "dynamic" && mpd.availabilityStartTime !== undefined) {
      const nowSeconds = (Date.now() - mpd.availabilityStartTime) / 1000;
      const edge = nowSeconds - (mpd.suggestedPresentationDelay ?? segDur * 2);
      const oldest = edge - (mpd.timeShiftBufferDepth ?? 60);
      from = Math.max(period.start, oldest);
      to = Math.min(edge, period.start + (period.mediaDuration || Infinity));
    } else {
      from = period.start;
      to = period.start + (period.mediaDuration || segDur * 20);
    }
    if (!(to > from)) return { init, segments: [] };

    const out: DashSegmentRef[] = [];
    const lastN = numberAt(to);
    for (let n = numberAt(from); n <= lastN && out.length < 2000; n++) {
      const offset = (n - as.startNumber) * segDur;
      const start = period.start + offset;
      out.push({
        url: resolveUri(
          base,
          fillTemplate(as.mediaTemplate!, {
            ...vars,
            Number: n,
            // $Time$ is media time, which is where the offset applies.
            Time: Math.round((ptoSeconds + offset) * as.timescale),
          }),
        ),
        start,
        pdt: mpd.availabilityStartTime !== undefined ? mpd.availabilityStartTime + start * 1000 : undefined,
        period,
      });
    }
    return { init, segments: out };
  }

  const segments = as.segments.map((e) => {
    const url = resolveUri(base, fillTemplate(as.mediaTemplate!, { ...vars, Number: e.number, Time: e.t }));
    const start = e.t / as.timescale;
    return {
      url,
      start,
      pdt: mpd.availabilityStartTime !== undefined ? mpd.availabilityStartTime + start * 1000 : undefined,
      period,
    };
  });

  return { init, segments };
}

/** Picks the segments worth opening: those an avail begins in, then a spread. */
function chooseDashSegments(refs: DashSegmentRef[], breaks: AdBreak[], limit: number): DashSegmentRef[] {
  if (refs.length === 0) return [];
  const picked = new Map<number, DashSegmentRef>();

  for (const b of breaks) {
    const at = refs.findIndex((r) => r.start + 0.001 >= b.startTime);
    if (at >= 0) {
      if (at > 0) picked.set(at - 1, refs[at - 1]);
      picked.set(at, refs[at]);
    }
    if (picked.size >= limit) break;
  }
  if (picked.size < limit) {
    const stride = Math.max(1, Math.floor(refs.length / Math.max(1, limit - picked.size)));
    for (let i = 0; i < refs.length && picked.size < limit; i += stride) picked.set(i, refs[i]);
  }
  return [...picked.entries()].sort((a, b) => a[0] - b[0]).slice(0, limit).map(([, r]) => r);
}

/**
 * Reads the segments of a DASH stream. Unlike HLS, where the playlist lists
 * every segment outright, the URLs have to be built from a SegmentTemplate
 * before anything can be fetched.
 */
export async function probeMpd(
  manifestText: string,
  manifestUri: string,
  rendition: RenditionAnalysis,
  options: ProbeOptions = {},
): Promise<SegmentProbe> {
  const opts = { ...DEFAULTS, ...options };
  const probe: SegmentProbe = {
    attempted: 0,
    fetched: 0,
    bytes: 0,
    format: "unknown",
    signals: [],
    findings: [],
    fetchErrors: [],
  };

  const mpd = parseMpd(manifestText, manifestUri);

  // Collect candidate segments across every period, from the video set.
  const refs: DashSegmentRef[] = [];
  let init: string | undefined;
  for (const period of mpd.periods) {
    const video =
      period.adaptationSets.find((a) => a.mimeType?.startsWith("video")) ?? period.adaptationSets[0];
    if (!video) continue;
    const resolved = resolveDashSegments(mpd, period, video);
    init ??= resolved.init;
    refs.push(...resolved.segments);
  }

  if (refs.length === 0) {
    probe.findings.push({
      severity: "info",
      code: "SEGMENTS_NOT_ADDRESSABLE",
      title: "Segment URLs could not be built from this manifest",
      detail:
        "The adaptation sets do not carry a SegmentTemplate with a media pattern and a timeline, so there is no way to address individual segments without guessing. Reading them is skipped rather than attempted blindly.",
      rendition: rendition.label,
    });
    return probe;
  }

  // A cue can sit in one segment out of thirty. Where the manifest carries no
  // avails of its own there is nothing to aim at, so sampling a spread would
  // most likely miss it — scan the window instead, within a budget.
  const manifestHasBreaks = rendition.breaks.length > 0;
  const budget = manifestHasBreaks ? opts.maxSegments : Math.max(opts.maxSegments, Math.min(refs.length, 60));
  const chosen = manifestHasBreaks
    ? chooseDashSegments(refs, rendition.breaks, budget)
    : refs.slice(-budget);
  probe.available = refs.length;
  probe.attempted = chosen.length;
  const formats = new Set<string>();

  // The init segment carries no events, but some packagers put the first emsg
  // there, and it costs one small request.
  const targets = init ? [{ url: init, pdt: undefined as number | undefined }, ...chosen] : chosen;
  probe.attempted = targets.length;

  const results = await Promise.allSettled(
    targets.map(async (t) => ({ t, buf: await fetchSegment(t.url, opts) })),
  );

  for (const r of results) {
    if (r.status === "rejected") {
      probe.fetchErrors.push(r.reason instanceof Error ? r.reason.message : String(r.reason));
      continue;
    }
    const { t, buf } = r.value;
    probe.fetched++;
    probe.bytes += buf.length;
    formats.add(looksLikeTransportStream(buf) ? "mpeg-ts" : "cmaf");
    probe.signals.push(...readSegment(buf, t.url, t.pdt));
  }

  probe.format =
    formats.size === 0 ? "unknown" : formats.size > 1 ? "mixed" : ([...formats][0] as "mpeg-ts" | "cmaf");
  probe.findings.push(...compareWithManifest(rendition, probe));
  return probe;
}
