/**
 * The packaging stage: turn a timeline and its signalling into HLS.
 *
 * A packager's whole job here is transcription — it re-states in manifest tags
 * what the encoder said in a binary section. Most ad-insertion faults in the
 * field are transcription faults, so the marker conventions and the ways of
 * getting them wrong are both modelled explicitly.
 */

import type { EncoderSignal, Timeline } from "./timeline";

/** The competing conventions for carrying SCTE-35 in HLS. */
export type MarkerStyle = "daterange" | "cue-out" | "both";

export interface PackagerFaults {
  /** Write the out marker but never the matching in. */
  dropCueIn?: boolean;
  /** Omit EXT-X-DISCONTINUITY at the splice points. */
  noDiscontinuity?: boolean;
  /** Transcribe no marker at all for this avail id — the inventory is simply lost. */
  untranscribedAvail?: number;
  /** Write the marker at the snapped boundary rather than the signalled instant. */
  roundToSegment?: boolean;
}

export interface PackagerSpec {
  markerStyle: MarkerStyle;
  faults?: PackagerFaults;
  /** Renditions for the master playlist. */
  variants?: { name: string; bandwidth: number; resolution: string }[];
}

export interface PackagedPlaylist {
  /** The full programme, before the origin windows it. */
  segments: Timeline["segments"];
  text: string;
  uri: string;
}

export const iso = (ms: number) => new Date(ms).toISOString();

export function fmt(n: number): string {
  return n.toFixed(3);
}

/** A segment as it will appear in an output playlist, with its preceding tags. */
export interface OutSegment {
  uri: string;
  durationSec: number;
  pdtMs: number;
  discontinuity: boolean;
  /** Tag lines written immediately before this segment. */
  markers: string[];
}

export interface RenderOptions {
  mediaSequence: number;
  discontinuitySequence: number;
  targetDuration: number;
  endList?: boolean;
  /** Write a PDT on every segment rather than only after a discontinuity. */
  pdtEverySegment?: boolean;
}

/**
 * Renders a media playlist from an explicit segment list.
 *
 * PDT is written on the first segment and after every discontinuity, which is
 * what packagers do in practice: players interpolate the rest, and repeating it
 * on every segment mostly makes the manifest harder to read.
 */
export function renderPlaylist(segments: OutSegment[], o: RenderOptions): string {
  const lines = [
    "#EXTM3U",
    "#EXT-X-VERSION:6",
    `#EXT-X-TARGETDURATION:${o.targetDuration}`,
    `#EXT-X-MEDIA-SEQUENCE:${o.mediaSequence}`,
    `#EXT-X-DISCONTINUITY-SEQUENCE:${o.discontinuitySequence}`,
  ];
  let pendingPdt = true;
  for (const seg of segments) {
    if (seg.discontinuity) {
      lines.push("#EXT-X-DISCONTINUITY");
      pendingPdt = true;
    }
    lines.push(...seg.markers);
    if (pendingPdt || o.pdtEverySegment) {
      lines.push(`#EXT-X-PROGRAM-DATE-TIME:${iso(seg.pdtMs)}`);
      pendingPdt = false;
    }
    lines.push(`#EXTINF:${fmt(seg.durationSec)},`);
    lines.push(seg.uri);
  }
  if (o.endList) lines.push("#EXT-X-ENDLIST");
  return lines.join("\n") + "\n";
}

/**
 * Renders a media playlist over a slice of the timeline.
 *
 * `from`/`count` let the origin ask for just its window without the packager
 * needing to know anything about DVR depth.
 */
