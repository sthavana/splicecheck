/**
 * Runs the whole chain and hands back what each stage produced.
 *
 * The point of the simulator is not the manifests on their own — it is that
 * the project's own analyser is pointed at them afterwards. A fault switched on
 * here has to show up as a finding there, without either side knowing about the
 * other. That makes the rules testable against streams whose ground truth is
 * known, which is not possible with somebody else's live channel.
 */

import { analyzeText, type RunResult } from "../runner";
import { comparePipeline, type PipelineComparison } from "../pipeline";
import { writeMasterPlaylist, writeMediaPlaylist, type MarkerStyle, type PackagerFaults, type PackagerSpec } from "./packager";
import { serveMediaPlaylist, type OriginFaults } from "./origin";
import { stitch, type SsaiSpec, type StitchMode, type StitchResult } from "./ssai";
import { buildTimeline, type ChannelSpec, type SignalStyle, type Timeline, type TimelineFaults } from "./timeline";
import { writeMpd, type DashSpec } from "./dashPackager";
import { runCsai, type CsaiResult, type CsaiSpec } from "./csai";

export interface SimConfig {
  segmentSeconds: number;
  /** Programme length modelled, in seconds. */
  durationSec: number;
  /** Avails as {startSec, durationSec}. */
  avails: { id: number; startSec: number; durationSec: number }[];
  signalStyle: SignalStyle;
  markerStyle: MarkerStyle;
  windowSegments: number;
  stitchMode: StitchMode;
  /** Which protocol the packager emits. */
  protocol: "hls" | "dash";
  /** Where the ad is spliced: in the manifest, or in the player. */
  adMode: "ssai" | "csai";
  dash?: Partial<DashSpec>;
  csai?: CsaiSpec;
  faults: TimelineFaults &
    PackagerFaults &
    OriginFaults & {
      dropDiscontinuity?: boolean;
      /** DASH: leave a hole between Periods. */
      periodGap?: boolean;
      /** DASH: omit @presentationTimeOffset. */
      dropPresentationTimeOffset?: boolean;
      /** DASH: do not declare continuity across the splices. */
      noPeriodContinuity?: boolean;
      /** DASH: the ad Period never ends and no end event is written. */
      availNeverReturns?: boolean;
      /** CSAI: the ad server does not answer in time. */
      adServerTimeout?: boolean;
      /** CSAI: the request never leaves the device. */
      adBlocked?: boolean;
      /** CSAI: the creative CDN does not deliver. */
      creativeFailsToLoad?: boolean;
    };
}

export const DEFAULT_CONFIG: SimConfig = {
  segmentSeconds: 6,
  durationSec: 600,
  avails: [
    { id: 1001, startSec: 120, durationSec: 90 },
    { id: 1002, startSec: 360, durationSec: 60 },
  ],
  signalStyle: "time_signal",
  markerStyle: "both",
  windowSegments: 30,
  stitchMode: "fill",
  protocol: "hls",
  adMode: "ssai",
  faults: {},
};

/** Media time zero. Fixed so a run is reproducible and diffable. */
export const EPOCH = Date.UTC(2026, 0, 1, 0, 0, 0);

export interface Stage {
  id: "encoder" | "packager" | "origin" | "ssai";
  title: string;
  /** One line on what this stage did to the stream. */
  note: string;
  /** The manifest as it leaves this stage, where the stage produces one. */
  text?: string;
  uri?: string;
}

export interface SimResult {
  config: SimConfig;
  timeline: Timeline;
  stages: Stage[];
  master: string;
  origin: { text: string; uri: string; from: number; count: number; behindSec: number };
  ssai: StitchResult;
  csai?: CsaiResult;
  /** Set when the packager emitted DASH. */
  mpd?: { text: string; uri: string };
  /** The project's own verdict on each side, and on the pair. */
  analysis: {
    origin: RunResult | { error: string };
    ssai: RunResult | { error: string };
    comparison: PipelineComparison | { error: string };
  };
}

function channelFrom(c: SimConfig): ChannelSpec {
  return {
    name: "Simulated channel",
    segmentSeconds: c.segmentSeconds,
    startEpochMs: EPOCH,
    // A non-zero PTS base is the normal case; zero would hide wrap and offset bugs.
    ptsBaseSeconds: 3600,
    durationSec: c.durationSec,
    avails: c.avails,
    signalStyle: c.signalStyle,
  };
}

