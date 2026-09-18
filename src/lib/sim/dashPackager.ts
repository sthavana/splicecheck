/**
 * The packaging stage in DASH.
 *
 * The same timeline and the same signalling, expressed the other way the
 * industry does it. The differences matter: HLS marks a break with tags between
 * segments, while DASH either carries an Event in a Period-level EventStream or
 * splits the presentation into separate Periods — and the second of those is
 * how SSAI output almost always looks.
 *
 * Period splitting is why DASH ad insertion has a failure mode HLS does not:
 * adjacent Periods with identical Representations still make many players
 * re-initialise their decoder unless the manifest says the timeline is
 * continuous across the boundary.
 */

import type { Timeline } from "./timeline";

export interface DashSpec {
  /** Seconds. How long a client should wait before re-fetching. */
  minimumUpdatePeriod?: number;
  timeShiftBufferDepth?: number;
  /** Split the presentation at every avail, as a stitched output does. */
  multiPeriod: boolean;
  /** Declare period continuity across the splices. */
  periodContinuity?: boolean;
  /** Carry the SCTE-35 in a Period-level EventStream. */
  emitEventStream?: boolean;
  faults?: {
    /** Leave a hole between the end of one Period and the start of the next. */
    periodGap?: boolean;
    /** Omit @presentationTimeOffset, so the segment numbering means nothing. */
    dropPresentationTimeOffset?: boolean;
    /**
     * The ad Period absorbs everything after it and no end event is written:
     * the presentation never returns to programme. This is the DASH shape of a
     * lost return — there is no CUE-IN to drop, so the failure appears as a
     * Period that keeps growing past the duration its avail declared.
     */
    availNeverReturns?: boolean;
  };
}

const TIMESCALE = 90000;

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** xs:duration, which is not seconds and not ISO time. */
function xsDuration(sec: number): string {
  return `PT${sec.toFixed(3).replace(/\.?0+$/, "")}S`;
}

interface PeriodPlan {
  id: string;
  startSec: number;
  durationSec: number;
  isAd: boolean;
  availId?: number;
  segments: Timeline["segments"];
}

function planPeriods(tl: Timeline, spec: DashSpec, from: number, count: number): PeriodPlan[] {
  const slice = tl.segments.slice(from, from + count);
  if (!spec.multiPeriod) {
    return [
      {
        id: "p0",
        startSec: slice[0]?.startSec ?? 0,
        durationSec: slice.reduce((n, s) => n + s.durationSec, 0),
        isAd: false,
        segments: slice,
      },
    ];
  }

  const periods: PeriodPlan[] = [];
  let run: Timeline["segments"] = [];
  let runAvail: number | undefined;
  const neverReturns = spec.faults?.availNeverReturns === true;
  let stuckInAvail = false;
  const flush = () => {
    if (run.length === 0) return;
    periods.push({
      id: `p${periods.length}`,
      startSec: run[0].startSec,
      durationSec: run.reduce((n, s) => n + s.durationSec, 0),
      isAd: runAvail !== undefined,
      availId: runAvail,
      segments: run,
    });
    run = [];
  };
  for (const s of slice) {
    // Once the avail has started and the return is lost, every following
    // segment stays inside the ad Period rather than opening a new one.
    if (stuckInAvail) {
      run.push(s);
      continue;
    }
    if (s.availId !== runAvail) {
      flush();
      runAvail = s.availId;
      if (neverReturns && runAvail !== undefined) stuckInAvail = true;
    }
    run.push(s);
  }
  flush();
  return periods;
}

export interface DashOutput {
  text: string;
  uri: string;
  periods: PeriodPlan[];
}

