/**
 * VAST: the ad response, and whether it can actually be stitched.
 *
 * SCTE-35 says an avail exists. VAST says what goes in it. Everything else in
 * this project checks the first; this checks the second, because an avail that
 * is signalled perfectly and filled with a creative the packager cannot use is
 * still an unfilled avail — and from the manifest it looks like a fault in the
 * signalling.
 *
 * The checks lean on what server-side insertion can and cannot do. A browser
 * can run VPAID and negotiate a media file at playback time; a stitcher has to
 * pick a rendition up front, splice it into an existing ladder, and has no
 * JavaScript engine at all.
 */

import { XMLParser } from "fast-xml-parser";
import type { Finding, Severity } from "./analyze";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  removeNSPrefix: true,
  parseAttributeValue: false,
  trimValues: true,
  isArray: (name) =>
    ["Ad", "Creative", "MediaFile", "Tracking", "Impression", "Error", "Extension", "AdBreak", "Verification"].includes(name),
});

export interface VastMediaFile {
  url: string;
  type?: string;
  width?: number;
  height?: number;
  bitrate?: number;
  minBitrate?: number;
  maxBitrate?: number;
  delivery?: string;
  codec?: string;
  /** VPAID, OMID, or another executable framework. */
  apiFramework?: string;
}

export interface VastCreative {
  id?: string;
  sequence?: number;
  /** Seconds, from Linear/Duration. */
  durationSec?: number;
  skipOffsetSec?: number;
  mediaFiles: VastMediaFile[];
  trackingEvents: string[];
  universalAdId?: string;
  universalAdIdRegistry?: string;
  clickThrough?: string;
  /** Set when the creative is a non-linear or companion rather than a Linear. */
  kind: "linear" | "nonlinear" | "companion";
}

export interface VastAd {
  id?: string;
  sequence?: number;
  /** A wrapper defers to another VAST document. */
  wrapper: boolean;
  /** Where a wrapper points. */
  adTagUri?: string;
  adSystem?: string;
  adTitle?: string;
  creatives: VastCreative[];
  impressions: string[];
  errors: string[];
  /** Wrapper-only: whether it permits multiple ads from the wrapped response. */
  allowMultipleAds?: boolean;
  followAdditionalWrappers?: boolean;
}

export interface VastDocument {
  version?: string;
  ads: VastAd[];
  /** A response with no ads at all, which is how "no fill" is expressed. */
  empty: boolean;
  /** Document-level Error element, called when there is no ad. */
  errors: string[];
}

/** The stream an ad has to be spliced into, for conformance checks. */
export interface StreamProfile {
  /** Distinct codec strings the content presents. */
  codecs?: string[];
  /** width×height of each content rendition. */
  resolutions?: string[];
  /** Peak bandwidths, bits per second. */
  bandwidths?: number[];
  /** The avail this response is meant to fill, seconds. */
  availSeconds?: number;
  /** Server-side insertion cannot execute creative code; client-side can. */
  serverSide?: boolean;
}

function num(v: unknown): number | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const n = Number(String(v));
  return Number.isFinite(n) ? n : undefined;
}

function text(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    // CDATA and mixed content land on #text.
    if ("#text" in o) return String(o["#text"]).trim();
    return undefined;
  }
  const s = String(v).trim();
  return s.length ? s : undefined;
}

function arr<T>(v: T | T[] | undefined): T[] {
  return v === undefined ? [] : Array.isArray(v) ? v : [v];
}

/** HH:MM:SS or HH:MM:SS.mmm, as VAST states durations. */
export function parseVastDuration(s: string | undefined): number | undefined {
  if (!s) return undefined;
  const m = /^(\d+):(\d{1,2}):(\d{1,2})(?:\.(\d{1,3}))?$/.exec(s.trim());
  if (!m) {
    const n = Number(s);
    return Number.isFinite(n) ? n : undefined;
  }
  return (
    Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + (m[4] ? Number(m[4].padEnd(3, "0")) / 1000 : 0)
  );
}

