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
  supplementalProperties: string[];
  essentialProperties: string[];
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
}

export interface MpdDocument {
  uri: string;
  type: "static" | "dynamic";
  profiles?: string;
  availabilityStartTime?: number;
  publishTime?: number;
  minimumUpdatePeriod?: number;
  timeShiftBufferDepth?: number;
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
    ["Period", "AdaptationSet", "Representation", "EventStream", "Event", "S", "SupplementalProperty", "EssentialProperty", "AssetIdentifier"].includes(
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
} {
  const tpl = (child(as, "SegmentTemplate") ?? child(as, "SegmentList")) as
    | Record<string, unknown>
    | undefined;
  if (!tpl) return { timescale: 1, pto: 0, duration: 0, count: 0 };
  const timescale = num(pick(tpl, "timescale")) ?? 1;
  const pto = num(pick(tpl, "presentationTimeOffset")) ?? 0;
  const media = pick(tpl, "media") !== undefined ? String(pick(tpl, "media")) : undefined;

  const timeline = child(tpl, "SegmentTimeline") as Record<string, unknown> | undefined;
  if (timeline) {
    const Ss = arr(child(timeline, "S") as Record<string, unknown>[] | undefined);
    let total = 0;
    let count = 0;
    let first: number | undefined;
    let cursor: number | undefined;
    for (const S of Ss) {
      const t = num(pick(S, "t"));
      const d = num(pick(S, "d")) ?? 0;
      const r = num(pick(S, "r")) ?? 0;
      if (t !== undefined) cursor = t;
      if (first === undefined) first = cursor;
      const reps = r < 0 ? 1 : r + 1; // negative @r means "until the next @t"; count it once
      total += d * reps;
      count += reps;
      if (cursor !== undefined) cursor += d * reps;
    }
    return { timescale, pto, first, duration: total / timescale, count, media };
  }

  // SegmentTemplate with @duration and no timeline.
  const d = num(pick(tpl, "duration"));
  if (d !== undefined) {
    return { timescale, pto, first: pto, duration: 0, count: 0, media };
  }
  return { timescale, pto, duration: 0, count: 0, media };
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
        supplementalProperties: schemeList(as, "SupplementalProperty"),
        essentialProperties: schemeList(as, "EssentialProperty"),
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
    const mediaDuration = video ? video.mediaDuration : (declaredDuration ?? 0);
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
    });

    runningStart = start + (declaredDuration ?? mediaDuration);
  });

  return {
    uri,
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
