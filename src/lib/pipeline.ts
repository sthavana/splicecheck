/**
 * Compare the signalling feed going into an ad-insertion service with the
 * stitched output coming out of it, and say whether the service did its job.
 *
 * This is the question operations teams actually argue about. The encoder team
 * says the SCTE-35 was correct; the ad-tech team says the break never arrived.
 * Both are looking at different streams, and nothing puts the two side by side.
 *
 * Alignment is on wall clock — EXT-X-PROGRAM-DATE-TIME in HLS,
 * availabilityStartTime plus period start in DASH — so the source and the
 * output do not have to be the same protocol. A DASH packager feeding an HLS
 * output is a normal deployment and compares fine.
 */

import type { AdBreak, Finding, RenditionAnalysis, Severity } from "./analyze";
import type { RunResult } from "./runner";

/** How far apart two breaks can start and still be considered the same avail. */
const MATCH_WINDOW_S = 6;
/** Fill difference below this is rounding, not a fault. */
const FILL_TOLERANCE_S = 0.5;
/** Start-time difference below this is not worth reporting. */
const ALIGN_TOLERANCE_S = 0.5;

export type AvailStatus =
  | "filled"
  | "under-filled"
  | "over-filled"
  | "not-stitched"
  | "passthrough"
  | "unsignalled"
  | "unmeasurable";

export interface AvailComparison {
  index: number;
  /** wall clock of the avail, epoch ms */
  pdt?: number;
  eventId?: number;
  segmentationType?: string;
  /** what the source said the avail would be */
  signalledDuration?: number;
  /** what the output actually devotes to it */
  stitchedDuration?: number;
  /** stitched minus signalled, seconds */
  delta?: number;
  /** proportion of the signalled avail the output actually fills */
  fillRatio?: number;
  /** difference in start time between source and output, seconds */
  alignmentDelta?: number;
  status: AvailStatus;
  /** the output's media inside the avail differs from its own surrounding content */
  substituted?: boolean;
  /** the output marks the splice with a discontinuity or a period boundary */
  marked?: boolean;
  note?: string;
}

export interface PipelineComparison {
  source: { uri: string; protocol: string; label: string; breakCount: number };
  stitched: { uri: string; protocol: string; label: string; breakCount: number };
  avails: AvailComparison[];
  findings: Finding[];
  summary: {
    signalled: number;
    filled: number;
    notStitched: number;
    underFilled: number;
    overFilled: number;
    passthrough: number;
    unsignalled: number;
    /** signalled avail seconds that the output actually fills */
    signalledSeconds: number;
    stitchedSeconds: number;
    fillRate: number;
    verdict: "pass" | "warn" | "fail";
  };
}

function fmt(n: number | undefined, d = 2): string {
  return n === undefined ? "—" : n.toFixed(d).replace(/\.?0+$/, "");
}

/**
 * Reduce a media URI to the shape of its path, so segments from the same
 * source collapse together and ad segments from elsewhere do not.
 * Segments "ad-svc/creative-42/seg_0007.ts" and "ad-svc/creative-42/seg_0008.ts"
 * collapse to the same shape, with every run of digits replaced by a wildcard.
 */
