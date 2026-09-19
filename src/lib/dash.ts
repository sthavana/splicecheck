/**
 * MPEG-DASH MPD parsing focused on multi-period ad signalling.
 *
 * Multi-period is how DASH carries ad breaks: each avail becomes its own
 * Period, and the SCTE-35 rides in a Period-level EventStream. Everything
 * here is oriented around reconstructing that structure faithfully enough
 * to tell a real fault from a normal live-window artefact.
 */

import { XMLParser } from "fast-xml-parser";

export const SCTE35_SCHEMES = [
  "urn:scte:scte35:2014:xml+bin",
  "urn:scte:scte35:2013:xml",
  "urn:scte:scte35:2014:xml",
];

export interface DashRepresentation {
  id: string;
  codecs?: string;
  bandwidth?: number;
  width?: number;
  height?: number;
  frameRate?: string;
  audioSamplingRate?: string;
}

/** One entry of an expanded SegmentTimeline. */
export interface DashSegmentEntry {
  /** start time in the adaptation set's timescale */
  t: number;
  /** duration in the adaptation set's timescale */
  d: number;
  /** segment number, for $Number$ templates */
  number: number;
}

export interface DashAdaptationSet {
  id?: string;
  mimeType?: string;
  contentType?: string;
  lang?: string;
  timescale: number;
  presentationTimeOffset: number;
  /** @t of the first S in the timeline, in timescale ticks */
  firstSegmentTime?: number;
  /** total of the timeline, seconds */
  mediaDuration: number;
  segmentCount: number;
  representations: DashRepresentation[];
  /** SegmentTemplate@media, which points at where the media actually lives */
  mediaTemplate?: string;
  /** SegmentTemplate@initialization */
  initTemplate?: string;
  /** SegmentTemplate@startNumber, defaulting to 1 */
  startNumber: number;
  /** BaseURL chain that media references resolve against */
  baseUrl?: string;
  /** expanded timeline, bounded so a long DVR window cannot blow up memory */
  segments: DashSegmentEntry[];
  /** SegmentTemplate@duration, for streams addressed by number rather than time */
  segmentDuration?: number;
  /**
   * Seconds earlier than nominal that a segment becomes available. Non-zero
   * means the packager publishes it while it is still being written, which is
   * how DASH does low latency.
   */
  availabilityTimeOffset?: number;
  /** false means the segment is published before it is complete. */
  availabilityTimeComplete?: boolean;
  /** whether a SegmentTimeline was present at all */
  usesTimeline: boolean;
  supplementalProperties: string[];
  essentialProperties: string[];
  /** schemes this set declares it carries inband, as InbandEventStream */
  inbandEventSchemes: string[];
}

export interface DashEvent {
  schemeIdUri: string;
  value?: string;
  id?: string;
  /** seconds, relative to period start */
  presentationTime: number;
  presentationTimeExplicit: boolean;
  duration?: number;
  timescale: number;
  /** base64 SCTE-35 from scte35:Binary, if present */
  payload?: string;
  /** vendor extension attributes, such as a packager's own segmentTypeId */
  extraAttrs: Record<string, string>;
}

export interface DashPeriod {
  id?: string;
  index: number;
  /** seconds */
  start: number;
  startExplicit: boolean;
  /** @duration if declared, seconds */
  declaredDuration?: number;
  /** derived from the segment timelines, seconds */
  mediaDuration: number;
  /** where the media actually begins, seconds on the presentation timeline */
  mediaStart: number;
  adaptationSets: DashAdaptationSet[];
  events: DashEvent[];
  assetIdentifier?: string;
  supplementalProperties: string[];
  /**
   * A remote Period: the manifest names a service that supplies the real
   * content at playback time rather than carrying it here. This is how
   * multi-period DASH does server-side ad insertion — the packager leaves a
   * placeholder pointing at an ad decision service, and something resolves it
   * before the player reaches it.
   */
  xlinkHref?: string;
  /** "onLoad" resolves when the manifest is parsed; "onRequest" defers it. */
  xlinkActuate?: string;
  /** A remote Period that carries no media of its own yet. */
  isPlaceholder: boolean;
}

/**
 * ServiceDescription/Latency. Where LL-HLS states the contract in
 * EXT-X-SERVER-CONTROL, DASH states it here: how far behind live the packager
 * intends players to sit, and how far it will let them drift.
 */