/** "00:00:05" or a percentage of the creative. */
function parseSkipOffset(s: string | undefined, durationSec?: number): number | undefined {
  if (!s) return undefined;
  if (s.endsWith("%")) {
    const pct = Number(s.slice(0, -1));
    return Number.isFinite(pct) && durationSec !== undefined ? (pct / 100) * durationSec : undefined;
  }
  return parseVastDuration(s);
}

function readMediaFiles(linear: Record<string, unknown>): VastMediaFile[] {
  const container = linear.MediaFiles as Record<string, unknown> | undefined;
  return arr(container?.MediaFile as Record<string, unknown>[] | undefined).map((m) => ({
    url: text(m) ?? "",
    type: text(m["@type"]),
    width: num(m["@width"]),
    height: num(m["@height"]),
    bitrate: num(m["@bitrate"]),
    minBitrate: num(m["@minBitrate"]),
    maxBitrate: num(m["@maxBitrate"]),
    delivery: text(m["@delivery"]),
    codec: text(m["@codec"]),
    apiFramework: text(m["@apiFramework"]),
  }));
}

function readCreative(c: Record<string, unknown>): VastCreative {
  const linear = c.Linear as Record<string, unknown> | undefined;
  const kind: VastCreative["kind"] = linear
    ? "linear"
    : c.NonLinearAds
      ? "nonlinear"
      : "companion";

  const durationSec = parseVastDuration(text(linear?.Duration));
  const uaid = c.UniversalAdId as Record<string, unknown> | undefined;

  const tracking = arr(
    (linear?.TrackingEvents as Record<string, unknown> | undefined)?.Tracking as
      | Record<string, unknown>[]
      | undefined,
  )
    .map((t) => text(t["@event"]))
    .filter((x): x is string => !!x);

  return {
    id: text(c["@id"]),
    sequence: num(c["@sequence"]),
    durationSec,
    skipOffsetSec: parseSkipOffset(text(linear?.["@skipoffset"]), durationSec),
    mediaFiles: linear ? readMediaFiles(linear) : [],
    trackingEvents: tracking,
    universalAdId: uaid ? text(uaid) : undefined,
    universalAdIdRegistry: uaid ? text(uaid["@idRegistry"]) : undefined,
    clickThrough: text((linear?.VideoClicks as Record<string, unknown> | undefined)?.ClickThrough),
    kind,
  };
}

export function parseVast(xml: string, uri = "vast"): VastDocument {
  const doc = parser.parse(xml) as Record<string, unknown>;
  const root = doc.VAST as Record<string, unknown> | undefined;
  if (!root) throw new Error(`${uri} is not a VAST document (no <VAST> element)`);
  return buildFromTree(root);
}

/** Builds the document from a parsed tree, shared with inline VAST in a VMAP. */
function buildFromTree(root: Record<string, unknown>): VastDocument {
  const ads: VastAd[] = arr(root.Ad as Record<string, unknown>[] | undefined).map((a) => {
    const inline = a.InLine as Record<string, unknown> | undefined;
    const wrapper = a.Wrapper as Record<string, unknown> | undefined;
    const body = inline ?? wrapper ?? {};
    const creativesContainer = body.Creatives as Record<string, unknown> | undefined;

    return {
      id: text(a["@id"]),
      sequence: num(a["@sequence"]),
      wrapper: !!wrapper,
      adTagUri: wrapper ? text(wrapper.VASTAdTagURI) : undefined,
      adSystem: text(body.AdSystem),
      adTitle: text(body.AdTitle),
      creatives: arr(creativesContainer?.Creative as Record<string, unknown>[] | undefined).map(readCreative),
      impressions: arr(body.Impression as unknown[]).map((i) => text(i) ?? "").filter(Boolean),
      errors: arr(body.Error as unknown[]).map((e) => text(e) ?? "").filter(Boolean),
      allowMultipleAds: wrapper ? text(wrapper["@allowMultipleAds"]) === "true" : undefined,
      followAdditionalWrappers: wrapper
        ? text(wrapper["@followAdditionalWrappers"]) !== "false"
        : undefined,
    };
  });

  return {
    version: text(root["@version"]),
    ads,
    empty: ads.length === 0,
    errors: arr(root.Error as unknown[]).map((e) => text(e) ?? "").filter(Boolean),
  };
}

