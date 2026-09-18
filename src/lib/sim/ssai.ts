/**
 * The server-side ad insertion stage.
 *
 * SSAI rewrites the manifest per session: inside an avail it swaps programme
 * segments for ad segments, and leaves everything outside untouched. The
 * client sees one continuous stream and never learns an ad was there.
 *
 * The modes below are the outcomes the pipeline comparison already grades, so
 * each one is a way of producing a stream where something specific is wrong
 * while everything else stays plausible.
 */

import { fmt, iso, renderPlaylist, type OutSegment, type PackagerSpec } from "./packager";
import type { Timeline } from "./timeline";

export type StitchMode =
  | "fill"
  | "under-fill"
  | "over-fill"
  | "passthrough"
  | "drop-markers";

export interface Creative {
  id: string;
  advertiser: string;
  durationSec: number;
}

export interface SsaiSpec {
  mode: StitchMode;
  /** Ad segment duration. A pod whose segments do not divide the avail is normal. */
  adSegmentSeconds?: number;
  creatives?: Creative[];
  /** Strip the discontinuity the packager wrote at the splice. */
  dropDiscontinuity?: boolean;
  sessionId?: string;
  /**
   * Avails the service can actually see. An SSAI service reads the manifest,
   * not the encoder's timeline: an avail the packager never transcribed does
   * not exist as far as it is concerned, and the inventory is simply lost.
   */
  visibleAvailIds?: number[];
}

export interface StitchedAvail {
  availId: number;
  signalledSec: number;
  deliveredSec: number;
  creatives: { id: string; advertiser: string; durationSec: number }[];
  mode: StitchMode;
}

export interface StitchResult {
  text: string;
  uri: string;
  avails: StitchedAvail[];
  /** Beacons the ad service fires itself, because the client cannot see the ads. */
  beacons: { availId: number; creative: string; event: string; atSec: number }[];
}

const DEFAULT_CREATIVES: Creative[] = [
  { id: "creative-4417", advertiser: "Northbridge Motors", durationSec: 30 },
  { id: "creative-8820", advertiser: "Caldera Coffee", durationSec: 30 },
  { id: "creative-1163", advertiser: "Meridian Bank", durationSec: 30 },
];

/** How much of the avail each mode actually fills. */
function targetFill(mode: StitchMode, availSec: number): number {
  switch (mode) {
    case "under-fill":
      return Math.max(0, availSec - 30);
    case "over-fill":
      return availSec + 12;
    default:
      return availSec;
  }
}

/** Picks creatives until the pod reaches the target, as a decision service would. */
function buildPod(pool: Creative[], targetSec: number): Creative[] {
  const pod: Creative[] = [];
  let total = 0;
  let i = 0;
  while (total + 0.001 < targetSec && pool.length > 0) {
    const c = pool[i % pool.length];
    pod.push(c);
    total += c.durationSec;
    i++;
    if (i > 64) break;
  }
  return pod;
}