export function runChain(config: SimConfig = DEFAULT_CONFIG): SimResult {
  const f = config.faults;
  const timeline = buildTimeline(channelFrom(config), {
    availOffBoundary: f.availOffBoundary,
    invalidCrc: f.invalidCrc,
  });

  const pkg: PackagerSpec = {
    markerStyle: config.markerStyle,
    faults: {
      dropCueIn: f.dropCueIn,
      noDiscontinuity: f.noDiscontinuity,
      untranscribedAvail: f.untranscribedAvail,
      roundToSegment: f.roundToSegment,
    },
  };

  const packaged = writeMediaPlaylist(timeline, pkg, { endList: true, uri: "packaged.m3u8" });
  const master = writeMasterPlaylist(pkg);

  const dashSpec: DashSpec = {
    multiPeriod: config.adMode === "ssai",
    periodContinuity: !f.noPeriodContinuity,
    emitEventStream: true,
    timeShiftBufferDepth: config.windowSegments * config.segmentSeconds,
    minimumUpdatePeriod: config.segmentSeconds,
    faults: {
      periodGap: f.periodGap,
      dropPresentationTimeOffset: f.dropPresentationTimeOffset,
      availNeverReturns: f.availNeverReturns,
    },
    ...config.dash,
  };

  // Put the live edge just past the last avail, so the window a client would
  // actually be watching contains a break rather than quiet programme.
  const lastAvail = timeline.avails[timeline.avails.length - 1];
  const liveEdgeIndex = lastAvail
    ? Math.min(
        timeline.segments.length - 1,
        // Leave a third of the window past the break. A break sitting right on
        // the edge is indistinguishable from one still in progress, which
        // would mask exactly the faults this is meant to expose.
        Math.ceil((lastAvail.snappedStartSec + lastAvail.snappedDurationSec) / config.segmentSeconds) +
          Math.floor(config.windowSegments / 3),
      )
    : timeline.segments.length - 1;
  const origin = serveMediaPlaylist(
    timeline,
    pkg,
    { windowSegments: config.windowSegments, liveEdgeIndex },
    { stalled: f.stalled, shortWindow: f.shortWindow },
  );

  // Window the SSAI over a slice that actually contains an avail, so the
  // stitching is visible rather than merely configured.
  const firstAvailIdx = timeline.segments.findIndex((s) => s.availId !== undefined);
  const from = Math.max(0, firstAvailIdx - 3);
  const count = Math.min(config.windowSegments, timeline.segments.length - from);

  const ssaiSpec: SsaiSpec = {
    mode: config.stitchMode,
    dropDiscontinuity: f.dropDiscontinuity,
    visibleAvailIds: timeline.avails
      .filter((a) => a.id !== f.untranscribedAvail)
      .map((a) => a.id),
  };
  const ssaiOut = stitch(timeline, pkg, ssaiSpec, { from, count });

  // In DASH the pipeline is single-period in, multi-period out: the packager
  // describes the avail with an Event, and the ad service splits the
  // presentation at it. Both sides are needed for the comparison to mean
  // anything, so both are written.
  const sourceMpd =
    config.protocol === "dash"
      ? writeMpd(timeline, { ...dashSpec, multiPeriod: false }, { from, count, uri: "source.mpd" })
      : undefined;
  const stitchedMpd =
    config.protocol === "dash" && config.adMode === "ssai"
      ? writeMpd(timeline, { ...dashSpec, multiPeriod: true }, { from, count, uri: "stitched.mpd" })
      : undefined;
  const mpd = stitchedMpd ?? sourceMpd;

  // Client-side insertion leaves the manifest alone, so there is no stitched
  // output to analyse — the whole event sequence happens in the player.
  const csai =
    config.adMode === "csai"
      ? runCsai(timeline, {
          adServerTimeout: f.adServerTimeout,
          blocked: f.adBlocked,
          creativeFailsToLoad: f.creativeFailsToLoad,
          ...config.csai,
        })
      : undefined;

  // The comparison needs both sides over the same window, or every avail
  // outside the overlap reads as missing.
  const sourceWindow = writeMediaPlaylist(timeline, pkg, { from, count, uri: "source.m3u8" });

  const safe = <T,>(fn: () => T): T | { error: string } => {
    try {
      return fn();
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  };

  const originAnalysis = safe(() =>
    sourceMpd
      ? analyzeText(sourceMpd.text, "sim://origin/manifest.mpd")
      : analyzeText(origin.text, "sim://origin/index.m3u8"),
  );
  const ssaiAnalysis = safe(() =>
    stitchedMpd
      ? analyzeText(stitchedMpd.text, "sim://ssai/stitched.mpd")
      : analyzeText(ssaiOut.text, "sim://ssai/index.m3u8"),
  );
  const sourceAnalysis = safe(() =>
    sourceMpd
      ? analyzeText(sourceMpd.text, "sim://packager/source.mpd")
      : analyzeText(sourceWindow.text, "sim://packager/index.m3u8"),
  );
  const comparison = config.adMode === "csai"
    ? { error: "Client-side insertion does not rewrite the manifest, so there is no stitched output to compare." }
    : "error" in sourceAnalysis
      ? sourceAnalysis
      : "error" in ssaiAnalysis
        ? ssaiAnalysis
        : safe(() =>
            comparePipeline(sourceAnalysis, ssaiAnalysis, {
              source: "packager output",
              stitched: "SSAI output",
            }),
          );

  const availCount = timeline.avails.length;
  const stages: Stage[] = [
    {
      id: "encoder",
      title: "Encoder",
      note:
        `${availCount} avail${availCount === 1 ? "" : "s"} signalled as ` +
        `${config.signalStyle}${f.invalidCrc ? ", with a corrupted CRC" : ""}. ` +
        `PTS base ${timeline.spec.ptsBaseSeconds}s.`,
    },
    {
      id: "packager",
      title: "Packaging",
      note:
        (config.protocol === "dash"
          ? `${config.adMode === "ssai" ? "Multi-period" : "Single-period"} MPD with an EventStream` +
            `${f.noPeriodContinuity ? ", no continuity declared" : ""}` +
            `${f.periodGap ? ", with a gap between Periods" : ""}.`
          : `Transcribed to ${config.markerStyle === "both" ? "DATERANGE and CUE-OUT" : config.markerStyle}` +
        `${f.dropCueIn ? ", omitting the CUE-IN" : ""}` +
            `${f.noDiscontinuity ? ", without discontinuities" : ""}.`),
      text: sourceMpd ? sourceMpd.text : packaged.text,
      uri: sourceMpd ? sourceMpd.uri : packaged.uri,
    },
    {
      id: "origin",
      title: "Origin",
      note:
        `${origin.count}-segment window at sequence ${origin.from}` +
        `${f.stalled ? `, stalled ${origin.behindSec.toFixed(0)}s behind live` : ""}` +
        `${f.shortWindow ? ", DVR shortened" : ""}.`,
      text: sourceMpd ? sourceMpd.text : origin.text,
      uri: sourceMpd ? sourceMpd.uri : origin.uri,
    },
    config.adMode === "csai"
      ? {
          id: "ssai",
          title: "CSAI",
          note: describeCsai(csai),
          text: csai?.vast,
          uri: "VAST response",
        }
      : {
          id: "ssai",
          title: "SSAI",
              note: stitchedMpd
            ? `Presentation split into ${stitchedMpd.periods.length} Periods at the avail boundaries.`
            : describeStitch(ssaiOut, config.stitchMode),
          text: stitchedMpd ? stitchedMpd.text : ssaiOut.text,
          uri: stitchedMpd ? stitchedMpd.uri : ssaiOut.uri,
        },
  ];

  return {
    config,
    timeline,
    csai,
    mpd: mpd ? { text: mpd.text, uri: mpd.uri } : undefined,
    stages,
    master,
    origin: { text: origin.text, uri: origin.uri, from: origin.from, count: origin.count, behindSec: origin.behindSec },
    ssai: ssaiOut,
    analysis: { origin: originAnalysis, ssai: ssaiAnalysis, comparison },
  };
}

function describeStitch(r: StitchResult, mode: StitchMode): string {
  if (mode === "drop-markers") return "Consumed the signalling and stitched nothing; the break is gone downstream.";
  if (mode === "passthrough") return "Left the avail as programme content; markers survive but no ad was inserted.";
  const a = r.avails[0];
  if (!a) return "No avail fell inside the session window.";
  const delta = a.deliveredSec - a.signalledSec;
  const word = Math.abs(delta) < 0.5 ? "exactly filling" : delta < 0 ? `${Math.abs(delta).toFixed(0)}s short of` : `${delta.toFixed(0)}s over`;
  return `${r.avails.reduce((n, x) => n + x.creatives.length, 0)} creatives stitched, ${word} the signalled avail.`;
}

function describeCsai(c: CsaiResult | undefined): string {
  if (!c) return "";
  if (c.outcome === "empty") return "No ad reached the screen; the programme played under the avail.";
  const pct = Math.round((c.deliveredSec / Math.max(1, c.signalledSec)) * 100);
  return `${c.deliveredSec}s of ${c.signalledSec}s played in the player (${pct}%), manifest untouched.`;
}