/* ------------------------------------------------------------- the rules */

/** Tracking events a pod needs before anything can be billed or diagnosed. */
const REQUIRED_TRACKING = ["start", "firstQuartile", "midpoint", "thirdQuartile", "complete"];

/** Container types a stitcher can actually splice without transcoding. */
const STITCHABLE_TYPES = ["video/mp4", "video/mp2t", "video/m4v", "application/x-mpegurl", "application/dash+xml"];

/** Audio codecs a ladder also advertises, which say nothing about the video. */
const AUDIO_CODECS = /^(mp4a|ac-3|ec-3|ac-4|opus|vorbis|flac|alac|dtsc|dtse)/i;

function isVideoCodec(codec: string): boolean {
  return !AUDIO_CODECS.test(codec.trim());
}

function codecFamily(codec: string): string {
  const c = codec.toLowerCase();
  if (c.startsWith("avc1") || c.startsWith("avc3") || c.includes("h264")) return "h264";
  if (c.startsWith("hvc1") || c.startsWith("hev1") || c.includes("h265") || c.includes("hevc")) return "hevc";
  if (c.startsWith("av01") || c.includes("av1")) return "av1";
  if (c.startsWith("vp09") || c.includes("vp9")) return "vp9";
  return c.split(".")[0];
}

export interface VastAnalysis {
  document: VastDocument;
  findings: Finding[];
  /** Total linear duration the response offers, seconds. */
  totalDurationSec: number;
  adCount: number;
  wrapperCount: number;
}

