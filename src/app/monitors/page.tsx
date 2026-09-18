"use client";

import Link from "next/link";

import { useCallback, useEffect, useState } from "react";

interface MonitorRow {
  id: string;
  url: string;
  label: string;
  intervalSeconds: number;
  enabled: number;
  webhookUrl: string | null;
  stitchedUrl: string | null;
  lastRunAt: number | null;
  consecutiveFailures: number;
  last: {
    at: number;
    ok: number;
    verdict: string | null;
    errors: number;
    warnings: number;
    breakCount: number;
    protocol: string | null;
    error: string | null;
    durationMs: number;
    fillRate: number | null;
    availsSignalled: number | null;
    availsMissed: number | null;
  } | null;
  history: {
    at: number;
    ok: number;
    verdict: string | null;
    errors: number;
    breakCount: number;
    fillRate: number | null;
  }[];
}

interface AlertRow {
  id: number;
  monitorId: string;
  at: number;
  severity: "error" | "warning" | "info";
  code: string;
  title: string;
  detail: string;
  acknowledged: number;
}

const SEV = {
  error: { dot: "bg-red-500", text: "text-red-300", chip: "border-red-500/30 bg-red-500/10 text-red-300" },
  warning: { dot: "bg-amber-400", text: "text-amber-200", chip: "border-amber-400/30 bg-amber-400/10 text-amber-200" },
  info: { dot: "bg-sky-400", text: "text-sky-200", chip: "border-sky-400/30 bg-sky-400/10 text-sky-200" },
};

