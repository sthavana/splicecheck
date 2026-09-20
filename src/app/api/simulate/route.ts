import { NextRequest, NextResponse } from "next/server";
import { runChain, DEFAULT_CONFIG, type SimConfig } from "@/lib/sim/chain";

/** Bounds so a hand-edited request cannot ask for an enormous timeline. */
function sanitise(input: Partial<SimConfig>): SimConfig {
  const clamp = (n: unknown, lo: number, hi: number, dflt: number) =>
    typeof n === "number" && Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;

  const durationSec = clamp(input.durationSec, 60, 3600, DEFAULT_CONFIG.durationSec);
  const segmentSeconds = clamp(input.segmentSeconds, 1, 30, DEFAULT_CONFIG.segmentSeconds);

  const avails = (Array.isArray(input.avails) ? input.avails : DEFAULT_CONFIG.avails)
    .slice(0, 8)
    .map((a, i) => ({
      id: clamp(a?.id, 1, 0xffffffff, 1001 + i),
      startSec: clamp(a?.startSec, 0, durationSec, 120),
      durationSec: clamp(a?.durationSec, segmentSeconds, 600, 90),
    }))
    .filter((a) => a.startSec + a.durationSec <= durationSec);

  return {
    segmentSeconds,
    durationSec,
    avails: avails.length ? avails : DEFAULT_CONFIG.avails,
    signalStyle: input.signalStyle === "splice_insert" ? "splice_insert" : "time_signal",
    markerStyle:
      input.markerStyle === "daterange" || input.markerStyle === "cue-out" ? input.markerStyle : "both",
    windowSegments: clamp(input.windowSegments, 4, 200, DEFAULT_CONFIG.windowSegments),
    stitchMode: (["fill", "under-fill", "over-fill", "passthrough", "drop-markers"] as const).includes(
      input.stitchMode as never,
    )
      ? input.stitchMode!
      : "fill",
    protocol: input.protocol === "dash" ? "dash" : "hls",
    lowLatency: input.lowLatency === true,
    adDecision: input.adDecision === true,
    adMode: input.adMode === "csai" ? "csai" : "ssai",
    faults: typeof input.faults === "object" && input.faults ? input.faults : {},
  };
}

export async function POST(req: NextRequest) {
  let body: Partial<SimConfig>;
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  try {
    const r = runChain(sanitise(body));
    // The full timeline is large and the page only needs the signalling and the
    // shape of the avails, so the segment list stays on the server.
    return NextResponse.json({
      config: r.config,
      stages: r.stages,
      master: r.master,
      signals: r.timeline.signals,
      avails: r.timeline.avails,
      segmentCount: r.timeline.segments.length,
      ssai: { avails: r.ssai.avails, beacons: r.ssai.beacons.slice(0, 40), uri: r.ssai.uri },
      csai: r.csai,
      decisions: r.decisions.map((d) => ({
        availId: d.availId,
        availSeconds: d.availSeconds,
        elapsedMs: d.elapsedMs,
        budgetMs: d.budgetMs,
        accepted: d.accepted,
        rejected: d.rejected,
        findings: d.findings,
      })),
      analysis: r.analysis,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Simulation failed" },
      { status: 400 },
    );
  }
}