export function analyzeVast(doc: VastDocument, profile: StreamProfile = {}): VastAnalysis {
  const findings: Finding[] = [];
  const add = (severity: Severity, code: string, title: string, detail: string) =>
    findings.push({ severity, code, title, detail });

  const linearCreatives = doc.ads.flatMap((a) => a.creatives.filter((c) => c.kind === "linear"));
  const totalDurationSec = linearCreatives.reduce((n, c) => n + (c.durationSec ?? 0), 0);
  const wrapperCount = doc.ads.filter((a) => a.wrapper).length;

  if (doc.empty) {
    add(
      "warning",
      "VAST_NO_FILL",
      "The response contains no ads",
      "An empty VAST document is how a decision service says it has nothing to serve, so this is not malformed — the break will collapse and content will resume. It is still an avail that went unsold, and from the manifest alone it is indistinguishable from a break that was filled correctly.",
    );
    return { document: doc, findings, totalDurationSec, adCount: 0, wrapperCount };
  }

  for (const ad of doc.ads) {
    const who = ad.id ? `Ad ${ad.id}` : ad.adTitle ? `"${ad.adTitle}"` : "An ad";

    if (ad.wrapper) {
      if (!ad.adTagUri) {
        add(
          "error",
          "VAST_WRAPPER_NO_URI",
          `${who} is a wrapper with no VASTAdTagURI`,
          "A wrapper exists to point at another VAST document, and this one names nowhere to go. There is nothing to resolve, so the ad cannot be served at all.",
        );
      }
      // A wrapper carries no media of its own; the rest of the checks apply to
      // whatever it resolves to.
      continue;
    }

    if (ad.impressions.length === 0) {
      add(
        "error",
        "VAST_NO_IMPRESSION",
        `${who} carries no Impression URL`,
        "The impression is what gets counted and billed. An ad that plays without one is inventory delivered and not paid for, and the gap shows up as a discrepancy between the avails filled and the impressions recorded — usually blamed on the player.",
      );
    }

    if (ad.errors.length === 0) {
      add(
        "info",
        "VAST_NO_ERROR_URL",
        `${who} carries no Error URL`,
        "Without an Error element the decision service is never told when its creative failed to load or play. Fill rate then looks healthy from the ad server's side while viewers see slate, and the two teams look at different numbers.",
      );
    }

    for (const c of ad.creatives.filter((x) => x.kind === "linear")) {
      const cWho = c.id ? `${who} creative ${c.id}` : who;

      if (c.durationSec === undefined) {
        add(
          "error",
          "VAST_NO_DURATION",
          `${cWho} declares no Duration`,
          "A stitcher lays out the pod before it fetches anything, so it needs to know how long each creative runs. Without a duration it cannot decide whether the pod fits the avail, and most implementations drop the creative rather than guess.",
        );
      }

      const missing = REQUIRED_TRACKING.filter((e) => !c.trackingEvents.includes(e));
      if (missing.length > 0 && c.trackingEvents.length > 0) {
        add(
          "warning",
          "VAST_INCOMPLETE_TRACKING",
          `${cWho} is missing tracking for ${missing.join(", ")}`,
          "Quartile tracking is what distinguishes an ad that played from an ad that started. Without the full set, completion rate cannot be measured, and a creative that fails halfway through reports the same as one that ran to the end.",
        );
      } else if (c.trackingEvents.length === 0) {
        add(
          "warning",
          "VAST_NO_TRACKING",
          `${cWho} carries no tracking events at all`,
          "Nothing beyond the impression will be reported: no start, no quartiles, no completion. Whether the ad actually ran is unknowable from the ad server's side.",
        );
      }

      if (c.mediaFiles.length === 0) {
        add(
          "error",
          "VAST_NO_MEDIA_FILE",
          `${cWho} offers no MediaFile`,
          "There is nothing to play. The ad was decisioned, counted as a fill by the ad server, and cannot be delivered.",
        );
        continue;
      }

      // Executable creatives cannot run server-side: there is no browser.
      const executable = c.mediaFiles.filter((m) => m.apiFramework && !/^omid$/i.test(m.apiFramework));
      if (executable.length > 0 && profile.serverSide !== false) {
        const onlyExecutable = executable.length === c.mediaFiles.length;
        add(
          onlyExecutable ? "error" : "warning",
          "VAST_EXECUTABLE_CREATIVE",
          `${cWho} offers ${onlyExecutable ? "only " : ""}executable media (${[...new Set(executable.map((m) => m.apiFramework))].join(", ")})`,
          `${executable[0].apiFramework} creatives are code the player executes. Server-side insertion has no JavaScript engine and no player context, so it cannot run them — ${
            onlyExecutable
              ? "this ad is unfillable in an SSAI pipeline by construction, however healthy the signalling around it"
              : "the stitcher has to fall back to one of the other media files, and will drop the ad if none of them fits"
          }.`,
        );
      }

      const stitchable = c.mediaFiles.filter(
        (m) => !m.apiFramework && m.type && STITCHABLE_TYPES.includes(m.type.toLowerCase()),
      );
      if (stitchable.length === 0 && executable.length !== c.mediaFiles.length) {
        add(
          "warning",
          "VAST_NO_STITCHABLE_MEDIA",
          `${cWho} offers no media in a container a stitcher can splice`,
          `The response offers ${[...new Set(c.mediaFiles.map((m) => m.type ?? "untyped"))].join(", ")}. Server-side insertion splices segments into an existing presentation, so it needs a progressive MP4 or transport stream — or an HLS or DASH rendition of its own — not a format only a browser can open.`,
        );
      }

      // Does anything on offer match the ladder it has to be spliced into?
      if (profile.codecs?.length && stitchable.length > 0) {
        // A ladder advertises audio codecs too; comparing an ad's video
        // against "mp4a" would report a mismatch on every well-formed stream.
        const contentFamilies = new Set(profile.codecs.filter(isVideoCodec).map(codecFamily));
        const adFamilies = new Set(
          stitchable.filter((m) => m.codec && isVideoCodec(m.codec)).map((m) => codecFamily(m.codec!)),
        );
        if (contentFamilies.size > 0 && adFamilies.size > 0 && ![...adFamilies].some((f) => contentFamilies.has(f))) {
          add(
            "warning",
            "VAST_CODEC_MISMATCH",
            `${cWho} offers ${[...adFamilies].join(", ")} where the stream is ${[...contentFamilies].join(", ")}`,
            "The creative is encoded differently from the programme it has to sit inside. Either the stitcher transcodes it — which costs time the decision budget may not have — or it splices a stream the player has to re-initialise its decoder for, which is the black frame at the start of the break.",
          );
        }
      }

      if (profile.bandwidths?.length) {
        const peak = Math.max(...profile.bandwidths) / 1000; // VAST states kbps
        const rates = stitchable.map((m) => m.bitrate ?? m.maxBitrate).filter((b): b is number => !!b);
        if (rates.length > 0 && Math.min(...rates) > peak * 1.5) {
          add(
            "info",
            "VAST_BITRATE_ABOVE_LADDER",
            `${cWho} offers nothing below ${Math.min(...rates)}kbps against a ${Math.round(peak)}kbps ladder`,
            "Every media file on offer is encoded well above the top rung of the stream it is being spliced into. A viewer on a lower rung gets an ad heavier than anything they have been able to sustain, which is where mid-break rebuffering comes from.",
          );
        }
      }
    }
  }

  // Does the pod fit the hole it was requested for?
  if (profile.availSeconds !== undefined && totalDurationSec > 0) {
    const delta = totalDurationSec - profile.availSeconds;
    if (Math.abs(delta) > 0.5) {
      add(
        delta > 0 ? "error" : "warning",
        delta > 0 ? "VAST_POD_OVERRUNS_AVAIL" : "VAST_POD_UNDERFILLS_AVAIL",
        `The pod runs ${totalDurationSec.toFixed(1)}s against a ${profile.availSeconds.toFixed(1)}s avail`,
        delta > 0
          ? `The creatives returned total ${Math.abs(delta).toFixed(1)}s more than the break they were requested for. The stitcher either truncates the last ad — which is unbillable — or runs past the return and cuts into programme content.`
          : `The creatives returned leave ${Math.abs(delta).toFixed(1)}s of the break unfilled. The tail is slate, black, or an early return to content, and it is measurable lost revenue rather than a delivery fault.`,
      );
    }
  }

  return { document: doc, findings, totalDurationSec, adCount: doc.ads.length, wrapperCount };
}

