import { NextRequest, NextResponse } from "next/server";
import { store } from "@/lib/store";
import { runMonitorOnce } from "@/lib/monitor";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const m = store.getMonitor(id);
  if (!m) return NextResponse.json({ error: "No such monitor" }, { status: 404 });
  return NextResponse.json({
    monitor: m,
    runs: store.recentRuns(id, 200),
    alerts: store.listAlerts(100, id),
    openBreaks: store.openBreaks(id),
  });
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as {
    enabled?: boolean;
    intervalSeconds?: number;
    label?: string;
    webhookUrl?: string | null;
    runNow?: boolean;
  };
  const existing = store.getMonitor(id);
  if (!existing) return NextResponse.json({ error: "No such monitor" }, { status: 404 });

  if (body.runNow) {
    await runMonitorOnce(existing);
    return NextResponse.json({ monitor: store.getMonitor(id) });
  }

  const updated = store.updateMonitor(id, {
    ...(body.enabled !== undefined ? { enabled: body.enabled ? 1 : 0 } : {}),
    ...(body.intervalSeconds !== undefined
      ? { intervalSeconds: Math.min(Math.max(body.intervalSeconds, 15), 3600) }
      : {}),
    ...(body.label !== undefined ? { label: body.label } : {}),
    ...(body.webhookUrl !== undefined ? { webhookUrl: body.webhookUrl } : {}),
  });
  return NextResponse.json({ monitor: updated });
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  store.deleteMonitor(id);
  return NextResponse.json({ ok: true });
}
