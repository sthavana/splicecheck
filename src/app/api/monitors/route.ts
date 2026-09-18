import { NextRequest, NextResponse } from "next/server";
import { store } from "@/lib/store";
import { newMonitorId, runMonitorOnce, schedulerStatus, startScheduler } from "@/lib/monitor";
import { assertPublicUrl } from "@/lib/runner";

export const dynamic = "force-dynamic";

export async function GET() {
  startScheduler();
  const monitors = store.listMonitors().map((m) => {
    const runs = store.recentRuns(m.id, 60);
    const last = runs[0];
    return {
      ...m,
      last: last
        ? {
            at: last.at,
            ok: last.ok,
            verdict: last.verdict,
            errors: last.errors,
            warnings: last.warnings,
            breakCount: last.breakCount,
            protocol: last.protocol,
            error: last.error,
            durationMs: last.durationMs,
            fillRate: last.fillRate,
            availsSignalled: last.availsSignalled,
            availsMissed: last.availsMissed,
          }
        : null,
      history: runs
        .slice()
        .reverse()
        .map((r) => ({
          at: r.at,
          ok: r.ok,
          verdict: r.verdict,
          errors: r.errors,
          breakCount: r.breakCount,
          fillRate: r.fillRate,
        })),
    };
  });
  return NextResponse.json({
    monitors,
    unacknowledged: store.unacknowledgedCount(),
    scheduler: schedulerStatus(),
  });
}

export async function POST(req: NextRequest) {
  startScheduler();
  let body: {
    url?: string;
    label?: string;
    intervalSeconds?: number;
    webhookUrl?: string;
    /** optional stitched output, which turns each poll into a pipeline comparison */
    stitchedUrl?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Expected a JSON body" }, { status: 400 });
  }
  if (!body.url?.trim()) return NextResponse.json({ error: "A manifest URL is required" }, { status: 400 });
  try {
    assertPublicUrl(body.url.trim());
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Invalid URL" }, { status: 400 });
  }
  if (body.stitchedUrl?.trim()) {
    try {
      assertPublicUrl(body.stitchedUrl.trim());
    } catch (e) {
      return NextResponse.json(
        { error: `Stitched output: ${e instanceof Error ? e.message : "invalid URL"}` },
        { status: 400 },
      );
    }
  }
  if (body.webhookUrl?.trim()) {
    try {
      assertPublicUrl(body.webhookUrl.trim());
    } catch {
      return NextResponse.json({ error: "Webhook URL must be a public http(s) address" }, { status: 400 });
    }
  }

  const interval = Math.min(Math.max(body.intervalSeconds ?? 60, 15), 3600);
  const monitor = store.createMonitor({
    id: newMonitorId(),
    url: body.url.trim(),
    label: body.label?.trim() || new URL(body.url.trim()).hostname,
    intervalSeconds: interval,
    enabled: 1,
    webhookUrl: body.webhookUrl?.trim() || null,
    stitchedUrl: body.stitchedUrl?.trim() || null,
    createdAt: Date.now(),
  });

  // Establish the baseline immediately so the first poll has something to diff.
  await runMonitorOnce(monitor);
  return NextResponse.json({ monitor: store.getMonitor(monitor.id) });
}
