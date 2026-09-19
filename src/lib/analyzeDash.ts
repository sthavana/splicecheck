/**
 * Multi-period DASH ad-signalling analysis.
 *
 * The failure modes here are different from HLS. In DASH an avail is a Period,
 * so the things that break are period continuity, presentation-time offsets,
 * whether the ad period presents the same Representations as the content
 * around it, and whether the SCTE-35 Events can be deduplicated across the
 * MPD refreshes a live client performs every few seconds.
 */

import {
  SCTE35_SCHEMES,
  type DashEvent,
  type DashPeriod,
  type MpdDocument,
} from "./dash";
import {
  parseSpliceInfoSection,
  START_TYPES,
  END_TYPES,
  SEGMENTATION_TYPES,
  type SegmentationDescriptor,
  type SpliceInfoSection,
} from "./scte35";
import type { AdBreak, Finding, PeriodSummary, RenditionAnalysis, Severity } from "./analyze";

/** Sub-frame differences are normal; these are the points worth reporting. */
const GAP_WARN = 0.05;
const GAP_ERROR = 0.5;
const SKEW_INFO = 0.04;
const SKEW_WARN = 0.1;
const PTO_TOLERANCE = 0.001;

function fmt(n: number | undefined, d = 3): string {
  return n === undefined ? "—" : n.toFixed(d).replace(/\.?0+$/, "");
}

function ms(n: number): string {
  return `${(n * 1000).toFixed(1)}ms`;
}

interface DecodedEvent {
  event: DashEvent;
  period: DashPeriod;
  section?: SpliceInfoSection;
  error?: string;
  descriptors: SegmentationDescriptor[];
  /** segmentation type taken from SCTE-35, or a vendor attribute if that is all there is */
  typeId?: number;
  typeName?: string;
  eventId?: number;
  durationSeconds?: number;
}