function mediaShape(uri: string): string {
  let u = uri;
  try {
    if (/^https?:\/\//.test(uri)) u = new URL(uri).pathname;
  } catch {
    /* relative URI, use as-is */
  }
  return u.replace(/\d+/g, "*").replace(/\$\w+\$/g, "*");
}

function shapes(uris: string[] | undefined): Set<string> {
  return new Set((uris ?? []).map(mediaShape));
}

/** Did the output substitute different media inside the avail than around it? */
function detectSubstitution(
  breakUris: string[] | undefined,
  contentUris: string[] | undefined,
): boolean | undefined {
  const inside = shapes(breakUris);
  const outside = shapes(contentUris);
  if (inside.size === 0 || outside.size === 0) return undefined;
  const overlap = [...inside].filter((x) => outside.has(x)).length;
  // Substitution means the avail's media does not look like the surrounding
  // programme. Any overlap at all means at least some of it was passed through.
  return overlap === 0;
}

function primary(r: RunResult): RenditionAnalysis | undefined {
  return r.renditions[0];
}

/** Wall clock is the only thing two different services reliably share. */
function clockOf(b: AdBreak): number | undefined {
  return b.pdt;
}

export function comparePipeline(
  source: RunResult,
  stitched: RunResult,
  labels: { source?: string; stitched?: string } = {},
): PipelineComparison {
  const findings: Finding[] = [];
  const add = (severity: Severity, code: string, title: string, detail: string, extra: Partial<Finding> = {}) =>
    findings.push({ severity, code, title, detail, ...extra });

  const src = primary(source);
  const out = primary(stitched);
  const sourceLabel = labels.source ?? "source";
  const stitchedLabel = labels.stitched ?? "output";

  const srcBreaks = (src?.breaks ?? []).filter((b) => !b.windowClipped);
  const outBreaks = (out?.breaks ?? []).filter((b) => !b.windowClipped);

  const srcHasClock = srcBreaks.every((b) => clockOf(b) !== undefined);
  const outHasClock = outBreaks.every((b) => clockOf(b) !== undefined);

  if (!srcHasClock || !outHasClock) {
    add(
      "error",
      "NO_COMMON_CLOCK",
      "The two streams cannot be aligned",
      `Comparing a signalling feed with its stitched output requires a shared wall clock — EXT-X-PROGRAM-DATE-TIME in HLS, availabilityStartTime in DASH. ${
        !srcHasClock ? `The ${sourceLabel} does not carry one. ` : ""
      }${!outHasClock ? `The ${stitchedLabel} does not carry one.` : ""} Without it there is no way to know which avail in one stream corresponds to which in the other.`,
    );
  }

  // Compare only the wall-clock range both streams actually cover. This must
  // come from the media window, not from where the breaks happen to be: if it
  // came from the breaks, an avail missing from the end of the output would
  // shrink the window until it excluded itself, and the failure would be
  // silently hidden — exactly the case this tool exists to catch.
  const mediaWindow = (r: RenditionAnalysis | undefined) =>
    r?.stats.windowStartPdt !== undefined && r.stats.windowEndPdt !== undefined
      ? { start: r.stats.windowStartPdt, end: r.stats.windowEndPdt }
      : undefined;
  const sWindow = mediaWindow(src);
  const oWindow = mediaWindow(out);
  const overlapStart = sWindow && oWindow ? Math.max(sWindow.start, oWindow.start) : undefined;
  const overlapEnd = sWindow && oWindow ? Math.min(sWindow.end, oWindow.end) : undefined;

  if (overlapStart !== undefined && overlapEnd !== undefined && overlapEnd <= overlapStart) {
    add(
      "error",
      "NO_OVERLAPPING_WINDOW",
      "The two streams cover different times",
      `The ${sourceLabel} covers ${new Date(sWindow!.start).toISOString()} to ${new Date(sWindow!.end).toISOString()} and the ${stitchedLabel} covers ${new Date(oWindow!.start).toISOString()} to ${new Date(oWindow!.end).toISOString()}. They do not overlap, so no avail appears in both. Check that both URLs are the same channel and that neither is far behind the other.`,
    );
  }

  const comparable = (b: AdBreak) => {
    const t = clockOf(b);
    if (t === undefined || overlapStart === undefined || overlapEnd === undefined) return true;
    // An avail must start early enough that its whole extent could be observed.
    const extent = (b.signalledDuration ?? b.actualDuration ?? 0) * 1000;
    return t >= overlapStart && t + extent <= overlapEnd + MATCH_WINDOW_S * 1000;
  };

  const srcInWindow = srcBreaks.filter(comparable);
  const outInWindow = outBreaks.filter(comparable);

  const avails: AvailComparison[] = [];
  const usedOutput = new Set<AdBreak>();

  srcInWindow.forEach((sb, index) => {
    const t = clockOf(sb);
    const candidates = outInWindow
      .filter((ob) => !usedOutput.has(ob))
      .map((ob) => ({ ob, d: t !== undefined && clockOf(ob) !== undefined ? Math.abs(clockOf(ob)! - t) / 1000 : Infinity }))
      .sort((a, b) => a.d - b.d);
    const match = candidates[0] && candidates[0].d <= MATCH_WINDOW_S ? candidates[0] : undefined;

    const signalled = sb.signalledDuration ?? sb.actualDuration;
    const a: AvailComparison = {
      index,
      pdt: t,
      eventId: sb.eventId,
      segmentationType: sb.segmentationType,
      signalledDuration: signalled,
      status: "not-stitched",
    };

    if (!match) {
      a.status = "not-stitched";
      add(
        "error",
        "AVAIL_NOT_STITCHED",
        `Avail ${index} was signalled but never appears in the ${stitchedLabel}`,
        `The ${sourceLabel} signals ${fmt(signalled)}s${sb.eventId !== undefined ? ` (event ${sb.eventId})` : ""} at ${
          t ? new Date(t).toISOString() : "an unknown time"
        }, and no break within ${MATCH_WINDOW_S}s of it exists in the ${stitchedLabel}. Viewers see programme content where an ad should have run: no impression, no revenue, and nothing in the delivery logs to show it happened.`,
        { breakIndex: index, atTime: sb.startTime },
      );
      avails.push(a);
      return;
    }

    usedOutput.add(match.ob);
    const ob = match.ob;
    const stitchedDuration = ob.actualDuration ?? ob.signalledDuration;
    a.stitchedDuration = stitchedDuration;
    a.alignmentDelta = match.d;
    a.marked = ob.discontinuityAtStart || ob.periodId !== undefined;
    a.substituted = detectSubstitution(ob.mediaUris, out?.contentMediaUris);

    if (match.d > ALIGN_TOLERANCE_S) {
      add(
        "error",
        "STITCH_MISALIGNED",
        `Avail ${index} starts ${fmt(match.d)}s later in the ${stitchedLabel} than it was signalled`,
        `The splice point moved between the ${sourceLabel} and the ${stitchedLabel}. The ad starts part-way over programme content and the return lands in the wrong place — the classic symptom is the last second of the show playing under the first ad.`,
        { breakIndex: index, atTime: sb.startTime },
      );
    }

    if (a.substituted === false) {
      a.status = "passthrough";
      add(
        "error",
        "AVAIL_PASSED_THROUGH",
        `Avail ${index} exists in the ${stitchedLabel} but nothing was substituted into it`,
        `A break is present at the right time, but the media inside it has the same shape as the programme content around it — the ad service opened the avail and filled it with the underlying feed. This is the failure that looks healthy from every angle except revenue: the manifest is well-formed, the player is happy, and no ad was delivered.`,
        { breakIndex: index, atTime: sb.startTime },
      );
    }

    if (stitchedDuration === undefined || signalled === undefined) {
      a.status = "unmeasurable";
      a.note = "still open at the live edge";
    } else {
      const delta = stitchedDuration - signalled;
      a.delta = delta;
      a.fillRatio = signalled > 0 ? stitchedDuration / signalled : undefined;
      if (a.status !== "passthrough") {
        if (Math.abs(delta) <= FILL_TOLERANCE_S) {
          a.status = "filled";
        } else if (delta < 0) {
          a.status = "under-filled";
          add(
            "warning",
            "AVAIL_UNDER_FILLED",
            `Avail ${index} is ${fmt(Math.abs(delta))}s short of the ${fmt(signalled)}s that was signalled`,
            `The ${stitchedLabel} devotes ${fmt(stitchedDuration)}s to an avail signalled as ${fmt(signalled)}s — ${Math.round((a.fillRatio ?? 0) * 100)}% filled. The ad decision server did not return enough creative to cover the break, so the tail is slate, black, or an early return to content. Repeated under-fill is unsold or unfilled inventory and is directly measurable as lost revenue.`,
            { breakIndex: index, atTime: sb.startTime },
          );
        } else {
          a.status = "over-filled";
          add(
            "warning",
            "AVAIL_OVER_FILLED",
            `Avail ${index} runs ${fmt(delta)}s longer than the ${fmt(signalled)}s that was signalled`,
            `The ${stitchedLabel} devotes ${fmt(stitchedDuration)}s to an avail signalled as ${fmt(signalled)}s. The pod overruns the break, so the return to programme is late and the first moments of content after the break are cut.`,
            { breakIndex: index, atTime: sb.startTime },
          );
        }
      }
    }

    if (a.marked === false) {
      add(
        "warning",
        "STITCH_NOT_MARKED",
        `Avail ${index} is not marked as a discontinuity in the ${stitchedLabel}`,
        `Content was substituted but the splice is not marked with EXT-X-DISCONTINUITY or a period boundary. The ad almost certainly has a different encode and timestamp base than the programme, and players without a discontinuity glitch, stall, or drop audio at the splice.`,
        { breakIndex: index, atTime: sb.startTime },
      );
    }

    avails.push(a);
  });

  // Breaks in the output that nothing upstream asked for.
  for (const ob of outInWindow) {
    if (usedOutput.has(ob)) continue;
    const t = clockOf(ob);
    avails.push({
      index: avails.length,
      pdt: t,
      eventId: ob.eventId,
      stitchedDuration: ob.actualDuration ?? ob.signalledDuration,
      status: "unsignalled",
      marked: ob.discontinuityAtStart || ob.periodId !== undefined,
    });
    add(
      "warning",
      "UNSIGNALLED_AVAIL_IN_OUTPUT",
      `The ${stitchedLabel} contains a break at ${t ? new Date(t).toISOString() : "an unknown time"} that was never signalled`,
      `A break exists in the output with no corresponding avail in the ${sourceLabel}. Either the ad service is inserting on its own schedule, or the upstream signal was lost before this comparison window. Content is being replaced that nobody upstream asked to replace.`,
      { atTime: ob.startTime },
    );
  }

  // Does the output still carry the SCTE-35 it consumed?
  const outStillSignals = outInWindow.filter((b) => b.signal?.ok).length;
  if (outStillSignals > 0 && srcInWindow.length > 0) {
    add(
      "info",
      "SIGNAL_PASSED_THROUGH",
      `The ${stitchedLabel} still carries decodable SCTE-35`,
      `${outStillSignals} break(s) in the output retain their SCTE-35. That is correct when the output feeds another insertion tier, and wrong when it feeds players directly — a downstream service reading it will insert a second time into a break that is already filled.`,
    );
  }

  const signalledSeconds = avails
    .filter((a) => a.status !== "unsignalled")
    .reduce((n, a) => n + (a.signalledDuration ?? 0), 0);
  const stitchedSeconds = avails
    .filter((a) => a.status !== "unsignalled" && a.status !== "passthrough")
    .reduce((n, a) => n + (a.stitchedDuration ?? 0), 0);

  const count = (s: AvailStatus) => avails.filter((a) => a.status === s).length;
  const notStitched = count("not-stitched");
  const passthrough = count("passthrough");
  const errors = findings.filter((f) => f.severity === "error").length;
  const warnings = findings.filter((f) => f.severity === "warning").length;

  return {
    source: {
      uri: source.sourceUri,
      protocol: src?.protocol ?? "?",
      label: sourceLabel,
      breakCount: srcBreaks.length,
    },
    stitched: {
      uri: stitched.sourceUri,
      protocol: out?.protocol ?? "?",
      label: stitchedLabel,
      breakCount: outBreaks.length,
    },
    avails,
    findings,
    summary: {
      signalled: avails.filter((a) => a.status !== "unsignalled").length,
      filled: count("filled"),
      notStitched,
      underFilled: count("under-filled"),
      overFilled: count("over-filled"),
      passthrough,
      unsignalled: count("unsignalled"),
      signalledSeconds,
      stitchedSeconds,
      fillRate: signalledSeconds > 0 ? stitchedSeconds / signalledSeconds : 0,
      verdict: errors > 0 ? "fail" : warnings > 0 ? "warn" : "pass",
    },
  };
}