export function writeMpd(
  tl: Timeline,
  spec: DashSpec,
  opts: { from?: number; count?: number; uri?: string } = {},
): DashOutput {
  const from = opts.from ?? 0;
  const count = opts.count ?? tl.segments.length - from;
  const periods = planPeriods(tl, spec, from, count);
  const faults = spec.faults ?? {};
  const availabilityStart = tl.spec.startEpochMs;

  const lines: string[] = [
    '<?xml version="1.0" encoding="utf-8"?>',
    `<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" xmlns:scte35="urn:scte:scte35:2014:xml+bin"`,
    `     profiles="urn:mpeg:dash:profile:isoff-live:2011" type="dynamic"`,
    `     availabilityStartTime="${iso(availabilityStart)}" publishTime="${iso(availabilityStart + (tl.segments[from + count - 1]?.startSec ?? 0) * 1000)}"`,
    `     minimumUpdatePeriod="${xsDuration(spec.minimumUpdatePeriod ?? tl.spec.segmentSeconds)}"`,
    `     timeShiftBufferDepth="${xsDuration(spec.timeShiftBufferDepth ?? 60)}"`,
    `     minBufferTime="PT4S">`,
  ];

  let drift = 0;
  for (const p of periods) {
    // A gap is written by starting the next Period later than the previous one
    // ended, which is exactly what a packager does when it mis-computes a splice.
    if (faults.periodGap && p.isAd) drift += tl.spec.segmentSeconds / 2;
    const startSec = p.startSec + drift;

    lines.push(`  <Period id="${p.id}" start="${xsDuration(startSec)}" duration="${xsDuration(p.durationSec)}">`);

    if (p.isAd) {
      lines.push(`    <AssetIdentifier schemeIdUri="urn:org:dashif:asset-id:2013" value="ad-break-${p.availId}"/>`);
    }
    // Continuity is what lets a player carry its buffer and decoder across the
    // splice instead of re-initialising at every ad transition.
    if (spec.periodContinuity && periods.indexOf(p) > 0) {
      lines.push(`    <SupplementalProperty schemeIdUri="urn:mpeg:dash:period-continuity:2015" value="${periods[0].id}"/>`);
    }

    if (spec.emitEventStream) {
      const signals = tl.signals.filter(
        (s) =>
          s.mediaSec >= p.startSec &&
          s.mediaSec < p.startSec + p.durationSec &&
          !(faults.availNeverReturns && s.kind === "in"),
      );
      if (signals.length) {
        lines.push(`    <EventStream schemeIdUri="urn:scte:scte35:2014:xml+bin" timescale="${TIMESCALE}">`);
        for (const s of signals) {
          const pt = Math.round((s.mediaSec - p.startSec) * TIMESCALE);
          lines.push(
            `      <Event presentationTime="${pt}"${s.durationSec ? ` duration="${Math.round(s.durationSec * TIMESCALE)}"` : ""} id="${s.availId}${s.kind === "in" ? 1 : 0}">`,
          );
          lines.push(`        <scte35:Signal><scte35:Binary>${s.base64}</scte35:Binary></scte35:Signal>`);
          lines.push(`      </Event>`);
        }
        lines.push(`    </EventStream>`);
      }
    }

    const pto = faults.dropPresentationTimeOffset ? undefined : Math.round(startSec * TIMESCALE);
    lines.push(`    <AdaptationSet mimeType="video/mp4" segmentAlignment="true" startWithSAP="1">`);
    lines.push(
      `      <SegmentTemplate timescale="${TIMESCALE}"${pto !== undefined ? ` presentationTimeOffset="${pto}"` : ""}` +
        ` initialization="${p.isAd ? "ad" : "content"}/$RepresentationID$/init.mp4"` +
        ` media="${p.isAd ? "ad" : "content"}/$RepresentationID$/$Time$.m4s">`,
    );
    lines.push(`        <SegmentTimeline>`);
    // Consecutive segments of the same duration collapse into one S with @r,
    // which is how a real timeline is written and what a reader has to expand.
    let i = 0;
    while (i < p.segments.length) {
      const d = Math.round(p.segments[i].durationSec * TIMESCALE);
      let r = 0;
      while (
        i + r + 1 < p.segments.length &&
        Math.round(p.segments[i + r + 1].durationSec * TIMESCALE) === d
      ) r++;
      const t = Math.round((p.segments[i].startSec + drift) * TIMESCALE);
      lines.push(`          <S t="${t}" d="${d}"${r > 0 ? ` r="${r}"` : ""}/>`);
      i += r + 1;
    }
    lines.push(`        </SegmentTimeline>`);
    lines.push(`      </SegmentTemplate>`);
    lines.push(`      <Representation id="v1" codecs="avc1.640028" width="1920" height="1080" bandwidth="5000000"/>`);
    lines.push(`      <Representation id="v2" codecs="avc1.64001f" width="1280" height="720" bandwidth="3000000"/>`);
    lines.push(`    </AdaptationSet>`);
    lines.push(`  </Period>`);
  }

  lines.push("</MPD>");
  return { text: lines.join("\n") + "\n", uri: opts.uri ?? "manifest.mpd", periods };
}