function vendorTypeId(e: DashEvent): number | undefined {
  for (const [k, v] of Object.entries(e.extraAttrs)) {
    if (!/segmentTypeId/i.test(k)) continue;
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function repSignature(p: DashPeriod): string {
  return p.adaptationSets
    .map(
      (a) =>
        `${a.mimeType ?? "?"}/${a.lang ?? "-"}:[${a.representations
          .map((r) => `${r.id}|${r.codecs ?? "?"}|${r.width ?? ""}x${r.height ?? ""}`)
          .sort()
          .join(",")}]`,
    )
    .sort()
    .join(";");
}

const CONTINUITY_SCHEMES = [
  "urn:mpeg:dash:period-continuity:2015",
  "urn:mpeg:dash:period-connectivity:2015",
];

function hasContinuitySignal(p: DashPeriod): boolean {
  const all = [...p.supplementalProperties, ...p.adaptationSets.flatMap((a) => a.supplementalProperties)];
  return all.some((s) => CONTINUITY_SCHEMES.some((c) => s.startsWith(c)));
}

export function analyzeMpd(mpd: MpdDocument, label = "MPD"): RenditionAnalysis {
  const findings: Finding[] = [];
  const add = (
    severity: Severity,
    code: string,
    title: string,
    detail: string,
    extra: Partial<Finding> = {},
  ) => findings.push({ severity, code, title, detail, rendition: label, ...extra });

  const periods = mpd.periods;
  const live = mpd.type === "dynamic";

  // ---- manifest-level checks --------------------------------------------
  if (live && mpd.minimumUpdatePeriod === undefined) {
    add(
      "error",
      "DYNAMIC_NO_MUP",
      "Dynamic MPD has no @minimumUpdatePeriod",
      "A live MPD without @minimumUpdatePeriod tells clients never to refresh it, so they will never see a Period that is added for an ad break. Every avail after the first load is missed.",
    );
  }
  if (live && mpd.availabilityStartTime === undefined) {
    add(
      "error",
      "DYNAMIC_NO_AST",
      "Dynamic MPD has no @availabilityStartTime",
      "Without @availabilityStartTime a client cannot map the presentation timeline to wall clock, so it cannot determine which segments are currently available or where the live edge is.",
    );
  }
  if (periods.length === 0) {
    add("error", "NO_PERIODS", "MPD contains no Periods", "There is nothing to analyse.");
  }

  // ---- low latency --------------------------------------------------------
  // Where LL-HLS states its contract in EXT-X-SERVER-CONTROL, DASH splits it
  // between ServiceDescription/Latency and the availability attributes on the
  // SegmentTemplate. The two have to agree, and a target that the segmentation
  // cannot deliver is the usual reason a "low latency" stream is not one.
  if (mpd.chunked || mpd.latency) {
    const target = mpd.latency?.targetMs !== undefined ? mpd.latency.targetMs / 1000 : undefined;

    // The longest segment in play, in seconds.
    let segSec = 0;
    for (const p of periods) {
      for (const a of p.adaptationSets) {
        const ts = a.timescale || 1;
        const d = a.segmentDuration !== undefined ? a.segmentDuration / ts : a.segments[0] ? a.segments[0].d / ts : undefined;
        if (d) segSec = Math.max(segSec, d);
      }
    }

    if (mpd.chunked && target === undefined) {
      add(
        "warning",
        "LL_DASH_NO_LATENCY_TARGET",
        "Segments are published before they are complete, but no latency target is declared",
        "availabilityTimeComplete=\"false\" tells clients they may fetch a segment while it is still being written, which is how DASH delivers low latency. Without a ServiceDescription/Latency target, nothing tells them how close to live to sit — so each player vendor picks its own, and the same stream runs at two seconds on one device and eight on another.",
      );
    }

    // A target shorter than a segment is only reachable if the segment can be
    // consumed while it is being written.
    if (target !== undefined && segSec > 0 && target < segSec && !mpd.chunked) {
      add(
        "error",
        "LL_DASH_TARGET_UNREACHABLE",
        `A ${fmt(target)}s latency target is declared with ${fmt(segSec)}s segments and no chunked delivery`,
        `A client cannot be less than one segment behind live unless it can start consuming a segment before that segment is finished. With availabilityTimeComplete unset, the earliest a ${fmt(segSec)}s segment can be fetched is after it has been written — so the floor is ${fmt(segSec)}s, above the ${fmt(target)}s being asked for. Players either sit further back than the manifest says, or chase the edge and rebuffer.`,
      );
    }

    if (target !== undefined && mpd.suggestedPresentationDelay !== undefined) {
      const spd = mpd.suggestedPresentationDelay;
      if (Math.abs(spd - target) > 1) {
        add(
          "warning",
          "LL_DASH_DELAY_DISAGREEMENT",
          `@suggestedPresentationDelay is ${fmt(spd)}s but the latency target is ${fmt(target)}s`,
          "The manifest states two different live points. Players that honour ServiceDescription sit at one, players that honour suggestedPresentationDelay sit at the other, and the two are watching the same moment several seconds apart. For ad insertion that means a cue reaches them at different times, and any decision made against wall clock is right for one group and late for the other.",
        );
      }
    }

    // Publishing early is only coherent if the segment is incomplete.
    for (const p of periods) {
      for (const a of p.adaptationSets) {
        const ts = a.timescale || 1;
        const d = a.segmentDuration !== undefined ? a.segmentDuration / ts : a.segments[0] ? a.segments[0].d / ts : undefined;
        const ato = a.availabilityTimeOffset;
        if (ato !== undefined && ato > 0 && a.availabilityTimeComplete !== false && d && ato > d / 2) {
          add(
            "warning",
            "LL_DASH_EARLY_AVAILABILITY_WITHOUT_CHUNKING",
            `Period ${p.id ?? p.index} offers segments ${fmt(ato)}s early but does not mark them incomplete`,
            `availabilityTimeOffset=${fmt(ato)} says a ${fmt(d)}s segment may be fetched well before its nominal availability, while availabilityTimeComplete is left at its default of true — which claims the whole segment already exists. A client taking the manifest at its word requests a segment that is still being written and gets a truncated response or a 404. Chunked delivery needs availabilityTimeComplete="false" as well as the offset.`,
            { atTime: p.start },
          );
        }
      }
    }

    if (target !== undefined && periods.some((p) => p.events.length > 0)) {
      add(
        "info",
        "LL_AD_DECISION_BUDGET",
        `An ad decision here has about ${fmt(target)}s to complete`,
        `Players are told to sit ${fmt(target)}s behind the live edge. That is the whole budget for an ad decision that is triggered by a cue arriving at the splice point: call out, run the auction, pick the pod, have the creatives ready. Lead time is what decides whether a low-latency stream can carry advertising, and it appears in no tag — it is the gap between the cue reaching the manifest and the splice happening.`,
      );
    }
  }

  const ids = new Map<string, number>();
  for (const p of periods) {
    if (p.id === undefined) {
      add(
        "warning",
        "PERIOD_MISSING_ID",
        `Period at ${fmt(p.start)}s has no @id`,
        "Period@id is what lets a client recognise the same Period across MPD refreshes. Without it, a live client reloading the manifest every few seconds cannot tell an existing Period from a new one, and may re-initialise its pipeline at every refresh.",
      );
      continue;
    }
    ids.set(p.id, (ids.get(p.id) ?? 0) + 1);
  }
  for (const [id, n] of ids) {
    if (n > 1) {
      add(
        "error",
        "DUPLICATE_PERIOD_ID",
        `Period @id "${id}" appears ${n} times`,
        "Period@id must be unique within an MPD. Clients key their period state on it, so duplicates cause one Period's timeline to be applied to another — which typically shows as the ad playing at the wrong point or not at all.",
      );
    }
  }

  // ---- period timeline continuity ---------------------------------------
  const summaries: PeriodSummary[] = [];

  periods.forEach((p, i) => {
    const next = periods[i + 1];
    const mediaEnd = p.mediaStart + p.mediaDuration;
    const gap = next ? next.start - mediaEnd : undefined;

    // A/V spread inside the period.
    const withMedia = p.adaptationSets.filter((a) => a.segmentCount > 0);
    const ref = withMedia.find((a) => a.mimeType?.startsWith("video")) ?? withMedia[0];
    const skew = ref
      ? Math.max(0, ...withMedia.map((a) => Math.abs(a.mediaDuration - ref.mediaDuration)))
      : 0;

    // An unresolved remote Period has no media and, without a declared
    // duration, no known extent — so the space after it is not a gap in the
    // timeline, it is the hole the ad is going to fill. XLINK_NO_DURATION
    // already reports the thing that is actually wrong.
    const extentUnknowable = p.isPlaceholder && p.declaredDuration === undefined;
    if (gap !== undefined && Math.abs(gap) > GAP_WARN && !extentUnknowable) {
      const overlap = gap < 0;
      add(
        Math.abs(gap) > GAP_ERROR ? "error" : "warning",
        overlap ? "PERIOD_TIMELINE_OVERLAP" : "PERIOD_TIMELINE_GAP",
        `Period ${p.id ?? p.index} ${overlap ? "overlaps" : "leaves a gap before"} Period ${next.id ?? next.index} by ${ms(Math.abs(gap))}`,
        overlap
          ? `This Period's media runs to ${fmt(mediaEnd, 4)}s but the next Period starts at ${fmt(next.start, 4)}s. Overlapping periods mean the same presentation time is covered twice; players either play the overlap twice or drop it, and at an ad boundary that is a visible stutter or a repeated frame.`
          : `This Period's media ends at ${fmt(mediaEnd, 4)}s and the next starts at ${fmt(next.start, 4)}s, leaving ${ms(gap)} with no media. Players stall, freeze on the last frame, or skip — and at an ad boundary it looks like the ad was cut short.`,
        { atTime: p.start },
      );
    }

    // Media starting later than the Period declares.
    const trim = p.mediaStart - p.start;
    if (trim > GAP_WARN) {
      // When the offset exceeds the time-shift buffer it is not a trim at all:
      // the manifest anchors its timeline at availabilityStartTime (commonly
      // the epoch) and the number is just how long the channel has been up.
      const anchoredTimeline = i === 0 && live && trim > (mpd.timeShiftBufferDepth ?? 3600);
      if (anchoredTimeline) {
        // nothing to report
      } else if (i === 0 && live) {
        // On a long-running channel this offset is the whole age of the
        // stream, so quote it in sensible units rather than as a nine-digit
        // millisecond count.
        const human =
          trim >= 86400
            ? `${(trim / 86400).toFixed(1)} days`
            : trim >= 3600
              ? `${(trim / 3600).toFixed(1)} hours`
              : trim >= 60
                ? `${(trim / 60).toFixed(1)} minutes`
                : ms(trim);
        add(
          "info",
          "PERIOD_TRIMMED_AT_WINDOW",
          `Media in the oldest Period begins ${human} after its declared @start`,
          `Period@start still refers to where the Period originally began, while everything before the ${fmt(mpd.timeShiftBufferDepth)}s time-shift buffer has aged out. On a channel that has been running a long time this offset is simply its age. Normal for a sliding live window, not a fault.`,
          { atTime: p.start },
        );
      } else {
        add(
          "warning",
          "PERIOD_MEDIA_STARTS_LATE",
          `Period ${p.id ?? p.index} has no media for its first ${ms(trim)}`,
          `Period@start is ${fmt(p.start, 4)}s but the first segment is at ${fmt(p.mediaStart, 4)}s. The declared start of the Period has no media behind it, so a client seeking or joining there gets nothing.`,
          { atTime: p.start },
        );
      }
    }

    // presentationTimeOffset must anchor the Period.
    for (const a of p.adaptationSets) {
      if (a.segmentCount === 0) continue;
      const pto = a.presentationTimeOffset / a.timescale;
      if (Math.abs(pto - p.start) > PTO_TOLERANCE) {
        add(
          "error",
          "PTO_MISMATCH",
          `Period ${p.id ?? p.index} ${a.mimeType ?? "set"} @presentationTimeOffset does not match @start`,
          `@presentationTimeOffset resolves to ${fmt(pto, 4)}s but Period@start is ${fmt(p.start, 4)}s, a ${ms(Math.abs(pto - p.start))} difference. The offset is what maps media timestamps onto the presentation timeline; when it disagrees with the Period start, this Period's media is rendered at the wrong time — and across an ad boundary that means audio and video from different periods land on top of each other.`,
          { atTime: p.start },
        );
      }
    }

    // The newest period on a live manifest is still being written: audio and
    // video segments are published independently, so their timelines routinely
    // differ by a segment or more until the period is complete.
    const atLiveEdge = live && i === periods.length - 1;
    if (skew > SKEW_INFO && !atLiveEdge) {
      add(
        skew > SKEW_WARN ? "warning" : "info",
        "AV_DURATION_SKEW",
        `Period ${p.id ?? p.index} adaptation sets differ in length by ${ms(skew)}`,
        `Within this Period the ${ref?.mimeType ?? "reference"} timeline and the other adaptation sets do not cover the same span (${withMedia
          .map((a) => `${a.mimeType?.split("/")[0]}${a.lang ? "/" + a.lang : ""} ${fmt(a.mediaDuration, 3)}s`)
          .join(", ")}). Small differences are normal because audio frames do not divide evenly into video frames, but the error accumulates at every period boundary and shows up as lip-sync drift through an ad pod.`,
        { atTime: p.start },
      );
    }

    // --- remote Periods ---------------------------------------------------
    // A Period with xlink:href is a placeholder: the packager has left a hole
    // and named a service that fills it at playback time. This is how DASH does
    // server-side ad insertion in multi-period, and it moves the decision out
    // of the manifest and into a request nobody here can see the result of.
    if (p.xlinkHref) {
      const actuate = p.xlinkActuate ?? "onRequest";

      add(
        "info",
        "XLINK_REMOTE_PERIOD",
        `Period ${p.id ?? p.index} is filled by a remote service (${actuate})`,
        `This Period carries no content of its own — ${
          p.isPlaceholder ? "it has no AdaptationSets at all" : "its content arrived from the remote document"
        } — and names ${p.xlinkHref} as the source. Whether this avail plays at all depends on a service outside this manifest answering in time. Everything else here can be checked from the text; this cannot.`,
        { atTime: p.start },
      );

      // Without @duration a client cannot lay out the timeline past the
      // placeholder, so it cannot compute the live edge or seek across it until
      // the resolution has happened.
      if (p.declaredDuration === undefined && p.isPlaceholder) {
        add(
          live ? "error" : "warning",
          "XLINK_NO_DURATION",
          `Remote Period ${p.id ?? p.index} declares no @duration`,
          `The Period is a placeholder with no duration, so nothing downstream knows how long the avail is until the remote document has been fetched and parsed. On a live manifest a client cannot place the live edge past it, and an ad decision service cannot be told how much inventory to fill. Declaring the expected duration costs nothing and lets the timeline be laid out before the ad is chosen.`,
          { atTime: p.start },
        );
      }

      // actuate defaults to onRequest, but implementations have disagreed about
      // it for long enough that leaving it out is a real portability risk.
      if (p.xlinkActuate === undefined) {
        add(
          "warning",
          "XLINK_NO_ACTUATE",
          `Remote Period ${p.id ?? p.index} does not state @xlink:actuate`,
          "Without an explicit actuate the resolution time is left to the client: some resolve when the manifest is parsed, others only when playback reaches the Period. That is the difference between the ad request going out minutes early and going out at the splice point, which changes both the fill rate and whether the player stalls at the boundary.",
          { atTime: p.start },
        );
      }

      // onLoad on a live manifest means every refresh re-resolves, which at a
      // few seconds per refresh is a request rate nobody intends.
      if (actuate === "onLoad" && live && mpd.minimumUpdatePeriod !== undefined) {
        add(
          "warning",
          "XLINK_ONLOAD_ON_LIVE",
          `Remote Period ${p.id ?? p.index} resolves on load of a manifest refreshed every ${fmt(mpd.minimumUpdatePeriod)}s`,
          `xlink:actuate="onLoad" tells a client to resolve the remote Period every time it parses the manifest. This MPD is refreshed every ${fmt(mpd.minimumUpdatePeriod)}s, so each viewer re-requests the ad decision at that rate for as long as the Period stays in the window — and may get a different answer each time, which changes the timeline underneath a player that is already buffering. onRequest defers the resolution to the point of use.`,
          { atTime: p.start },
        );
      }
    }

    // Only claim a period is empty when there was a timeline to be empty.
    // A remote Period has no media by design until it is resolved, so it is not
    // the same failure as a packager producing an ad Period with nothing in it.
    const numberAddressed = p.adaptationSets.some((a) => !a.usesTimeline && a.segmentDuration !== undefined);
    if (p.mediaDuration === 0 && !numberAddressed && !p.isPlaceholder) {
      add(
        "warning",
        "EMPTY_PERIOD",
        `Period ${p.id ?? p.index} contains no media`,
        "This Period declares adaptation sets but its segment timelines are empty, so there is nothing to play for its whole extent. An empty ad Period is what a failed ad decision looks like in the manifest: the avail was opened but never filled.",
        { atTime: p.start },
      );
    }

    summaries.push({
      id: p.id,
      index: p.index,
      start: p.start,
      mediaStart: p.mediaStart,
      duration: p.mediaDuration,
      isAd: false,
      eventCount: p.events.length,
      adaptationSetCount: p.adaptationSets.length,
      representationCount: p.adaptationSets.reduce((a, s) => a + s.representations.length, 0),
      avSkew: skew,
      gapToNext: gap,
    });
  });

  // ---- structural consistency between adjacent periods -------------------
  let continuityOpportunities = 0;
  for (let i = 1; i < periods.length; i++) {
    const prev = periods[i - 1];
    const cur = periods[i];
    // A remote Period that has not been resolved presents no Representations
    // yet. Comparing against it would report every placeholder as a codec
    // change and every boundary beside one as missing continuity — faults that
    // belong to the resolved document, which is not in front of us.
    if (prev.isPlaceholder || cur.isPlaceholder) continue;
    const same = repSignature(prev) === repSignature(cur);
    if (!same) {
      const prevReps = prev.adaptationSets.flatMap((a) => a.representations.map((r) => `${r.codecs ?? "?"} ${r.width ?? ""}x${r.height ?? ""}`));
      const curReps = cur.adaptationSets.flatMap((a) => a.representations.map((r) => `${r.codecs ?? "?"} ${r.width ?? ""}x${r.height ?? ""}`));
      add(
        "error",
        "REPRESENTATION_SET_CHANGED",
        `Period ${cur.id ?? cur.index} presents different Representations than Period ${prev.id ?? prev.index}`,
        `The adaptation sets change across this boundary (${prevReps.length} representations → ${curReps.length}). A client must tear down and re-initialise its decoders, which at an ad boundary is the classic black frame or audio drop-out on the way into and out of the break. Ad periods should present the same adaptation sets, codecs and resolutions as the content around them.`,
        { atTime: cur.start },
      );
    } else if (!hasContinuitySignal(cur)) {
      continuityOpportunities++;
    }
  }
  if (continuityOpportunities > 0) {
    add(
      "warning",
      "NO_PERIOD_CONTINUITY_SIGNAL",
      `${continuityOpportunities} period boundaries could declare continuity but do not`,
      `Adjacent Periods present identical Representation ids, codecs and resolutions, so the stream really is continuous across these boundaries — but nothing says so. Adding SupplementalProperty schemeIdUri="urn:mpeg:dash:period-continuity:2015" lets players carry their buffer and decoder across the boundary instead of re-initialising. Without it, many players re-initialise at every ad transition, which is a visible glitch the encoder is not actually causing.`,
    );
  }

  // A stream that declares SCTE-35 inband is telling you the manifest is not
  // the whole story.
  const inbandSchemes = [
    ...new Set(
      periods.flatMap((p) => p.adaptationSets.flatMap((a) => a.inbandEventSchemes)).filter((x) => /scte35/i.test(x)),
    ),
  ];
  if (inbandSchemes.length) {
    const hasManifestBreaks = periods.some((p) => p.events.length > 0);
    add(
      "info",
      "INBAND_EVENT_STREAM_DECLARED",
      `SCTE-35 is declared inband (${inbandSchemes.join(", ")})`,
      hasManifestBreaks
        ? "The manifest carries avails and also declares that the segments carry them, so the two should agree. Reading the segments is the only way to know whether they do."
        : "The manifest declares that SCTE-35 arrives inside the segments and carries no avails of its own, so a manifest-only view of this stream will always report no ad signalling. The cues are there — they are in the media.",
    );
  }

  if (periods.length > 1 && periods.every((p) => !p.assetIdentifier)) {
    add(
      "info",
      "NO_ASSET_IDENTIFIER",
      "No Period carries an AssetIdentifier",
      "Nothing in the MPD distinguishes an ad Period from a content Period other than the SCTE-35 itself. AssetIdentifier is how DASH-IF expects downstream systems to group periods belonging to one asset, and reporting and blackout logic commonly rely on it.",
    );
  }

  // ---- SCTE-35 events ----------------------------------------------------
  const decoded: DecodedEvent[] = [];
  const missingIdSchemes = new Set<string>();
  const ambiguousTimeSchemes = new Set<string>();

  for (const p of periods) {
    const byScheme = new Map<string, DashEvent[]>();
    for (const e of p.events) {
      byScheme.set(e.schemeIdUri, [...(byScheme.get(e.schemeIdUri) ?? []), e]);
    }
    for (const [scheme, evs] of byScheme) {
      if (live && evs.some((e) => e.id === undefined)) missingIdSchemes.add(scheme);
      if (evs.length > 1 && evs.filter((e) => !e.presentationTimeExplicit).length > 1) {
        ambiguousTimeSchemes.add(scheme);
      }
    }

    for (const e of p.events) {
      const isScte = SCTE35_SCHEMES.some((s) => e.schemeIdUri.startsWith(s)) || !!e.payload;
      if (!isScte) continue;
      const d: DecodedEvent = { event: e, period: p, descriptors: [] };
      if (e.payload) {
        try {
          const section = parseSpliceInfoSection(e.payload);
          d.section = section;
          d.descriptors = section.descriptors.filter(
            (x): x is SegmentationDescriptor => x.tag === 0x02 && "typeId" in x,
          );
          const start = d.descriptors.find((x) => START_TYPES.has(x.typeId));
          const end = d.descriptors.find((x) => END_TYPES.has(x.typeId));
          const chosen = start ?? end ?? d.descriptors[0];
          if (chosen) {
            d.typeId = chosen.typeId;
            d.typeName = chosen.typeName;
            d.eventId = chosen.segmentationEventId;
            d.durationSeconds = chosen.segmentationDurationSeconds;
          } else if (section.spliceInsert && !section.spliceInsert.cancel) {
            d.eventId = section.spliceInsert.spliceEventId;
            d.durationSeconds = section.spliceInsert.breakDuration?.seconds;
            d.typeId = section.spliceInsert.outOfNetwork ? 0x30 : 0x31;
            d.typeName = section.spliceInsert.outOfNetwork
              ? "splice_insert out of network"
              : "splice_insert return";
          }
          if (!section.crcValid) {
            add(
              "warning",
              "SCTE35_CRC_INVALID",
              `SCTE-35 CRC-32 does not validate in Period ${p.id ?? p.index}`,
              `The section decodes but its CRC-32 is wrong (0x${section.crc32.toString(16)}). Strict ad servers and conformance checkers reject sections with a bad CRC, so this break may be silently ignored even though the manifest looks correct.`,
              { atTime: p.start },
            );
          }
        } catch (err) {
          d.error = err instanceof Error ? err.message : String(err);
          add(
            "error",
            "SCTE35_DECODE_FAILED",
            `SCTE-35 payload could not be decoded in Period ${p.id ?? p.index}`,
            `The Signal/Binary element does not parse as a splice_info_section: ${d.error}. Downstream ad decisioning drops this signal entirely.`,
            { atTime: p.start },
          );
        }
      }
      if (d.typeId === undefined) {
        const vt = vendorTypeId(e);
        if (vt !== undefined) {
          d.typeId = vt;
          d.typeName = SEGMENTATION_TYPES[vt] ?? `Reserved (0x${vt.toString(16)})`;
        }
      }
      decoded.push(d);
    }
  }

  // The same SCTE-35 is frequently published in more than one EventStream —
  // a standard scheme plus a vendor one. That is one signal, not two.
  const schemeRank = (u: string) => (u.startsWith("urn:scte:scte35") ? 0 : 1);
  const uniqueByKey = new Map<string, DecodedEvent>();
  for (const d of decoded) {
    const key = `${d.period.index}|${d.typeId ?? "?"}|${d.eventId ?? "?"}|${d.event.presentationTime}|${d.event.payload ?? ""}`;
    const prev = uniqueByKey.get(key);
    if (!prev || schemeRank(d.event.schemeIdUri) < schemeRank(prev.event.schemeIdUri)) {
      uniqueByKey.set(key, d);
    }
  }
  const unique = [...uniqueByKey.values()];
  if (unique.length < decoded.length) {
    const schemes = [...new Set(decoded.map((d) => d.event.schemeIdUri))];
    add(
      "info",
      "DUPLICATE_EVENT_STREAMS",
      "The same SCTE-35 is carried in more than one EventStream",
      `${decoded.length} events resolve to ${unique.length} distinct signals across ${schemes.join(" and ")}. Publishing both a standard and a vendor scheme is normal and widens compatibility — it is noted so the break count is not misread, and because a consumer that reads both must deduplicate them or it will call the ad decision server twice per avail.`,
    );
  }

  for (const scheme of missingIdSchemes) {
    add(
      "warning",
      "EVENT_MISSING_ID",
      `Events in ${scheme} have no @id`,
      `This is a dynamic MPD refreshed every ${fmt(mpd.minimumUpdatePeriod)}s, so the same Event is delivered again on every reload for as long as its Period stays in the ${fmt(mpd.timeShiftBufferDepth)}s time-shift window. Event@id is what lets a client recognise an event it has already acted on; without it, a client either fires the same ad break repeatedly or has to invent its own deduplication.`,
    );
  }
  for (const scheme of ambiguousTimeSchemes) {
    add(
      "warning",
      "EVENT_AMBIGUOUS_TIME",
      `Multiple events in ${scheme} share an implied presentation time`,
      "More than one Event in the same EventStream omits @presentationTime, so they all default to the start of the Period. When a Period carries both the start and the end of an avail, they land on the same instant and their ordering becomes undefined.",
    );
  }

  // ---- reconstruct breaks -------------------------------------------------
  const breaks: AdBreak[] = [];
  const starts = unique.filter((d) => d.typeId !== undefined && START_TYPES.has(d.typeId));
  const ends = unique.filter((d) => d.typeId !== undefined && END_TYPES.has(d.typeId));
  const usedEnds = new Set<DecodedEvent>();

  starts
    .sort((a, b) => a.period.start - b.period.start)
    .forEach((s, index) => {
      // The matching end carries the same segmentation_event_id; failing that,
      // take the next end event after this start.
      let end =
        s.eventId !== undefined
          ? ends.find((e) => !usedEnds.has(e) && e.eventId === s.eventId && e.period.start >= s.period.start)
          : undefined;
      if (!end) {
        end = ends.find((e) => !usedEnds.has(e) && e.period.start > s.period.start);
      }
      if (end) usedEnds.add(end);

      const startTime = s.period.start + s.event.presentationTime;
      // An avail can be bounded two ways: by a matching end event, or by a
      // declared duration. splice_insert with auto_return, and an Event with
      // @duration, both state the extent outright — no end signal is coming,
      // and treating those as unclosed reports every well-formed avail as a
      // fault.
      const declared = s.durationSeconds ?? s.event.duration;
      const autoReturn = s.section?.spliceInsert?.breakDuration?.autoReturn === true;
      const boundedByDuration = !end && declared !== undefined;
      const actual = end
        ? end.period.start + end.event.presentationTime - startTime
        : boundedByDuration
          ? declared
          : undefined;
      const isLast = s.period.index === periods.length - 1;

      const b: AdBreak = {
        index,
        periodId: s.period.id,
        startTime,
        pdt:
          mpd.availabilityStartTime !== undefined
            ? mpd.availabilityStartTime + startTime * 1000
            : undefined,
        signalledDuration: s.durationSeconds ?? s.event.duration,
        signalledDurationSource: s.durationSeconds
          ? "SCTE-35 segmentation_duration"
          : s.event.duration
            ? "Event@duration"
            : undefined,
        actualDuration: actual,
        segmentCount: s.period.adaptationSets.find((a) => a.mimeType?.startsWith("video"))?.segmentCount ?? 0,
        mediaUris: s.period.adaptationSets
          .map((a) => a.mediaTemplate)
          .filter((m): m is string => !!m),
        closed: !!end || boundedByDuration,
        boundedBy: end ? "end event" : boundedByDuration ? (autoReturn ? "auto_return duration" : "declared duration") : undefined,
        inProgress: !end && !boundedByDuration && live && isLast,
        outLine: 0,
        outTag: `Period ${s.period.id ?? s.period.index} — ${s.event.schemeIdUri}`,
        discontinuityAtStart: true, // a period boundary is inherently a discontinuity
        discontinuityAtEnd: !!end,
        signal: s.section
          ? { payload: s.event.payload ?? "", source: s.event.schemeIdUri, ok: true, section: s.section }
          : s.error
            ? { payload: s.event.payload ?? "", source: s.event.schemeIdUri, ok: false, error: s.error }
            : undefined,
        eventId: s.eventId,
        upid: s.descriptors[0] ? s.descriptors[0].upidText || s.descriptors[0].upidHex : undefined,
        upidType: s.descriptors[0]?.upidTypeName,
        segmentationTypeId: s.typeId,
        segmentationType: s.typeName,
      };
      breaks.push(b);

      const sm = summaries.find((x) => x.index === s.period.index);
      if (sm) {
        sm.isAd = true;
        sm.segmentationType = s.typeName;
      }

      if (!end && !boundedByDuration) {
        if (b.inProgress) {
          add(
            "info",
            "BREAK_IN_PROGRESS",
            `Break ${index} is still open at the live edge`,
            `Period ${s.period.id ?? s.period.index} opens an avail (${s.typeName}) and no matching end event has appeared yet. On a live stream this is expected while the break is on air.`,
            { breakIndex: index, atTime: startTime },
          );
        } else {
          add(
            "error",
            "UNCLOSED_BREAK",
            `Break ${index} is never closed`,
            `Period ${s.period.id ?? s.period.index} opens an avail with ${s.typeName} (event ${s.eventId ?? "?"}) but no matching end descriptor appears in any later Period. Systems that track avails by segmentation event will hold this one open indefinitely.`,
            { breakIndex: index, atTime: startTime },
          );
        }
      } else if (boundedByDuration && live && declared !== undefined) {
        // An avail bounded by a declared duration is correctly closed — no end
        // event is coming, and the return is implied by the duration. What is
        // not correct is the presentation never leaving the ad: if the Period
        // that exists for this avail is still the Period in play well past the
        // point the avail said it would end, nothing returned to programme.
        //
        // Two guards keep this off healthy manifests. It only applies where the
        // avail owns its Period — an Event sitting mid-Period on a
        // single-Period stream describes a break without splitting the
        // timeline, and programme continuing past it is exactly right. And it
        // measures at the declared end plus a margin, because a Period is
        // expected to still be in play right up to its own end.
        const ownsItsPeriod = periods.length > 1 && s.event.presentationTime <= GAP_ERROR;
        const margin = Math.max(GAP_ERROR, (mpd.minimumUpdatePeriod ?? 6) * 2);
        const past = startTime + declared + margin;
        const periodAt = periods.find(
          (pd) => past >= pd.start && past < pd.start + (pd.declaredDuration ?? pd.mediaDuration),
        );

        if (ownsItsPeriod && periodAt && periodAt.index === s.period.index) {
          const elapsed =
            s.period.start + (s.period.declaredDuration ?? s.period.mediaDuration) - startTime;
          add(
            "error",
            "BREAK_OVERRUN_UNCLOSED",
            `Break ${index} has run ${fmt(elapsed - declared)}s past the ${fmt(declared)}s it signalled and is still on air`,
            `Period ${s.period.id ?? s.period.index} exists for this avail and declares ${fmt(declared)}s (${b.signalledDurationSource ?? "declared duration"}), but it is still the Period in play ${fmt(elapsed - declared)}s after that. No later Period picks the programme back up and no end event closes the avail. Ad content is being published over programme, and clients that honoured the declared duration have already returned while the manifest has not brought them back.${
              autoReturn ? " The SCTE-35 sets auto_return, so systems acting on the stream returned on their own — which is what makes this divergence hard to see from any one place." : ""
            }`,
            { breakIndex: index, atTime: startTime },
          );
        }
      } else if (end && b.signalledDuration !== undefined && actual !== undefined) {
        const delta = actual - b.signalledDuration;
        if (Math.abs(delta) > GAP_WARN) {
          add(
            Math.abs(delta) > GAP_ERROR ? "warning" : "info",
            delta > 0 ? "BREAK_OVERRUN" : "BREAK_UNDERRUN",
            `Break ${index} ${delta > 0 ? "overruns" : "underruns"} its signalled duration by ${ms(Math.abs(delta))}`,
            `The SCTE-35 signals ${fmt(b.signalledDuration)}s but the periods between the start and end events span ${fmt(actual)}s. ${
              delta > 0
                ? "The avail is longer than advertised, so the ad decision server under-fills it and the tail is slate or black."
                : "The avail is shorter than advertised, so the last creative in the pod is truncated."
            }`,
            { breakIndex: index, atTime: startTime },
          );
        }
      }
    });

  for (const e of ends) {
    if (usedEnds.has(e)) continue;
    // An end whose start has already rolled out of the window is expected.
    const isOldest = e.period.index === 0;
    if (!isOldest) {
      add(
        "warning",
        "ORPHAN_BREAK_END",
        `Break end in Period ${e.period.id ?? e.period.index} has no matching start`,
        `${e.typeName} (event ${e.eventId ?? "?"}) closes an avail that was never opened in this manifest. On live this is normal only when the opening Period has aged out of the time-shift window.`,
        { atTime: e.period.start },
      );
    }
  }

  // MUP must be short enough to discover the shortest avail.
  const adDurations = breaks.map((b) => b.actualDuration).filter((d): d is number => d !== undefined);
  if (live && mpd.minimumUpdatePeriod !== undefined && adDurations.length) {
    const shortest = Math.min(...adDurations);
    if (mpd.minimumUpdatePeriod > shortest) {
      add(
        "warning",
        "MUP_LONGER_THAN_SHORTEST_BREAK",
        `@minimumUpdatePeriod (${fmt(mpd.minimumUpdatePeriod)}s) exceeds the shortest avail (${fmt(shortest)}s)`,
        "A client only reloads the MPD every @minimumUpdatePeriod, so an avail shorter than that interval can begin and end between two refreshes and never be seen at all.",
      );
    }
  }

  // Measure from where media actually exists, not from the oldest Period's
  // declared @start — on live that Period has usually been trimmed, and some
  // packagers leave @start at PT0S while the segment timeline is anchored to
  // availabilityStartTime. Both ends must come from the media, or the two
  // reference frames get subtracted from each other.
  const mediaEnds = periods.map((p) => p.mediaStart + p.mediaDuration);
  const mediaStarts = periods.map((p) => p.mediaStart);
  let windowDuration = periods.length ? Math.max(...mediaEnds) - Math.min(...mediaStarts) : 0;
  // A number-addressed live stream has no timeline to measure, so the window
  // it actually offers is the time-shift buffer.
  if (windowDuration <= 0 && live && mpd.timeShiftBufferDepth) {
    windowDuration = mpd.timeShiftBufferDepth;
  }
  const adSeconds = adDurations.reduce((a, b) => a + b, 0);

  const adPeriodIndexes = new Set(summaries.filter((x) => x.isAd).map((x) => x.index));
  return {
    label,
    uri: mpd.uri,
    protocol: "dash",
    contentMediaUris: periods
      .filter((p) => !adPeriodIndexes.has(p.index))
      .flatMap((p) => p.adaptationSets.map((a) => a.mediaTemplate))
      .filter((m): m is string => !!m),
    periods: summaries,
    breaks,
    findings,
    stats: {
      segmentCount: periods.reduce(
        (a, p) => a + (p.adaptationSets.find((x) => x.mimeType?.startsWith("video"))?.segmentCount ?? 0),
        0,
      ),
      windowDuration,
      markerCount: unique.length,
      breakCount: breaks.length,
      adSeconds,
      adPercent: windowDuration > 0 ? (adSeconds / windowDuration) * 100 : 0,
      hasPdt: mpd.availabilityStartTime !== undefined,
      windowStartPdt:
        mpd.availabilityStartTime !== undefined && periods.length
          ? mpd.availabilityStartTime + periods[0].mediaStart * 1000
          : undefined,
      windowEndPdt:
        mpd.availabilityStartTime !== undefined && periods.length
          ? mpd.availabilityStartTime +
            (periods[periods.length - 1].start + periods[periods.length - 1].mediaDuration) * 1000
          : undefined,
      live,
      lowLatency: (mpd.suggestedPresentationDelay ?? 99) < 5,
    },
  };
}
