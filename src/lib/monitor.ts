/**
 * The monitor: poll a stream on an interval, compare each result with the last,
 * and raise an alert only when something actually changed for the worse.
 *
 * The discipline here is the same as the analyser's — a monitor that pages you
 * for a condition that has been true for six hours is a monitor people turn off.
 * Alerts fire on transitions, not on state.
 */

import { randomUUID } from "node:crypto";
import { analyzeUrl, type RunResult } from "./runner";
import { store, type Monitor, type Run } from "./store";

const FAILURES_BEFORE_ALERT = 2;
/** grace beyond a break's signalled duration before it counts as stuck */
const STUCK_BREAK_GRACE_MS = 60_000;

export interface AlertDraft {
  severity: "error" | "warning" | "info";
  code: string;
  title: string;
  detail: string;
}

function codesOf(r: RunResult): { code: string; severity: string; title: string; detail: string }[] {
  return [...r.crossFindings, ...r.renditions.flatMap((x) => x.findings)].map((f) => ({
    code: f.code,
    severity: f.severity,
    title: f.title,
    detail: f.detail,
  }));
}

/** Stable identity for a break across polls. */
function breakKey(b: { eventId?: number; periodId?: string; pdt?: number; startTime: number }): string {
  if (b.eventId !== undefined) return `event:${b.eventId}`;
  if (b.periodId !== undefined) return `period:${b.periodId}`;
  if (b.pdt !== undefined) return `pdt:${Math.round(b.pdt / 1000)}`;
  return `t:${b.startTime.toFixed(3)}`;
}

export function diffRun(prev: Run | undefined, result: RunResult, monitor: Monitor): AlertDraft[] {
  const alerts: AlertDraft[] = [];
  const findings = codesOf(result);
  const nowCodes = new Set(findings.map((f) => f.code));
  const prevCodes: Set<string> = new Set(prev?.ok ? (JSON.parse(prev.codes) as string[]) : []);
  const hadPrevGoodRun = !!prev?.ok;

  // Recovery from an outage.
  if (prev && !prev.ok) {
    alerts.push({
      severity: "info",
      code: "STREAM_RECOVERED",
      title: `${monitor.label} is reachable again`,
      detail: `The manifest fetched successfully after ${monitor.consecutiveFailures} failed attempt(s). Previous error: ${prev.error ?? "unknown"}.`,
    });
  }

  // New problems, reported once when they appear. A finding that occurs in
  // several renditions is one problem, not one per rendition — alerting per
  // occurrence is how a single fault turns into a page-full of duplicates.
  const seenCodes = new Set<string>();
  for (const f of findings) {
    if (prevCodes.has(f.code)) continue;
    if (f.severity === "info") continue;
    if (!hadPrevGoodRun) continue; // first successful run establishes the baseline
    if (seenCodes.has(f.code)) continue;
    seenCodes.add(f.code);
    const occurrences = findings.filter((x) => x.code === f.code).length;
    alerts.push({
      severity: f.severity as "error" | "warning",
      code: `NEW_${f.code}`,
      title: `${monitor.label}: ${f.title}`,
      detail: occurrences > 1 ? `${f.detail} (seen in ${occurrences} renditions)` : f.detail,
    });
  }

  // Problems that cleared.
  if (hadPrevGoodRun) {
    const cleared = [...prevCodes].filter((c) => !nowCodes.has(c));
    const clearedSerious = cleared.filter((c) => c !== "BREAK_IN_PROGRESS");
    if (clearedSerious.length && result.summary.errors === 0 && (prev?.errors ?? 0) > 0) {
      alerts.push({
        severity: "info",
        code: "ERRORS_CLEARED",
        title: `${monitor.label}: errors cleared`,
        detail: `The conditions ${clearedSerious.join(", ")} are no longer present. The stream now reports ${result.summary.warnings} warning(s).`,
      });
    }
  }

  // Verdict got worse.
  const rank = { pass: 0, warn: 1, fail: 2 } as const;
  if (prev?.ok && prev.verdict && rank[result.summary.verdict] > rank[prev.verdict as keyof typeof rank]) {
    alerts.push({
      severity: result.summary.verdict === "fail" ? "error" : "warning",
      code: "VERDICT_DEGRADED",
      title: `${monitor.label}: ${prev.verdict} → ${result.summary.verdict}`,
      detail: `Now reporting ${result.summary.errors} error(s) and ${result.summary.warnings} warning(s), up from ${prev.errors} and ${prev.warnings}.`,
    });
  }

  // Ad signalling disappeared. This is the one operators care most about:
  // the stream is up, the player is happy, and no ads are being inserted.
  const breakCount = result.renditions[0]?.breaks.length ?? 0;
  if (hadPrevGoodRun && prev!.breakCount > 0 && breakCount === 0) {
    alerts.push({
      severity: "error",
      code: "SIGNALLING_STOPPED",
      title: `${monitor.label}: ad signalling has disappeared`,
      detail: `The previous poll saw ${prev!.breakCount} ad break(s) in the window and this one sees none. The stream is still delivering, so this will not show up as an outage — but nothing is being monetised until it returns.`,
    });
  }
  if (hadPrevGoodRun && prev!.breakCount === 0 && breakCount > 0) {
    alerts.push({
      severity: "info",
      code: "SIGNALLING_RESUMED",
      title: `${monitor.label}: ad signalling has returned`,
      detail: `${breakCount} ad break(s) are present in the window again.`,
    });
  }

  return alerts;
}

