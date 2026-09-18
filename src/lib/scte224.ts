/**
 * SCTE-224 (Event Scheduling and Notification Interface).
 *
 * SCTE-35 says *when* something happens on a stream. SCTE-224 says *what
 * should be done about it*: which audiences see an alternate feed, which
 * regions are blacked out, what replaces the content and for how long. The two
 * are delivered separately — the cue rides in the stream, the policy comes
 * from an ESNI endpoint — so nothing normally checks that they refer to the
 * same thing.
 *
 * This parses a policy document and lines its MediaPoints up against the
 * signals a stream actually carries.
 */

import { XMLParser } from "fast-xml-parser";
import { parseSpliceInfoSection, SEGMENTATION_TYPES, type SpliceInfoSection } from "./scte35";
import type { AdBreak, Finding, Severity } from "./analyze";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  removeNSPrefix: true,
  parseAttributeValue: false,
  trimValues: true,
  isArray: (name) =>
    ["Media", "MediaPoint", "Policy", "ViewingPolicy", "Audience", "Apply", "Remove", "Signal", "SignalPointID"].includes(
      name.replace(/^.*:/, ""),
    ),
});

export interface Scte224MediaPoint {
  id?: string;
  /** effective and expires bound when the policy applies */
  effective?: number;
  expires?: number;
  /** wall clock the point refers to on the stream */
  matchTime?: number;
  /** offset from matchTime */
  matchOffset?: number;
  /** SCTE-35 the point expects to see */
  signal?: SpliceInfoSection;
  signalError?: string;
  /** segmentation UPIDs named by the point */
  signalPointIds: string[];
  /** policies applied and removed at this point */
  applies: string[];
  removes: string[];
  /** expected duration of what the point governs */
  expectedDuration?: number;
  source?: string;
}

export interface Scte224Media {
  id?: string;
  source?: string;
  effective?: number;
  expires?: number;
  mediaPoints: Scte224MediaPoint[];
}

export interface Scte224Document {
  id?: string;
  description?: string;
  media: Scte224Media[];
  policies: { id?: string; viewingPolicies: string[] }[];
}

export function isScte224(text: string): boolean {
  const head = text.slice(0, 4000);
  return /<(?:[\w-]+:)?(?:Media|MediaPoint|Policy)\b/.test(head) && /scte\.?224|urn:scte:224/i.test(head);
}

function date(v: unknown): number | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const t = Date.parse(String(v));
  return Number.isNaN(t) ? undefined : t;
}