export interface DashLatency {
  targetMs?: number;
  minMs?: number;
  maxMs?: number;
  referenceId?: number;
}

export interface MpdDocument {
  uri: string;
  type: "static" | "dynamic";
  profiles?: string;
  availabilityStartTime?: number;
  publishTime?: number;
  minimumUpdatePeriod?: number;
  timeShiftBufferDepth?: number;
  /** ServiceDescription latency, where the manifest declares one. */
  latency?: DashLatency;
  /** Any adaptation set publishing segments before they are complete. */
  chunked: boolean;
  suggestedPresentationDelay?: number;
  minBufferTime?: number;
  mediaPresentationDuration?: number;
  periods: DashPeriod[];
}

/** ISO 8601 duration → seconds. */
export function parseDuration(s: string | undefined): number | undefined {
  if (!s) return undefined;
  const m = /^(-)?P(?:(\d+(?:\.\d+)?)Y)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(
    s.trim(),
  );
  if (!m) return undefined;
  const [, neg, y, mo, d, h, mi, sec] = m;
  const n = (v: string | undefined) => (v ? parseFloat(v) : 0);
  const total =
    n(y) * 31536000 + n(mo) * 2592000 + n(d) * 86400 + n(h) * 3600 + n(mi) * 60 + n(sec);
  return neg ? -total : total;
}

function num(v: unknown): number | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function arr<T>(v: T | T[] | undefined): T[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

/** BaseURL is inherited down the MPD, so resolve the chain that applies here. */
function baseUrlFor(
  mpd: Record<string, unknown>,
  period: Record<string, unknown>,
  as: Record<string, unknown>,
): string | undefined {
  const parts: string[] = [];
  for (const node of [mpd, period, as]) {
    const b = child(node, "BaseURL");
    const first = Array.isArray(b) ? b[0] : b;
    const value =
      typeof first === "string"
        ? first
        : first && typeof first === "object"
          ? String((first as Record<string, unknown>)["#text"] ?? "")
          : "";
    if (value) parts.push(value);
  }
  return parts.length ? parts.join("") : undefined;
}

/**
 * Fills a SegmentTemplate. Identifiers may carry a printf-style width, as in
 * `$Number%05d$`, which some packagers rely on for fixed-length filenames.
 */
export function fillTemplate(
  template: string,
  vars: { RepresentationID?: string; Number?: number; Time?: number; Bandwidth?: number },
): string {
  // `$$` is an escaped dollar and must be matched before an identifier, or a
  // literal dollar in a path swallows the next token.
  return template.replace(/\$\$|\$([A-Za-z]+)(%0\d+[du])?\$/g, (m, name?: string, fmt?: string) => {
    if (m === "$$") return "$";
    if (!name) return m;
    const value = (vars as Record<string, string | number | undefined>)[name];
    if (value === undefined) return "";
    if (fmt) {
      const width = Number(/%0(\d+)/.exec(fmt)?.[1] ?? 0);
      return String(value).padStart(width, "0");
    }
    return String(value);
  });
}

export function isMpd(text: string): boolean {
  return /<MPD[\s>]/.test(text.slice(0, 4000));
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  removeNSPrefix: false,
  parseAttributeValue: false,
  trimValues: true,
  // Elements that must stay arrays even when a single one appears.
  isArray: (name) =>
    ["Period", "AdaptationSet", "Representation", "EventStream", "Event", "S", "SupplementalProperty", "EssentialProperty", "AssetIdentifier", "InbandEventStream"].includes(
      name.replace(/^.*:/, ""),
    ),
});

/** Attribute lookup that tolerates namespace prefixes, including vendor ones. */
function pick(obj: Record<string, unknown>, localName: string): unknown {
  if (obj[`@${localName}`] !== undefined) return obj[`@${localName}`];
  for (const k of Object.keys(obj)) {
    if (k.startsWith("@") && k.slice(1).replace(/^.*:/, "") === localName) return obj[k];
  }
  return undefined;
}

function child(obj: Record<string, unknown>, localName: string): unknown {
  if (obj[localName] !== undefined) return obj[localName];
  for (const k of Object.keys(obj)) {
    if (!k.startsWith("@") && k.replace(/^.*:/, "") === localName) return obj[k];
  }
  return undefined;
}

