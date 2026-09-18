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
  stitchedUrl: null,
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
  fillRate: null,
  availsSignalled: null,
  availsFilled: null,
  availsMissed: null,
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

test("one finding across many renditions produces one alert, not one each", () => {
  const prev = run({ verdict: "pass", codes: "[]" });
  const withFourRenditions = result("fail", 4, 0, 5, [
    f("error", "VARIANT_MISSING_BREAK"),
    f("error", "VARIANT_MISSING_BREAK"),
    f("error", "VARIANT_MISSING_BREAK"),
    f("error", "VARIANT_MISSING_BREAK"),
  ]);
  const alerts = diffRun(prev, withFourRenditions, monitor);
  const newAlerts = alerts.filter((a) => a.code === "NEW_VARIANT_MISSING_BREAK");
  assert.equal(newAlerts.length, 1, "four renditions reporting one fault is one alert");
  assert.match(newAlerts[0].detail, /4 renditions/);
});


// --------------------------------------------------- continuous pipeline --

import { diffPipeline } from "../src/lib/monitor";
import type { PipelineComparison } from "../src/lib/pipeline";

const comparison = (o: Partial<PipelineComparison["summary"]>): PipelineComparison =>
  ({
    source: { uri: "s", protocol: "hls", label: "source", breakCount: 4 },
    stitched: { uri: "o", protocol: "hls", label: "output", breakCount: 4 },
    avails: [],
    findings: [],
    summary: {
      signalled: 4,
      filled: 4,
      notStitched: 0,
      underFilled: 0,
      overFilled: 0,
      passthrough: 0,
      unsignalled: 0,
      signalledSeconds: 120,
      stitchedSeconds: 120,
      fillRate: 1,
      verdict: "pass",
      ...o,
    },
  }) as PipelineComparison;

test("pipeline: a healthy comparison poll after poll produces no alerts", () => {
  const prev = run({ fillRate: 1 });
  assert.deepEqual(diffPipeline(prev, comparison({}), monitor), []);
});

test("pipeline: an avail that was never stitched alerts", () => {
  const alerts = diffPipeline(run({ fillRate: 1 }), comparison({ notStitched: 1, filled: 3 }), monitor);
  const a = alerts.find((x) => x.code === "AVAILS_NOT_STITCHED");
  assert.ok(a);
  assert.equal(a.severity, "error");
});

test("pipeline: a break opened and filled with the programme alerts", () => {
  const alerts = diffPipeline(run({ fillRate: 1 }), comparison({ passthrough: 2, filled: 2 }), monitor);
  assert.ok(alerts.some((x) => x.code === "AVAILS_PASSED_THROUGH"));
});

test("pipeline: a fill-rate fall is an error, a recovery is not", () => {
  const dropped = diffPipeline(run({ fillRate: 0.95 }), comparison({ fillRate: 0.6 }), monitor);
  const d = dropped.find((x) => x.code === "FILL_RATE_DROPPED");
  assert.ok(d);
  assert.equal(d.severity, "error");
  assert.match(d.title, /95\.0% to 60\.0%/);

  const recovered = diffPipeline(run({ fillRate: 0.6 }), comparison({ fillRate: 0.98 }), monitor);
  const r = recovered.find((x) => x.code === "FILL_RATE_RECOVERED");
  assert.ok(r);
  assert.equal(r.severity, "info");
});

test("pipeline: small fill-rate movement is not worth an alert", () => {
  // Fill rate wobbles with where the window happens to fall; alerting on every
  // percentage point would make the monitor unreadable.
  assert.deepEqual(diffPipeline(run({ fillRate: 1 }), comparison({ fillRate: 0.94 }), monitor), []);
});

/* --------------------------------------------- recovery from an outage --
 * STREAM_UNREACHABLE deliberately waits for two consecutive failures, because
 * origins and CDNs hiccup. Recovery has to use the same threshold, or a single
 * blip produces a recovery notice for an outage that was never reported.
 */