function ago(t: number) {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

function FillTrend({ history }: { history: MonitorRow["history"] }) {
  const points = history.filter((h) => h.fillRate !== null).slice(-40);
  if (points.length === 0) return null;
  return (
    <span className="flex items-end gap-[2px]" title="Fill rate over recent polls">
      {points.map((h, i) => {
        const v = h.fillRate ?? 0;
        const colour = v >= 0.99 ? "bg-emerald-500" : v >= 0.9 ? "bg-amber-400" : "bg-red-500";
        return (
          <span
            key={i}
            className={`w-[3px] rounded-sm ${colour}`}
            style={{ height: `${Math.max(2, Math.round(v * 16))}px` }}
          />
        );
      })}
    </span>
  );
}

function Sparkline({ history }: { history: MonitorRow["history"] }) {
  const cells = history.slice(-40);
  return (
    <div className="flex items-end gap-[2px]" title="Recent polls — red: errors, amber: warnings, grey: unreachable">
      {cells.map((h, i) => {
        const color = !h.ok
          ? "bg-neutral-600"
          : h.errors > 0
            ? "bg-red-500"
            : h.verdict === "warn"
              ? "bg-amber-400"
              : "bg-emerald-500";
        return <span key={i} className={`h-4 w-[3px] rounded-sm ${color}`} />;
      })}
      {cells.length === 0 && <span className="text-[11px] text-muted">no polls yet</span>}
    </div>
  );
}

export default function Monitors() {
  const [scheduler, setScheduler] = useState<{ running: boolean; reason?: string } | null>(null);
  const [monitors, setMonitors] = useState<MonitorRow[]>([]);
  const [alerts, setAlerts] = useState<AlertRow[]>([]);
  const [url, setUrl] = useState("");
  const [label, setLabel] = useState("");
  const [interval, setIntervalSec] = useState(60);
  const [webhook, setWebhook] = useState("");
  const [stitched, setStitched] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [m, a] = await Promise.all([
      fetch("/api/monitors").then((r) => r.json()),
      fetch("/api/alerts?limit=100").then((r) => r.json()),
    ]);
    setMonitors(m.monitors ?? []);
    setScheduler(m.scheduler ?? null);
    setAlerts(a.alerts ?? []);
  }, []);

  useEffect(() => {
    let live = true;
    const poll = async () => {
      if (!live) return;
      await load();
    };
    // Deferred so the first fetch does not set state during the effect itself.
    const kick = setTimeout(poll, 0);
    const t = setInterval(poll, 5000);
    return () => {
      live = false;
      clearTimeout(kick);
      clearInterval(t);
    };
  }, [load]);

  async function add() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/monitors", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url,
          label,
          intervalSeconds: interval,
          webhookUrl: webhook,
          stitchedUrl: stitched,
        }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? "Could not add monitor");
      setUrl("");
      setLabel("");
      setWebhook("");
      setStitched("");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not add monitor");
    } finally {
      setBusy(false);
    }
  }

  async function patch(id: string, body: Record<string, unknown>) {
    await fetch(`/api/monitors/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    await load();
  }

  async function remove(id: string) {
    await fetch(`/api/monitors/${id}`, { method: "DELETE" });
    await load();
  }

  async function ack(ids: number[]) {
    await fetch("/api/alerts", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids }),
    });
    await load();
  }

  const openAlerts = alerts.filter((a) => !a.acknowledged);

  return (
    <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-10 sm:px-6">
      <header className="mb-8 flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Splice<span className="text-accent">Check</span> monitors
          </h1>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">
            Poll a stream continuously and alert when its ad signalling changes for the worse — a break
            that never closes, signalling that disappears, a new fault that was not there on the last poll.
          </p>
        </div>
        <Link href="/" className="text-sm text-accent hover:underline">
          ← one-off inspector
        </Link>
      </header>

      {scheduler && !scheduler.running && scheduler.reason && (
        <div className="mb-6 rounded-xl border border-amber-400/40 bg-amber-400/10 px-4 py-3">
          <div className="font-medium text-amber-100">Polling is not running on this deployment</div>
          <p className="mt-1 text-sm leading-relaxed text-amber-100/70">{scheduler.reason}</p>
          <p className="mt-2 text-sm leading-relaxed text-amber-100/70">
            Everything below still works on demand — add a stream and press{" "}
            <span className="font-mono text-xs">poll now</span> to run a real analysis against it. What
            will not happen is the part that matters in production: polling on an interval and
            alerting when a result changes for the worse.
          </p>
        </div>
      )}

      <section className="rounded-xl border border-edge bg-panel p-4">
        <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-muted">Add a stream</h2>
        <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://example.com/live/manifest.mpd  or  master.m3u8"
            className="rounded-lg border border-edge bg-black/30 px-3 py-2 font-mono text-sm outline-none placeholder:text-muted/60 focus:border-accent"
          />
          <button
            onClick={add}
            disabled={busy || !url.trim()}
            className="rounded-lg bg-accent px-5 py-2 text-sm font-medium text-[#04121f] disabled:opacity-40"
          >
            {busy ? "Adding…" : "Monitor"}
          </button>
        </div>
        <div className="mt-2 grid gap-2 sm:grid-cols-3">
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Label (optional)"
            className="rounded-lg border border-edge bg-black/30 px-3 py-2 text-sm outline-none placeholder:text-muted/60 focus:border-accent"
          />
          <label className="flex items-center gap-2 rounded-lg border border-edge bg-black/30 px-3 py-2 text-sm text-muted">
            every
            <input
              type="number"
              min={15}
              max={3600}
              value={interval}
              onChange={(e) => setIntervalSec(Number(e.target.value))}
              className="w-16 bg-transparent text-foreground outline-none"
            />
            s
          </label>
          <input
            value={webhook}
            onChange={(e) => setWebhook(e.target.value)}
            placeholder="Slack webhook URL (optional)"
            className="rounded-lg border border-edge bg-black/30 px-3 py-2 text-sm outline-none placeholder:text-muted/60 focus:border-accent"
          />
        </div>
        <div className="mt-2">
          <input
            value={stitched}
            onChange={(e) => setStitched(e.target.value)}
            placeholder="Stitched output URL (optional) — compares every poll and tracks fill rate"
            className="w-full rounded-lg border border-edge bg-black/30 px-3 py-2 font-mono text-sm outline-none placeholder:text-muted/60 focus:border-accent"
          />
        </div>
        {error && <p className="mt-2 text-sm text-red-300">{error}</p>}
      </section>

      <section className="mt-8">
        <div className="mb-2 flex items-baseline justify-between">
          <h2 className="text-sm font-medium uppercase tracking-wide text-muted">Streams</h2>
          <span className="text-xs text-muted">{monitors.length} monitored</span>
        </div>
        {monitors.length === 0 ? (
          <p className="rounded-xl border border-edge bg-panel px-4 py-8 text-center text-sm text-muted">
            Nothing monitored yet.
          </p>
        ) : (
          <div className="space-y-2">
            {monitors.map((m) => (
              <div key={m.id} className="rounded-lg border border-edge bg-panel p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span
                        className={`h-2 w-2 rounded-full ${
                          !m.enabled
                            ? "bg-neutral-600"
                            : m.last?.ok === 0
                              ? "bg-neutral-500"
                              : (m.last?.errors ?? 0) > 0
                                ? "bg-red-500"
                                : m.last?.verdict === "warn"
                                  ? "bg-amber-400"
                                  : "bg-emerald-500"
                        }`}
                      />
                      <span className="font-medium">{m.label}</span>
                      {m.last?.protocol && (
                        <span className="rounded border border-edge px-1.5 py-0.5 text-[10px] uppercase text-muted">
                          {m.last.protocol}
                        </span>
                      )}
                      {!m.enabled && <span className="text-[11px] text-muted">paused</span>}
                    </div>
                    <div className="mt-1 truncate font-mono text-[11px] text-muted">{m.url}</div>
                  </div>
                  <div className="flex items-center gap-2 text-xs">
                    <button onClick={() => patch(m.id, { runNow: true })} className="rounded border border-edge px-2 py-1 text-muted hover:text-foreground">
                      poll now
                    </button>
                    <button onClick={() => patch(m.id, { enabled: !m.enabled })} className="rounded border border-edge px-2 py-1 text-muted hover:text-foreground">
                      {m.enabled ? "pause" : "resume"}
                    </button>
                    <button onClick={() => remove(m.id)} className="rounded border border-edge px-2 py-1 text-muted hover:text-red-300">
                      remove
                    </button>
                  </div>
                </div>

                <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-2 text-xs text-muted">
                  <Sparkline history={m.history} />
                  <span>every {m.intervalSeconds}s</span>
                  {m.last && <span>last {ago(m.last.at)} in {m.last.durationMs}ms</span>}
                  {m.last?.ok === 1 && (
                    <>
                      <span className={m.last.errors > 0 ? "text-red-300" : ""}>{m.last.errors} errors</span>
                      <span className={m.last.warnings > 0 ? "text-amber-200" : ""}>{m.last.warnings} warnings</span>
                      <span>{m.last.breakCount} breaks in window</span>
                    </>
                  )}
                  {m.last?.ok === 0 && <span className="text-red-300">unreachable: {m.last.error}</span>}
                  {m.webhookUrl && <span>webhook on</span>}
                </div>

                {m.stitchedUrl && (
                  <div className="mt-3 rounded-lg border border-edge/70 bg-black/20 px-3 py-2">
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
                      <span className="text-[11px] uppercase tracking-wide text-muted">Pipeline</span>
                      {m.last?.fillRate !== null && m.last?.fillRate !== undefined ? (
                        <>
                          <span
                            className={
                              m.last.fillRate >= 0.99
                                ? "text-emerald-300"
                                : m.last.fillRate >= 0.9
                                  ? "text-amber-200"
                                  : "text-red-300"
                            }
                          >
                            {(m.last.fillRate * 100).toFixed(1)}% filled
                          </span>
                          <span className="text-muted">
                            {m.last.availsSignalled ?? 0} avails signalled
                            {m.last.availsMissed ? `, ${m.last.availsMissed} not delivered` : ""}
                          </span>
                        </>
                      ) : (
                        <span className="text-muted">no comparison yet</span>
                      )}
                      <FillTrend history={m.history} />
                    </div>
                    <div className="mt-1 truncate font-mono text-[10px] text-muted">
                      vs {m.stitchedUrl}
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="mt-8">
        <div className="mb-2 flex items-baseline justify-between">
          <h2 className="text-sm font-medium uppercase tracking-wide text-muted">Alerts</h2>
          {openAlerts.length > 0 && (
            <button onClick={() => ack(openAlerts.map((a) => a.id))} className="text-xs text-accent hover:underline">
              acknowledge all ({openAlerts.length})
            </button>
          )}
        </div>
        {alerts.length === 0 ? (
          <p className="rounded-xl border border-edge bg-panel px-4 py-8 text-center text-sm text-muted">
            No alerts. Alerts fire on transitions — when something becomes true, not for as long as it stays true.
          </p>
        ) : (
          <div className="rounded-xl border border-edge bg-panel">
            {alerts.map((a) => (
              <div
                key={a.id}
                className={`flex gap-3 border-b border-edge/70 px-4 py-3 last:border-0 ${a.acknowledged ? "opacity-45" : ""}`}
              >
                <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${SEV[a.severity].dot}`} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <span className="font-medium">{a.title}</span>
                    <code className="rounded bg-white/5 px-1.5 py-0.5 font-mono text-[11px] text-muted">{a.code}</code>
                    <span className="text-[11px] text-muted">{ago(a.at)}</span>
                  </div>
                  <p className="mt-1 text-sm leading-relaxed text-muted">{a.detail}</p>
                </div>
                {!a.acknowledged && (
                  <button onClick={() => ack([a.id])} className="shrink-0 self-start text-[11px] text-muted hover:text-foreground">
                    ack
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}