export function writeMediaPlaylist(
  tl: Timeline,
  pkg: PackagerSpec,
  opts: { from?: number; count?: number; endList?: boolean; uri?: string } = {},
): PackagedPlaylist {
  const faults = pkg.faults ?? {};
  const from = opts.from ?? 0;
  const count = opts.count ?? tl.segments.length - from;
  const slice = tl.segments.slice(from, from + count);

  const signalFor = (availId: number, kind: "out" | "in"): EncoderSignal | undefined =>
    tl.signals.find((s) => s.availId === availId && s.kind === kind);

  const out: OutSegment[] = slice.map((seg) => {
    const markers: string[] = [];
    const opening = tl.avails.find((a) => a.snappedStartSec === seg.startSec);
    const closing = tl.avails.find(
      (a) => a.snappedStartSec + a.snappedDurationSec === seg.startSec,
    );
    const inside = tl.avails.find((a) => a.id === seg.availId);

    if (opening && faults.untranscribedAvail !== opening.id) {
      const sig = signalFor(opening.id, "out");
      // The marker carries the signalled instant unless the packager is
      // modelled as rounding it to the boundary it could actually splice on.
      const atMs =
        tl.spec.startEpochMs +
        (faults.roundToSegment ? opening.snappedStartSec : opening.startSec) * 1000;
      if (pkg.markerStyle !== "cue-out") {
        markers.push(
          `#EXT-X-DATERANGE:ID="${opening.id}",START-DATE="${iso(atMs)}",` +
            `PLANNED-DURATION=${fmt(opening.durationSec)},SCTE35-OUT=${sig?.hex ?? "0x"}`,
        );
      }
      if (pkg.markerStyle !== "daterange") {
        if (sig) markers.push(`#EXT-OATCLS-SCTE35:${sig.base64}`);
        markers.push(`#EXT-X-CUE-OUT:${fmt(opening.durationSec)}`);
      }
    } else if (inside && pkg.markerStyle !== "daterange" && faults.untranscribedAvail !== inside.id) {
      const elapsed = seg.startSec - inside.snappedStartSec;
      markers.push(
        `#EXT-X-CUE-OUT-CONT:ELAPSED=${fmt(elapsed)},DURATION=${fmt(inside.durationSec)}`,
      );
    }

    if (closing && !faults.dropCueIn && faults.untranscribedAvail !== closing.id) {
      const sig = signalFor(closing.id, "in");
      const atMs =
        tl.spec.startEpochMs +
        (faults.roundToSegment
          ? closing.snappedStartSec + closing.snappedDurationSec
          : closing.startSec + closing.durationSec) * 1000;
      if (pkg.markerStyle !== "cue-out") {
        markers.push(
          `#EXT-X-DATERANGE:ID="${closing.id}",START-DATE="${iso(atMs)}",SCTE35-IN=${sig?.hex ?? "0x"}`,
        );
      }
      if (pkg.markerStyle !== "daterange") {
        if (sig) markers.push(`#EXT-OATCLS-SCTE35:${sig.base64}`);
        markers.push("#EXT-X-CUE-IN");
      }
    }

    return {
      uri: seg.uri,
      durationSec: seg.durationSec,
      pdtMs: seg.pdtMs,
      discontinuity: seg.splicePoint && !faults.noDiscontinuity,
      markers,
    };
  });

  const discontinuitySequence = faults.noDiscontinuity
    ? 0
    : tl.segments.slice(0, from).filter((s) => s.splicePoint).length;

  const text = renderPlaylist(out, {
    mediaSequence: from,
    discontinuitySequence,
    targetDuration: Math.ceil(tl.spec.segmentSeconds),
    endList: opts.endList,
  });

  return { segments: slice, text, uri: opts.uri ?? "index.m3u8" };
}

export function writeMasterPlaylist(pkg: PackagerSpec, base = ""): string {
  const variants = pkg.variants ?? [
    { name: "1080p", bandwidth: 5_000_000, resolution: "1920x1080" },
    { name: "720p", bandwidth: 3_000_000, resolution: "1280x720" },
    { name: "480p", bandwidth: 1_200_000, resolution: "854x480" },
  ];
  const lines = ["#EXTM3U", "#EXT-X-VERSION:6"];
  for (const v of variants) {
    lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${v.bandwidth},RESOLUTION=${v.resolution}`);
    lines.push(`${base}${v.name}/index.m3u8`);
  }
  return lines.join("\n") + "\n";
}