/** Track break lifecycle across polls so a break that never closes gets caught. */
function trackBreaks(monitor: Monitor, result: RunResult, now: number): AlertDraft[] {
  const alerts: AlertDraft[] = [];
  const breaks = result.renditions[0]?.breaks ?? [];
  const known = new Map(store.openBreaks(monitor.id).map((b) => [b.breakKey, b]));

  for (const b of breaks) {
    const key = breakKey(b);
    store.upsertBreak({
      monitorId: monitor.id,
      breakKey: key,
      firstSeen: known.get(key)?.firstSeen ?? now,
      lastSeen: now,
      signalled: b.signalledDuration ?? null,
      closed: b.closed ? 1 : 0,
      alerted: known.get(key)?.alerted ?? 0,
    });
  }

  // A break still open well past its signalled duration is stuck.
  for (const open of store.openBreaks(monitor.id)) {
    if (open.alerted) continue;
    const stillPresent = breaks.find((b) => breakKey(b) === open.breakKey);
    if (!stillPresent || stillPresent.closed) continue;
    const budget = (open.signalled ?? 60) * 1000 + STUCK_BREAK_GRACE_MS;
    if (now - open.firstSeen > budget) {
      alerts.push({
        severity: "error",
        code: "BREAK_STUCK_OPEN",
        title: `${monitor.label}: an ad break has not closed`,
        detail: `Break ${open.breakKey} was first seen ${Math.round((now - open.firstSeen) / 1000)}s ago and signalled ${open.signalled ?? "an unknown"}s, but no return-from-break has appeared. Players that entered this avail are still in ad mode, and SSAI is still substituting content.`,
      });
      store.markBreakAlerted(monitor.id, open.breakKey);
    }
  }

  store.pruneBreaks(monitor.id, now - 6 * 3600 * 1000);
  return alerts;
}

async function deliver(monitor: Monitor, alerts: AlertDraft[]) {
  if (!monitor.webhookUrl || alerts.length === 0) return;
  const worst = alerts.some((a) => a.severity === "error")
    ? "error"
    : alerts.some((a) => a.severity === "warning")
      ? "warning"
      : "info";
  const icon = worst === "error" ? ":rotating_light:" : worst === "warning" ? ":warning:" : ":white_check_mark:";
  const text = [
    `${icon} *SpliceCheck — ${monitor.label}*`,
    monitor.url,
    "",
    ...alerts.map((a) => `• *${a.title}*\n  ${a.detail}`),
  ].join("\n");
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    await fetch(monitor.webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      signal: ctrl.signal,
    });
    clearTimeout(t);
  } catch {
    // A webhook that is down must never take the poller down with it.
  }
}

export async function runMonitorOnce(monitor: Monitor): Promise<{ ok: boolean; alerts: AlertDraft[] }> {
  const now = Date.now();
  const t0 = Date.now();
  const prev = store.lastRun(monitor.id);
  let alerts: AlertDraft[] = [];

  try {
    const result = await analyzeUrl(monitor.url);
    const findings = codesOf(result);

    alerts = diffRun(prev, result, monitor);
    alerts.push(...trackBreaks(monitor, result, now));

    store.addRun({
      monitorId: monitor.id,
      at: now,
      ok: 1,
      error: null,
      verdict: result.summary.verdict,
      errors: result.summary.errors,
      warnings: result.summary.warnings,
      infos: result.summary.infos,
      breakCount: result.renditions[0]?.breaks.length ?? 0,
      protocol: result.meta.protocol,
      durationMs: Date.now() - t0,
      codes: JSON.stringify([...new Set(findings.map((f) => f.code))]),
    });
    store.markRun(monitor.id, now, false);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const failures = monitor.consecutiveFailures + 1;
    // Don't alert on a single blip; origins and CDNs hiccup.
    if (failures === FAILURES_BEFORE_ALERT) {
      alerts.push({
        severity: "error",
        code: "STREAM_UNREACHABLE",
        title: `${monitor.label} is unreachable`,
        detail: `${failures} consecutive failed polls. Last error: ${message}`,
      });
    }
    store.addRun({
      monitorId: monitor.id,
      at: now,
      ok: 0,
      error: message,
      verdict: null,
      errors: 0,
      warnings: 0,
      infos: 0,
      breakCount: 0,
      protocol: null,
      durationMs: Date.now() - t0,
      codes: "[]",
    });
    store.markRun(monitor.id, now, true);
  }

  for (const a of alerts) {
    store.addAlert({ monitorId: monitor.id, at: now, ...a });
  }
  await deliver(monitor, alerts);
  store.pruneRuns(monitor.id);
  return { ok: alerts.every((a) => a.severity !== "error"), alerts };
}

// ---- scheduler ----------------------------------------------------------

const g = globalThis as unknown as { __splicecheckScheduler?: NodeJS.Timeout; __splicecheckRunning?: Set<string> };
const running = (g.__splicecheckRunning ??= new Set<string>());

async function tick() {
  const now = Date.now();
  for (const m of store.listMonitors()) {
    if (!m.enabled) continue;
    if (running.has(m.id)) continue;
    const due = m.lastRunAt === null || now - m.lastRunAt >= m.intervalSeconds * 1000;
    if (!due) continue;
    running.add(m.id);
    void runMonitorOnce(m)
      .catch(() => {})
      .finally(() => running.delete(m.id));
  }
}

export function startScheduler() {
  if (g.__splicecheckScheduler) return;
  g.__splicecheckScheduler = setInterval(() => void tick(), 5000);
  void tick();
}

export function newMonitorId(): string {
  return randomUUID().slice(0, 8);
}
