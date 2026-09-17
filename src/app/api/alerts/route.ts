import { NextRequest, NextResponse } from "next/server";
import { store } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const monitorId = req.nextUrl.searchParams.get("monitorId") ?? undefined;
  const limit = Math.min(Number(req.nextUrl.searchParams.get("limit") ?? 200), 500);
  return NextResponse.json({
    alerts: store.listAlerts(limit, monitorId),
    unacknowledged: store.unacknowledgedCount(),
  });
}

export async function PATCH(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as { ids?: number[] };
  store.acknowledgeAlerts(body.ids ?? []);
  return NextResponse.json({ ok: true, unacknowledged: store.unacknowledgedCount() });
}