function deepFindText(node: unknown, localName: string): string | undefined {
  if (node === null || typeof node !== "object") return undefined;
  const o = node as Record<string, unknown>;
  for (const [k, v] of Object.entries(o)) {
    if (k.startsWith("@")) continue;
    if (k.replace(/^.*:/, "") === localName) {
      const first = Array.isArray(v) ? v[0] : v;
      if (typeof first === "string" || typeof first === "number") return String(first);
      if (first && typeof first === "object") {
        const t = (first as Record<string, unknown>)["#text"];
        if (t !== undefined) return String(t);
      }
      return undefined;
    }
    const nested = Array.isArray(v) ? v : [v];
    for (const n of nested) {
      const found = deepFindText(n, localName);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

function schemeList(node: Record<string, unknown>, tag: string): string[] {
  return arr(child(node, tag) as Record<string, unknown>[] | undefined).map((p) => {
    const s = String(pick(p, "schemeIdUri") ?? "");
    const v = pick(p, "value");
    return v !== undefined ? `${s}=${v}` : s;
  });
}

function parseSegmentTiming(as: Record<string, unknown>): {
  timescale: number;
  pto: number;
  first?: number;
  duration: number;
  count: number;
  media?: string;
  init?: string;
  startNumber: number;
  entries: DashSegmentEntry[];
  segmentDuration?: number;
  usesTimeline: boolean;
  ato?: number;
  atComplete?: boolean;
} {
  const tpl = (child(as, "SegmentTemplate") ?? child(as, "SegmentList")) as
    | Record<string, unknown>
    | undefined;
  if (!tpl) return { timescale: 1, pto: 0, duration: 0, count: 0, startNumber: 1, entries: [], usesTimeline: false };
  const timescale = num(pick(tpl, "timescale")) ?? 1;
  const ato = num(pick(tpl, "availabilityTimeOffset"));
  const atCompleteRaw = pick(tpl, "availabilityTimeComplete");
  const atComplete = atCompleteRaw === undefined ? undefined : String(atCompleteRaw) !== "false";
  const pto = num(pick(tpl, "presentationTimeOffset")) ?? 0;
  const media = pick(tpl, "media") !== undefined ? String(pick(tpl, "media")) : undefined;
  const init = pick(tpl, "initialization") !== undefined ? String(pick(tpl, "initialization")) : undefined;
  const startNumber = num(pick(tpl, "startNumber")) ?? 1;
  const MAX_ENTRIES = 5000;

  const timeline = child(tpl, "SegmentTimeline") as Record<string, unknown> | undefined;
  if (timeline) {
    const Ss = arr(child(timeline, "S") as Record<string, unknown>[] | undefined);
    let total = 0;
    let count = 0;
    let first: number | undefined;
    let cursor: number | undefined;
    let number = startNumber;
    const entries: DashSegmentEntry[] = [];
    for (const S of Ss) {
      const t = num(pick(S, "t"));
      const d = num(pick(S, "d")) ?? 0;
      const r = num(pick(S, "r")) ?? 0;
      if (t !== undefined) cursor = t;
      if (first === undefined) first = cursor;
      const reps = r < 0 ? 1 : r + 1; // negative @r means "until the next @t"; count it once
      for (let i = 0; i < reps && entries.length < MAX_ENTRIES; i++) {
        if (cursor !== undefined) entries.push({ t: cursor + i * d, d, number: number + i });
      }
      total += d * reps;
      count += reps;
      number += reps;
      if (cursor !== undefined) cursor += d * reps;
    }
    return { timescale, pto, first, duration: total / timescale, count, media, init, startNumber, entries, usesTimeline: true, ato, atComplete };
  }

  // SegmentTemplate with @duration and no timeline: segments are uniform, and
  // their numbers run from @startNumber.
  const d = num(pick(tpl, "duration"));
  if (d !== undefined) {
    return {
      timescale, pto, first: pto, duration: 0, count: 0, media, init, startNumber,
      entries: [], segmentDuration: d, usesTimeline: false, ato, atComplete,
    };
  }
  return { timescale, pto, duration: 0, count: 0, media, init, startNumber, entries: [], usesTimeline: false , ato, atComplete };
}

export function parseMpd(text: string, uri: string): MpdDocument {
  const doc = parser.parse(text) as Record<string, unknown>;
  const mpd = (child(doc, "MPD") ?? {}) as Record<string, unknown>;

  const availabilityStartTime = pick(mpd, "availabilityStartTime")
    ? Date.parse(String(pick(mpd, "availabilityStartTime")))
    : undefined;
  const publishTime = pick(mpd, "publishTime")
    ? Date.parse(String(pick(mpd, "publishTime")))
    : undefined;

  const periodsRaw = arr(child(mpd, "Period") as Record<string, unknown>[] | undefined);
  const periods: DashPeriod[] = [];
  let runningStart = 0;

  periodsRaw.forEach((p, index) => {
    const startAttr = pick(p, "start");
    const startExplicit = startAttr !== undefined;
    const start = startExplicit ? (parseDuration(String(startAttr)) ?? 0) : runningStart;
    const declaredDuration = parseDuration(pick(p, "duration") as string | undefined);

    const xlinkHrefRaw = pick(p, "href");
    const xlinkHref = xlinkHrefRaw !== undefined ? String(xlinkHrefRaw) : undefined;
    const xlinkActuate = pick(p, "actuate") !== undefined ? String(pick(p, "actuate")) : undefined;

    const adaptationSets: DashAdaptationSet[] = arr(
      child(p, "AdaptationSet") as Record<string, unknown>[] | undefined,
    ).map((as) => {
      const timing = parseSegmentTiming(as);
      const reps: DashRepresentation[] = arr(
        child(as, "Representation") as Record<string, unknown>[] | undefined,
      ).map((r) => ({
        id: String(pick(r, "id") ?? ""),
        codecs: pick(r, "codecs") ? String(pick(r, "codecs")) : (pick(as, "codecs") ? String(pick(as, "codecs")) : undefined),
        bandwidth: num(pick(r, "bandwidth")),
        width: num(pick(r, "width")),
        height: num(pick(r, "height")),
        frameRate: pick(r, "frameRate") ? String(pick(r, "frameRate")) : undefined,
        audioSamplingRate: pick(r, "audioSamplingRate") ? String(pick(r, "audioSamplingRate")) : undefined,
      }));
      return {
        id: pick(as, "id") !== undefined ? String(pick(as, "id")) : undefined,
        mimeType: pick(as, "mimeType") ? String(pick(as, "mimeType")) : undefined,
        contentType: pick(as, "contentType") ? String(pick(as, "contentType")) : undefined,
        lang: pick(as, "lang") ? String(pick(as, "lang")) : undefined,
        timescale: timing.timescale,
        presentationTimeOffset: timing.pto,
        firstSegmentTime: timing.first,
        mediaDuration: timing.duration,
        segmentCount: timing.count,
        representations: reps,
        mediaTemplate: timing.media,
        initTemplate: timing.init,
        startNumber: timing.startNumber,
        baseUrl: baseUrlFor(mpd, p, as),
        segments: timing.entries,
        segmentDuration: timing.segmentDuration,
        usesTimeline: timing.usesTimeline,
        supplementalProperties: schemeList(as, "SupplementalProperty"),
        essentialProperties: schemeList(as, "EssentialProperty"),
        inbandEventSchemes: schemeList(as, "InbandEventStream"),
        availabilityTimeOffset: timing.ato,
        availabilityTimeComplete: timing.atComplete,
      };
    });

    const events: DashEvent[] = [];
    for (const es of arr(child(p, "EventStream") as Record<string, unknown>[] | undefined)) {
      const schemeIdUri = String(pick(es, "schemeIdUri") ?? "");
      const esTimescale = num(pick(es, "timescale")) ?? 1;
      const esValue = pick(es, "value");
      for (const ev of arr(child(es, "Event") as Record<string, unknown>[] | undefined)) {
        const ptRaw = pick(ev, "presentationTime");
        const durRaw = pick(ev, "duration");
        const extraAttrs: Record<string, string> = {};
        for (const [k, v] of Object.entries(ev)) {
          if (!k.startsWith("@")) continue;
          const local = k.slice(1);
          if (["presentationTime", "duration", "id", "timescale"].includes(local.replace(/^.*:/, ""))) continue;
          extraAttrs[local] = String(v);
        }
        events.push({
          schemeIdUri,
          value: esValue !== undefined ? String(esValue) : undefined,
          id: pick(ev, "id") !== undefined ? String(pick(ev, "id")) : undefined,
          presentationTime: (num(ptRaw) ?? 0) / esTimescale,
          presentationTimeExplicit: ptRaw !== undefined,
          duration: num(durRaw) !== undefined ? num(durRaw)! / esTimescale : undefined,
          timescale: esTimescale,
          payload: deepFindText(ev, "Binary"),
          extraAttrs,
        });
      }
    }

    // Media extent comes from the timelines, which is what actually exists
    // on the origin — Period@duration is frequently absent on live.
    const withMedia = adaptationSets.filter((a) => a.segmentCount > 0);
    // Continuity is measured against one reference set — the video where there
    // is one. Audio timelines legitimately differ by a frame or two, and
    // mixing them in produces phantom sub-frame gaps at every boundary.
    const video = withMedia.find((a) => a.mimeType?.startsWith("video")) ?? withMedia[0];
    const anyTemplate = adaptationSets.find((a) => a.mediaTemplate);
    const mediaDuration = video
      ? video.mediaDuration
      : // Number-addressed segments have no timeline to total up.
        (declaredDuration ?? (anyTemplate?.segmentDuration !== undefined ? NaN : 0));
    const mediaStart =
      video && video.firstSegmentTime !== undefined
        ? video.firstSegmentTime / video.timescale
        : start;

    const assetId = arr(child(p, "AssetIdentifier") as Record<string, unknown>[] | undefined)[0];

    periods.push({
      id: pick(p, "id") !== undefined ? String(pick(p, "id")) : undefined,
      index,
      start,
      startExplicit,
      declaredDuration,
      mediaDuration,
      mediaStart,
      adaptationSets,
      events,
      assetIdentifier: assetId
        ? `${pick(assetId, "schemeIdUri") ?? ""}${pick(assetId, "value") ? "=" + pick(assetId, "value") : ""}`
        : undefined,
      supplementalProperties: schemeList(p, "SupplementalProperty"),
      xlinkHref,
      xlinkActuate,
      // A remote Period that has not been resolved carries no media of its own.
      // Once resolved, the AdaptationSets are present and it is an ordinary
      // Period that happens to have come from somewhere else.
      isPlaceholder: xlinkHref !== undefined && adaptationSets.length === 0,
    });

    runningStart = start + (declaredDuration ?? mediaDuration);
  });

  // A period whose extent could not be measured takes it from where the next
  // one begins; the last such period runs to the end of the presentation.
  periods.forEach((p, i) => {
    if (!Number.isNaN(p.mediaDuration)) return;
    const next = periods[i + 1];
    p.mediaDuration = next ? Math.max(0, next.start - p.start) : 0;
  });

  // ServiceDescription is where DASH states its latency contract.
  let latency: DashLatency | undefined;
  for (const sd of arr(child(mpd, "ServiceDescription") as Record<string, unknown>[] | undefined)) {
    const l = child(sd, "Latency") as Record<string, unknown> | undefined;
    if (!l) continue;
    latency = {
      targetMs: num(pick(l, "target")),
      minMs: num(pick(l, "min")),
      maxMs: num(pick(l, "max")),
      referenceId: num(pick(l, "referenceId")),
    };
    break;
  }

  const chunked = periods.some((p) =>
    p.adaptationSets.some(
      (a) => a.availabilityTimeComplete === false || (a.availabilityTimeOffset ?? 0) > 0,
    ),
  );

  return {
    uri,
    latency,
    chunked,
    type: String(pick(mpd, "type") ?? "static") === "dynamic" ? "dynamic" : "static",
    profiles: pick(mpd, "profiles") ? String(pick(mpd, "profiles")) : undefined,
    availabilityStartTime: Number.isNaN(availabilityStartTime) ? undefined : availabilityStartTime,
    publishTime: Number.isNaN(publishTime) ? undefined : publishTime,
    minimumUpdatePeriod: parseDuration(pick(mpd, "minimumUpdatePeriod") as string | undefined),
    timeShiftBufferDepth: parseDuration(pick(mpd, "timeShiftBufferDepth") as string | undefined),
    suggestedPresentationDelay: parseDuration(pick(mpd, "suggestedPresentationDelay") as string | undefined),
    minBufferTime: parseDuration(pick(mpd, "minBufferTime") as string | undefined),
    mediaPresentationDuration: parseDuration(pick(mpd, "mediaPresentationDuration") as string | undefined),
    periods,
  };
}