/* ------------------------------------------------- following the wrappers */

/**
 * A wrapper is a redirect, and redirects nest. Every hop is a round trip
 * against a decision budget that, on a low-latency stream, is about a second
 * in total — so the depth of a chain is not a stylistic matter.
 */
export interface WrapperHop {
  depth: number;
  url: string;
  ok: boolean;
  status?: number;
  ms: number;
  error?: string;
  adCount?: number;
}

export interface WrapperChain {
  hops: WrapperHop[];
  /** The inline document the chain finally resolved to, if it did. */
  resolved?: VastDocument;
  totalMs: number;
  findings: Finding[];
}

export interface VastFetchResponse {
  ok: boolean;
  status?: number;
  text?: string;
  ms: number;
  error?: string;
}

export type VastFetcher = (url: string, timeoutMs: number) => Promise<VastFetchResponse>;

export interface WrapperOptions {
  timeoutMs?: number;
  /** IAB guidance is five; beyond that most players give up. */
  maxDepth?: number;
  fetcher?: VastFetcher;
}

/** Past this, the round trips cost more than the ad is worth. */
const SLOW_CHAIN_MS = 2_000;

export async function followWrappers(
  doc: VastDocument,
  baseUri: string,
  options: WrapperOptions = {},
): Promise<WrapperChain> {
  const timeoutMs = options.timeoutMs ?? 8_000;
  const maxDepth = options.maxDepth ?? 5;
  const fetcher = options.fetcher;
  const chain: WrapperChain = { hops: [], totalMs: 0, findings: [] };
  const add = (severity: Severity, code: string, title: string, detail: string) =>
    chain.findings.push({ severity, code, title, detail });

  if (!fetcher) throw new Error("following wrappers needs a fetcher");

  let current = doc;
  let url = baseUri;
  const seen = new Set<string>([baseUri]);

  for (let depth = 1; depth <= maxDepth + 1; depth++) {
    const wrapper = current.ads.find((a) => a.wrapper && a.adTagUri);
    if (!wrapper) {
      chain.resolved = current;
      break;
    }

    if (depth > maxDepth) {
      add(
        "error",
        "VAST_WRAPPER_TOO_DEEP",
        `The wrapper chain is still going after ${maxDepth} hops`,
        `IAB guidance puts the limit at ${maxDepth} redirects and most players stop there. A chain this long has spent more time being followed than the ad will spend on screen, and on a low-latency stream the decision budget was gone several hops ago.`,
      );
      break;
    }

    const next = new URL(wrapper.adTagUri!, url).toString();
    if (seen.has(next)) {
      add(
        "error",
        "VAST_WRAPPER_LOOP",
        `The wrapper chain returns to ${next}`,
        "A wrapper points back at a document already in this chain. It will never resolve to an inline ad; a player follows it until it hits its own depth limit and then reports an error, so the avail goes unfilled after paying for every round trip.",
      );
      break;
    }
    seen.add(next);

    const res = await fetcher(next, timeoutMs);
    chain.totalMs += res.ms;
    const hop: WrapperHop = { depth, url: next, ok: res.ok, status: res.status, ms: res.ms, error: res.error };

    if (!res.ok || !res.text) {
      hop.error = res.error ?? `HTTP ${res.status}`;
      chain.hops.push(hop);
      add(
        "error",
        "VAST_WRAPPER_UNRESOLVED",
        `Hop ${depth} did not answer${res.status ? ` (HTTP ${res.status})` : ""}`,
        `${next} ${res.error ?? `returned HTTP ${res.status}`} after ${res.ms}ms. The chain stops here, so nothing plays — and because the failure is two or three redirects away from the manifest, it is usually reported as a packaging fault.`,
      );
      break;
    }

    try {
      current = parseVast(res.text, next);
      hop.adCount = current.ads.length;
      chain.hops.push(hop);
    } catch (e) {
      hop.error = e instanceof Error ? e.message : String(e);
      chain.hops.push(hop);
      add(
        "error",
        "VAST_WRAPPER_UNPARSEABLE",
        `Hop ${depth} answered with something that is not VAST`,
        `${next} responded in ${res.ms}ms with a body that does not parse: ${hop.error}. A redirect that answers with an error page fails exactly like one that does not answer, and is harder to spot because the request succeeded.`,
      );
      break;
    }

    if (current.empty) {
      chain.resolved = current;
      break;
    }
    url = next;
  }

  if (chain.totalMs > SLOW_CHAIN_MS) {
    add(
      "warning",
      "VAST_CHAIN_SLOW",
      `Following the chain took ${(chain.totalMs / 1000).toFixed(1)}s across ${chain.hops.length} hop(s)`,
      `Every redirect is a round trip, and they are serial: a player cannot start the next until the last one answers. ${(chain.totalMs / 1000).toFixed(1)}s is longer than most ad decisions are given, and on a low-latency stream it is longer than the entire distance the viewer sits behind the live edge.`,
    );
  }

  return chain;
}