const failed = (o: Partial<Run> = {}) =>
  run({ ok: 0, error: "fetch failed", verdict: null, ...o });

test("a single failed poll produces no recovery notice", () => {
  const afterOneBlip: Monitor = { ...monitor, consecutiveFailures: 1 };
  const alerts = diffRun(failed(), result("pass", 0, 0, 5), afterOneBlip);
  assert.deepEqual(alerts.map((a) => a.code), []);
});

test("recovery from a reported outage is announced", () => {
  const afterOutage: Monitor = { ...monitor, consecutiveFailures: 2 };
  const alerts = diffRun(failed(), result("pass", 0, 0, 5), afterOutage);
  assert.deepEqual(alerts.map((a) => a.code), ["STREAM_RECOVERED"]);
});

test("a longer outage still announces exactly one recovery", () => {
  const afterLongOutage: Monitor = { ...monitor, consecutiveFailures: 17 };
  const alerts = diffRun(failed(), result("pass", 0, 0, 5), afterLongOutage);
  assert.deepEqual(alerts.map((a) => a.code), ["STREAM_RECOVERED"]);
});

test("a good run after a good run announces nothing", () => {
  assert.deepEqual(
    diffRun(run({}), result("pass", 0, 0, 5), monitor).map((a) => a.code),
    [],
  );
});

/* ------------------------------------------------ a break that is stuck --
 * Measured on the media timeline. Wall clock since the break was first seen
 * grows with the DVR window for every break whether or not anything is wrong,
 * and keeps growing while the poller is not looking — a 256s gap between polls
 * was enough to report a break that closed twenty seconds later as stuck.
 */

import { trackBreaksForTest } from "../src/lib/monitor";

const withBreak = (o: { edgeDistance?: number; closed: boolean; signalled?: number }): RunResult =>
  ({
    ...result("pass", 0, 0, 1),
    renditions: [
      {
        label: "v",
        findings: [],
        breaks: [
          {
            index: 0,
            eventId: 999,
            startTime: 0,
            signalledDuration: o.signalled ?? 38.4,
            closed: o.closed,
            edgeDistance: o.edgeDistance,
          },
        ],
      },
    ],
  }) as unknown as RunResult;

test("a break inside its duration at the live edge is not stuck", () => {
  const alerts = trackBreaksForTest(monitor, withBreak({ edgeDistance: 20, closed: false }), Date.now());
  assert.deepEqual(alerts.map((a) => a.code), []);
});

test("a break well past its duration at the live edge is stuck", () => {
  const alerts = trackBreaksForTest(monitor, withBreak({ edgeDistance: 300, closed: false }), Date.now());
  assert.deepEqual(alerts.map((a) => a.code), ["BREAK_STUCK_OPEN"]);
});

test("a long gap between polls cannot make a healthy break look stuck", () => {
  // The break has been visible for an hour of wall clock because the window
  // slid and the poller slept; on the media timeline it opened 20s ago.
  const m: Monitor = { ...monitor, id: "gap-test" };
  trackBreaksForTest(m, withBreak({ edgeDistance: 5, closed: false }), Date.now() - 3_600_000);
  const alerts = trackBreaksForTest(m, withBreak({ edgeDistance: 20, closed: false }), Date.now());
  assert.deepEqual(alerts.map((a) => a.code), []);
});

test("a closed break is never stuck", () => {
  const alerts = trackBreaksForTest(monitor, withBreak({ edgeDistance: 999, closed: true }), Date.now());
  assert.deepEqual(alerts.map((a) => a.code), []);
});

test("the analyser's own overrun finding suppresses the duplicate", () => {
  const alerts = trackBreaksForTest(
    { ...monitor, id: "dedupe-test" },
    withBreak({ edgeDistance: 300, closed: false }),
    Date.now(),
    new Set(["BREAK_OVERRUN_UNCLOSED"]),
  );
  assert.deepEqual(alerts.map((a) => a.code), [], "one fault, one alert");
});
