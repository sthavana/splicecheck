import { test } from "node:test";
import assert from "node:assert/strict";
import { diffRun } from "../src/lib/monitor";
import type { Monitor, Run } from "../src/lib/store";
import type { RunResult } from "../src/lib/runner";
import type { Finding } from "../src/lib/analyze";

const monitor: Monitor = {
  id: "m1",
  url: "https://example.com/manifest.mpd",
  label: "Test",
  intervalSeconds: 30,
  enabled: 1,
  webhookUrl: null,
  createdAt: 0,
  lastRunAt: 0,
  consecutiveFailures: 0,
};

const run = (o: Partial<Run>): Run => ({
  id: 1,
  monitorId: "m1",
  at: Date.now() - 30_000,
  ok: 1,
  error: null,
  verdict: "pass",
  errors: 0,
  warnings: 0,
  infos: 0,
  breakCount: 5,
  protocol: "dash",
  durationMs: 100,
  codes: "[]",
  ...o,
});

const result = (
  verdict: "pass" | "warn" | "fail",
  errors: number,
  warnings: number,
  breaks: number,
  findings: Finding[] = [],
): RunResult =>
  ({
    sourceUri: "u",
    fetchedAt: "",
    isMaster: false,
    crossFindings: [],
    renditions: [
      {
        label: "MPD",
        uri: "u",
        protocol: "dash",
        breaks: Array.from({ length: breaks }, (_, i) => ({ index: i, startTime: i })),
        findings,
        stats: {},
      },
    ],
    summary: { errors, warnings, infos: 0, breakCount: breaks, verdict },
    meta: { protocol: "dash", fetchMs: 1 },
  }) as unknown as RunResult;

const f = (severity: Finding["severity"], code: string): Finding => ({
  severity,
  code,
  title: code,
  detail: "detail",
});

test("a steady, unchanged stream produces no alerts", () => {
  const prev = run({ verdict: "warn", warnings: 1, codes: JSON.stringify(["NO_PDT"]) });
  const alerts = diffRun(prev, result("warn", 0, 1, 5, [f("warning", "NO_PDT")]), monitor);
  assert.deepEqual(alerts, [], "alerting on state rather than transitions is what gets monitors muted");
});

test("a newly appeared error alerts once, with the verdict change", () => {
  const prev = run({ verdict: "warn", warnings: 1, codes: JSON.stringify(["NO_PDT"]) });
  const alerts = diffRun(
    prev,
    result("fail", 1, 1, 5, [f("warning", "NO_PDT"), f("error", "PERIOD_TIMELINE_GAP")]),
    monitor,
  );
  const codes = alerts.map((a) => a.code);
  assert.ok(codes.includes("NEW_PERIOD_TIMELINE_GAP"));
  assert.ok(codes.includes("VERDICT_DEGRADED"));
});

test("the same error on the following poll does not alert again", () => {
  const prev = run({ verdict: "fail", errors: 1, codes: JSON.stringify(["PERIOD_TIMELINE_GAP"]) });
  const alerts = diffRun(prev, result("fail", 1, 0, 5, [f("error", "PERIOD_TIMELINE_GAP")]), monitor);
  assert.deepEqual(alerts, []);
});

test("ad signalling disappearing is an error even though the stream is healthy", () => {
  const alerts = diffRun(run({ breakCount: 5 }), result("pass", 0, 0, 0), monitor);
  const stopped = alerts.find((a) => a.code === "SIGNALLING_STOPPED");
  assert.ok(stopped);
  assert.equal(stopped.severity, "error");
});

test("the first successful run establishes a baseline without alerting on existing faults", () => {
  const alerts = diffRun(undefined, result("fail", 2, 1, 5, [f("error", "PTO_MISMATCH")]), monitor);
  assert.ok(!alerts.some((a) => a.code.startsWith("NEW_")), "a new monitor must not page about pre-existing state");
});