/* --------------------------------------------------------------- VMAP ---- */

export interface VmapBreak {
  id?: string;
  /** "start", "end", "00:10:00", or a percentage. */
  timeOffset?: string;
  /** Resolved to seconds where the offset is a time. */
  offsetSec?: number;
  breakType?: string;
  /** A tag URI to call, or an inline VAST document. */
  adTagUri?: string;
  inline?: VastDocument;
}

export interface VmapDocument {
  version?: string;
  breaks: VmapBreak[];
}

export function parseVmap(xml: string, uri = "vmap"): VmapDocument {
  const doc = parser.parse(xml) as Record<string, unknown>;
  const root = doc.VMAP as Record<string, unknown> | undefined;
  if (!root) throw new Error(`${uri} is not a VMAP document (no <VMAP> element)`);

  const breaks = arr(root.AdBreak as Record<string, unknown>[] | undefined).map((b) => {
    const offset = text(b["@timeOffset"]);
    const source = b.AdSource as Record<string, unknown> | undefined;
    const inlineXml = source?.VASTAdData as Record<string, unknown> | undefined;
    let inline: VastDocument | undefined;
    if (inlineXml) {
      // VASTAdData wraps a whole VAST document; re-serialising is unnecessary
      // because the parser has already produced its tree.
      try {
        const tree = (inlineXml.VAST ?? inlineXml) as Record<string, unknown>;
        inline = buildFromTree(tree);
      } catch {
        inline = undefined;
      }
    }
    return {
      id: text(b["@breakId"]),
      timeOffset: offset,
      offsetSec: offset && /^\d+:\d{2}:\d{2}/.test(offset) ? parseVastDuration(offset) : undefined,
      breakType: text(b["@breakType"]),
      adTagUri: text((source?.AdTagURI as Record<string, unknown> | undefined) ?? undefined),
      inline,
    };
  });

  return { version: text(root["@version"]), breaks };
}

