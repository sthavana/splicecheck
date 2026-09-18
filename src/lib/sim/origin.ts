/**
 * The origin stage: a sliding window over the packaged timeline.
 *
 * The origin adds no signalling of its own. What it controls is what a client
 * can see at a given moment — how much history, how current the live edge is,
 * and whether the window is still advancing. Those are the things that make a
 * healthy stream look broken and a broken one look healthy.
 */

import { writeMediaPlaylist, type PackagerSpec } from "./packager";
import type { Timeline } from "./timeline";

export interface OriginSpec {
  /** Segments kept in the live window. */
  windowSegments: number;
  /** Where the live edge sits, as a segment index into the timeline. */
  liveEdgeIndex: number;
}

export interface OriginFaults {
  /**
   * The window stops advancing while wall clock continues. The manifest stays
   * valid and self-consistent; it is simply old, which is the hardest live
   * failure to see from a manifest alone.
   */
  stalled?: boolean;
  /** A DVR window too short to hold a whole break. */
  shortWindow?: boolean;
}

export interface OriginResponse {
  text: string;
  uri: string;
  /** First segment index present in the window. */
  from: number;
  count: number;
  /** Wall clock of the newest segment in the window. */
  liveEdgeMs: number;
  /** How far the live edge is behind the requested moment. */
  behindSec: number;
}

export function serveMediaPlaylist(
  tl: Timeline,
  pkg: PackagerSpec,
  origin: OriginSpec,
  faults: OriginFaults = {},
): OriginResponse {
  const window = faults.shortWindow
    ? Math.max(2, Math.floor(origin.windowSegments / 3))
    : origin.windowSegments;

  // A stalled origin keeps serving the window it had when it stopped, so the
  // live edge falls behind by however long the stall has lasted.
  const edge = faults.stalled
    ? Math.max(window - 1, origin.liveEdgeIndex - Math.ceil(30 / tl.spec.segmentSeconds))
    : origin.liveEdgeIndex;

  const clampedEdge = Math.min(edge, tl.segments.length - 1);
  const from = Math.max(0, clampedEdge - window + 1);
  const count = Math.min(window, tl.segments.length - from);

  const pl = writeMediaPlaylist(tl, pkg, { from, count, uri: "index.m3u8" });
  const last = tl.segments[from + count - 1];
  const requested = tl.segments[Math.min(origin.liveEdgeIndex, tl.segments.length - 1)];

  return {
    text: pl.text,
    uri: pl.uri,
    from,
    count,
    liveEdgeMs: last.pdtMs + last.durationSec * 1000,
    behindSec: (requested.startSec - last.startSec) ,
  };
}