export function stitch(
  tl: Timeline,
  pkg: PackagerSpec,
  ssai: SsaiSpec,
  window: { from: number; count: number },
): StitchResult {
  const pool = ssai.creatives ?? DEFAULT_CREATIVES;
  const adSeg = ssai.adSegmentSeconds ?? tl.spec.segmentSeconds;
  const session = ssai.sessionId ?? "s-8f14e45f";
  const slice = tl.segments.slice(window.from, window.from + window.count);

  const stitched: StitchedAvail[] = [];
  const beacons: StitchResult["beacons"] = [];
  const out: OutSegment[] = [];

  let i = 0;
  while (i < slice.length) {
    const seg = slice[i];
    const visible = ssai.visibleAvailIds;
    const avail = tl.avails.find(
      (a) => a.id === seg.availId && (!visible || visible.includes(a.id)),
    );

    // Outside an avail, or in a mode that leaves the avail alone, the segment
    // passes through exactly as the packager wrote it.
    if (!avail || ssai.mode === "passthrough" || ssai.mode === "drop-markers") {
      const markers: string[] = [];
      const visibleHere = (a: { id: number }) => !visible || visible.includes(a.id);
      const opening = tl.avails.find((a) => a.snappedStartSec === seg.startSec && visibleHere(a));
      const closing = tl.avails.find(
        (a) => a.snappedStartSec + a.snappedDurationSec === seg.startSec && visibleHere(a),
      );
      // drop-markers models a service that consumed the signalling and then
      // failed to stitch: downstream, the break no longer exists at all.
      if (ssai.mode !== "drop-markers") {
        if (opening) markers.push(`#EXT-X-CUE-OUT:${fmt(opening.durationSec)}`);
        if (closing) markers.push("#EXT-X-CUE-IN");
      }
      // The avail spans several segments, so record it once.
      if (avail && ssai.mode === "passthrough" && !stitched.some((x) => x.availId === avail.id)) {
        stitched.push({
          availId: avail.id,
          signalledSec: avail.durationSec,
          deliveredSec: avail.snappedDurationSec,
          creatives: [],
          mode: ssai.mode,
        });
      }
      out.push({
        uri: seg.uri,
        durationSec: seg.durationSec,
        pdtMs: seg.pdtMs,
        discontinuity: seg.splicePoint && ssai.mode !== "drop-markers" && !ssai.dropDiscontinuity,
        markers,
      });
      i++;
      continue;
    }

    // An avail begins here: consume every programme segment inside it and emit
    // the pod in their place.
    const availSegments = [];
    while (i < slice.length && slice[i].availId === avail.id) {
      availSegments.push(slice[i]);
      i++;
    }
    const availStartPdt = availSegments[0].pdtMs;
    const target = targetFill(ssai.mode, avail.snappedDurationSec);
    const pod = buildPod(pool, target);
    const podSec = pod.reduce((n, c) => n + c.durationSec, 0);

    let cursor = 0;
    let first = true;
    for (const c of pod) {
      const segs = Math.max(1, Math.round(c.durationSec / adSeg));
      for (let k = 0; k < segs; k++) {
        const d = Math.min(adSeg, c.durationSec - k * adSeg);
        out.push({
          uri: `ads/${session}/${c.id}/seg_${String(k).padStart(5, "0")}.ts`,
          durationSec: d,
          pdtMs: availStartPdt + cursor * 1000,
          // Every creative is a different encode, so each one needs its own
          // discontinuity — not just the avail as a whole.
          discontinuity: (first || k === 0) && !ssai.dropDiscontinuity,
          markers: first
            ? [`#EXT-X-CUE-OUT:${fmt(avail.durationSec)}`]
            : [`#EXT-X-CUE-OUT-CONT:ELAPSED=${fmt(cursor)},DURATION=${fmt(avail.durationSec)}`],
        });
        cursor += d;
        first = false;
      }
      for (const [event, at] of [
        ["start", 0], ["firstQuartile", 0.25], ["midpoint", 0.5],
        ["thirdQuartile", 0.75], ["complete", 1],
      ] as const) {
        beacons.push({
          availId: avail.id,
          creative: c.id,
          event,
          atSec: avail.snappedStartSec + (cursor - c.durationSec) + c.durationSec * at,
        });
      }
    }

    // An under-fill returns to programme early, which is what makes the avail
    // measurably short downstream. Padding it back out to full length would be
    // a different failure — the break looks correct and only the revenue is
    // missing — so that is not what this mode models.
    if (ssai.mode !== "under-fill" && podSec < avail.snappedDurationSec - 0.001) {
      let remaining = avail.snappedDurationSec - podSec;
      for (const seg of availSegments) {
        if (remaining <= 0.001) break;
        const d = Math.min(seg.durationSec, remaining);
        out.push({
          uri: seg.uri,
          durationSec: d,
          pdtMs: availStartPdt + cursor * 1000,
          discontinuity: false,
          markers: [],
        });
        cursor += d;
        remaining -= d;
      }
    }

    stitched.push({
      availId: avail.id,
      signalledSec: avail.durationSec,
      deliveredSec: podSec,
      creatives: pod.map((c) => ({ id: c.id, advertiser: c.advertiser, durationSec: c.durationSec })),
      mode: ssai.mode,
    });

    // Return to programme.
    const next = slice[i];
    if (next) {
      out.push({
        uri: next.uri,
        durationSec: next.durationSec,
        pdtMs: next.pdtMs,
        discontinuity: !ssai.dropDiscontinuity,
        markers: ["#EXT-X-CUE-IN"],
      });
      i++;
    }
  }

  const text = renderPlaylist(out, {
    mediaSequence: window.from,
    discontinuitySequence: 0,
    targetDuration: Math.ceil(Math.max(tl.spec.segmentSeconds, adSeg)),
  });

  return { text, uri: `ssai/${session}/index.m3u8`, avails: stitched, beacons };
}

/** Wall clock helper shared with the UI. */
export { iso };