export function analyzeVmap(doc: VmapDocument): Finding[] {
  const findings: Finding[] = [];
  const add = (severity: Severity, code: string, title: string, detail: string) =>
    findings.push({ severity, code, title, detail });

  if (doc.breaks.length === 0) {
    add("warning", "VMAP_NO_BREAKS", "The schedule contains no ad breaks", "A VMAP with no AdBreak elements schedules nothing. Whatever was meant to run in this asset will not.");
    return findings;
  }

  for (const b of doc.breaks) {
    const who = b.id ? `Break ${b.id}` : `The break at ${b.timeOffset ?? "an unstated offset"}`;
    if (!b.timeOffset) {
      add("error", "VMAP_NO_TIME_OFFSET", `${who} states no timeOffset`, "Without an offset there is nothing to say where the break belongs, so it is either dropped or placed at the start depending on the implementation.");
    }
    if (!b.adTagUri && !b.inline) {
      add("error", "VMAP_NO_AD_SOURCE", `${who} names no AdSource`, "The break is scheduled with nothing to put in it — neither an inline VAST document nor a tag URI to call. The slot exists and will be empty.");
    }
  }

  // Two breaks at the same instant are a scheduling fault, not a pod.
  const byOffset = new Map<string, number>();
  for (const b of doc.breaks) {
    if (!b.timeOffset) continue;
    byOffset.set(b.timeOffset, (byOffset.get(b.timeOffset) ?? 0) + 1);
  }
  for (const [offset, n] of byOffset) {
    if (n > 1) {
      add("warning", "VMAP_DUPLICATE_OFFSET", `${n} breaks are scheduled at ${offset}`, "Two breaks at the same point are not a pod — a pod is several ads in one break. Players differ on whether they run both, run one, or drop to an error, so the behaviour is not predictable across devices.");
    }
  }

  return findings;
}