/** ISO 8601 duration, the subset SCTE-224 uses. */
function duration(v: unknown): number | undefined {
  if (!v) return undefined;
  const m = /^P?(?:T)?(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(String(v).trim());
  if (!m) return undefined;
  const [, h, mi, s] = m;
  const n = (x?: string) => (x ? parseFloat(x) : 0);
  const total = n(h) * 3600 + n(mi) * 60 + n(s);
  return total > 0 ? total : undefined;
}

function arr<T>(v: T | T[] | undefined): T[] {
  return v === undefined || v === null ? [] : Array.isArray(v) ? v : [v];
}

function text(node: unknown): string | undefined {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (node && typeof node === "object") {
    const t = (node as Record<string, unknown>)["#text"];
    if (t !== undefined) return String(t);
  }
  return undefined;
}

export function parseScte224(xml: string): Scte224Document {
  const doc = parser.parse(xml) as Record<string, unknown>;
  const root = (doc.Media ?? doc.MediaList ?? doc.Audience ?? doc) as Record<string, unknown>;

  const mediaNodes = arr(
    (doc.Media ?? (root as Record<string, unknown>).Media) as Record<string, unknown>[] | undefined,
  );

  const media: Scte224Media[] = mediaNodes.map((m) => ({
    id: m["@id"] as string | undefined,
    source: m["@source"] as string | undefined,
    effective: date(m["@effective"]),
    expires: date(m["@expires"]),
    mediaPoints: arr(m.MediaPoint as Record<string, unknown>[] | undefined).map((p) => {
      const signalNodes = arr(p.Signal as Record<string, unknown>[] | undefined);
      let signal: SpliceInfoSection | undefined;
      let signalError: string | undefined;
      const signalPointIds: string[] = [];

      for (const sig of signalNodes) {
        for (const key of ["Binary", "SCTE35", "SpliceInfoSection"]) {
          const raw = text(sig[key]);
          if (!raw) continue;
          try {
            signal = parseSpliceInfoSection(raw);
          } catch (e) {
            signalError = e instanceof Error ? e.message : String(e);
          }
        }
        for (const spid of arr(sig.SignalPointID as unknown[] | undefined)) {
          const v = text(spid) ?? (spid as Record<string, unknown>)?.["@id"];
          if (v) signalPointIds.push(String(v));
        }
      }

      return {
        id: p["@id"] as string | undefined,
        effective: date(p["@effective"]),
        expires: date(p["@expires"]),
        matchTime: date(p["@matchTime"] ?? p["@matchDateTime"]),
        matchOffset: duration(p["@matchOffset"]),
        expectedDuration: duration(p["@expectedDuration"]),
        source: p["@source"] as string | undefined,
        signal,
        signalError,
        signalPointIds,
        applies: arr(p.Apply as Record<string, unknown>[] | undefined)
          .map((a) => String(a["@policy"] ?? text(a.Policy) ?? ""))
          .filter(Boolean),
        removes: arr(p.Remove as Record<string, unknown>[] | undefined)
          .map((a) => String(a["@policy"] ?? text(a.Policy) ?? ""))
          .filter(Boolean),
      };
    }),
  }));

  return {
    id: (root["@id"] as string | undefined) ?? undefined,
    description: (root["@description"] as string | undefined) ?? undefined,
    media,
    policies: arr(doc.Policy as Record<string, unknown>[] | undefined).map((pol) => ({
      id: pol["@id"] as string | undefined,
      viewingPolicies: arr(pol.ViewingPolicy as Record<string, unknown>[] | undefined).map((v) =>
        String(v["@id"] ?? text(v) ?? ""),
      ),
    })),
  };
}

/** UPID of the first segmentation descriptor, for matching a point to a break. */
function upidOf(section: SpliceInfoSection | undefined): string | undefined {
  const d = section?.descriptors.find((x) => x.tag === 0x02 && "typeId" in x) as
    | { upidText: string; upidHex: string }
    | undefined;
  if (!d) return undefined;
  return d.upidText || d.upidHex || undefined;
}

function typeIdOf(section: SpliceInfoSection | undefined): number | undefined {
  const d = section?.descriptors.find((x) => x.tag === 0x02 && "typeId" in x) as
    | { typeId: number }
    | undefined;
  return d?.typeId;
}

/** How far apart a policy point and a stream signal can be and still be the same event. */
const MATCH_WINDOW_MS = 10_000;

export interface Scte224Comparison {
  document: Scte224Document;
  matched: { point: Scte224MediaPoint; breakIndex: number; driftSeconds?: number }[];
  unmatchedPoints: Scte224MediaPoint[];
  unmatchedBreaks: AdBreak[];
  findings: Finding[];
}

/**
 * Lines a policy document up against the signals a stream carries.
 *
 * A MediaPoint that never matches anything is a policy that will not fire; a
 * signal with no policy is an event nobody decided what to do about.
 */
export function compareScte224(
  doc: Scte224Document,
  breaks: AdBreak[],
  options: { now?: number; label?: string } = {},
): Scte224Comparison {
  const now = options.now ?? Date.now();
  const findings: Finding[] = [];
  const add = (severity: Severity, code: string, title: string, detail: string, extra: Partial<Finding> = {}) =>
    findings.push({ severity, code, title, detail, rendition: options.label, ...extra });

  const points = doc.media.flatMap((m) => m.mediaPoints);
  const matched: Scte224Comparison["matched"] = [];
  const usedBreaks = new Set<number>();

  for (const p of points) {
    if (p.signalError) {
      add(
        "error",
        "SCTE224_SIGNAL_UNDECODABLE",
        `MediaPoint ${p.id ?? "(unnamed)"} carries SCTE-35 that does not decode`,
        `The policy names a signal it cannot describe: ${p.signalError}. Nothing downstream can match this point to a stream.`,
      );
    }

    // Expired or not yet effective policy will not fire.
    if (p.expires !== undefined && p.expires < now) {
      add(
        "info",
        "SCTE224_POINT_EXPIRED",
        `MediaPoint ${p.id ?? "(unnamed)"} expired ${new Date(p.expires).toISOString()}`,
        "This point is in the document but past its expiry, so it governs nothing. Stale points accumulating in a policy feed make it hard to see what is actually in force.",
      );
      continue;
    }
    if (p.effective !== undefined && p.effective > now + 86_400_000) {
      add(
        "info",
        "SCTE224_POINT_FUTURE",
        `MediaPoint ${p.id ?? "(unnamed)"} does not take effect until ${new Date(p.effective).toISOString()}`,
        "Scheduled beyond the next day, so it is not expected to match anything in the current window.",
      );
      continue;
    }

    if (p.applies.length === 0 && p.removes.length === 0) {
      add(
        "warning",
        "SCTE224_POINT_NO_POLICY",
        `MediaPoint ${p.id ?? "(unnamed)"} applies and removes nothing`,
        "The point identifies a moment in the stream but attaches no policy to it, so nothing changes when it fires. Either a policy reference is missing or the point is dead weight.",
      );
    }

    // Match on UPID first, then on wall clock.
    const pointUpid = upidOf(p.signal);
    let index = -1;
    let drift: number | undefined;

    if (pointUpid) {
      index = breaks.findIndex((b, i) => !usedBreaks.has(i) && b.upid && b.upid === pointUpid);
    }
    if (index < 0 && p.matchTime !== undefined) {
      const target = p.matchTime + (p.matchOffset ?? 0) * 1000;
      let best = Infinity;
      breaks.forEach((b, i) => {
        if (usedBreaks.has(i) || b.pdt === undefined) return;
        const d = Math.abs(b.pdt - target);
        if (d < best) {
          best = d;
          index = i;
        }
      });
      if (index >= 0 && best <= MATCH_WINDOW_MS) drift = best / 1000;
      else index = -1;
    }

    if (index < 0) {
      add(
        "warning",
        "SCTE224_POINT_UNMATCHED",
        `MediaPoint ${p.id ?? "(unnamed)"} matches nothing in the stream`,
        `The policy expects ${pointUpid ? `a signal with UPID ${pointUpid}` : p.matchTime ? `a signal at ${new Date(p.matchTime).toISOString()}` : "a signal"}, and the stream carries none. The policy will not fire: whatever it was meant to do — a blackout, an alternate feed — does not happen.`,
      );
      continue;
    }

    usedBreaks.add(index);
    matched.push({ point: p, breakIndex: index, driftSeconds: drift });
    const b = breaks[index];

    // The point may state which segmentation type it governs.
    const pointType = typeIdOf(p.signal);
    if (pointType !== undefined && b.segmentationTypeId !== undefined && pointType !== b.segmentationTypeId) {
      add(
        "warning",
        "SCTE224_TYPE_MISMATCH",
        `MediaPoint ${p.id ?? "(unnamed)"} expects ${SEGMENTATION_TYPES[pointType] ?? "0x" + pointType.toString(16)} but the stream signals ${b.segmentationType}`,
        "The policy and the stream describe the same moment as different kinds of event. Systems keyed on segmentation type will not apply this policy.",
        { breakIndex: index },
      );
    }

    if (
      p.expectedDuration !== undefined &&
      b.signalledDuration !== undefined &&
      Math.abs(p.expectedDuration - b.signalledDuration) > 0.5
    ) {
      add(
        "warning",
        "SCTE224_DURATION_MISMATCH",
        `MediaPoint ${p.id ?? "(unnamed)"} expects ${p.expectedDuration}s but the stream signals ${b.signalledDuration}s`,
        "The policy was written for a different length of event than the stream is signalling. Alternate content scheduled against the policy will not fit the avail.",
        { breakIndex: index },
      );
    }

    if (drift !== undefined && drift > 1) {
      add(
        "info",
        "SCTE224_MATCH_DRIFT",
        `MediaPoint ${p.id ?? "(unnamed)"} matched a signal ${drift.toFixed(1)}s away`,
        "Matched on wall clock rather than exactly. A policy feed and a stream drifting apart is usually a scheduling system working from a different clock.",
        { breakIndex: index },
      );
    }
  }

  const unmatchedBreaks = breaks.filter((_, i) => !usedBreaks.has(i));
  if (points.length > 0 && unmatchedBreaks.length > 0) {
    add(
      "info",
      "SCTE224_SIGNAL_NOT_GOVERNED",
      `${unmatchedBreaks.length} signal(s) in the stream have no MediaPoint`,
      "The stream signals events the policy document says nothing about. That is normal where the policy only governs some events — a blackout schedule does not cover every ad break — but it means nothing decides what happens at these.",
    );
  }

  return {
    document: doc,
    matched,
    unmatchedPoints: points.filter((p) => !matched.some((m) => m.point === p)),
    unmatchedBreaks,
    findings,
  };
}
