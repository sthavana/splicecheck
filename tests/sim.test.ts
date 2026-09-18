import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPayload, buildSection } from "../src/lib/sim/scte35Encode";
import { decodePayloadBytes, parseSpliceInfoSection } from "../src/lib/scte35";
import { buildTimeline } from "../src/lib/sim/timeline";
import { writeMediaPlaylist } from "../src/lib/sim/packager";
import { runChain, DEFAULT_CONFIG, type SimConfig } from "../src/lib/sim/chain";
import type { AvailStatus } from "../src/lib/pipeline";

/* ------------------------------------------------------------ the encoder */

test("every section the encoder writes has a CRC the decoder accepts", () => {
  for (const spec of [
    { spliceInsert: { eventId: 1, outOfNetwork: true, spliceTime: { ptsTime: 0 }, durationSeconds: 30 } },
    { spliceInsert: { eventId: 2, outOfNetwork: false, immediate: true } },
    { timeSignal: { ptsTime: 8_589_934_591 } },
    { timeSignal: {}, descriptors: [{ eventId: 3, typeId: 0x34, durationSeconds: 120 }] },
  ]) {
    const p = buildPayload(spec);
    assert.equal(parseSpliceInfoSection(p.base64).crcValid, true, JSON.stringify(spec));
  }
});

test("a splice_insert round-trips through the decoder unchanged", () => {
  const p = buildPayload({
    spliceInsert: {
      eventId: 1001, outOfNetwork: true, spliceTime: { ptsTime: Math.round(3600.5 * 90000) },
      durationSeconds: 90, autoReturn: false, uniqueProgramId: 7, availNum: 1, availsExpected: 4,
    },
  });
  const s = parseSpliceInfoSection(p.base64);
  assert.equal(s.spliceCommandName, "splice_insert");
  assert.equal(s.spliceInsert?.spliceEventId, 1001);
  assert.equal(s.spliceInsert?.outOfNetwork, true);
  assert.equal(s.spliceInsert?.spliceTime?.ptsTime, Math.round(3600.5 * 90000));
  assert.equal(s.spliceInsert?.breakDuration?.seconds, 90);
  assert.equal(s.spliceInsert?.breakDuration?.autoReturn, false, "auto_return must survive");
  assert.equal(s.spliceInsert?.availsExpected, 4);
});

test("a time_signal with a segmentation descriptor round-trips, MPU UPID included", () => {
  const p = buildPayload({
    timeSignal: { ptsTime: Math.round(7200.25 * 90000) },
    descriptors: [{
      eventId: 0x4800008e, typeId: 0x34, durationSeconds: 300,
      upidType: 0x0c, upid: `ADSP${JSON.stringify({ pod: 3 })}`, segmentNum: 2, segmentsExpected: 5,
    }],
  });
  const s = parseSpliceInfoSection(p.base64);
  assert.equal(s.timeSignal?.ptsTime, Math.round(7200.25 * 90000));
  const d = s.descriptors.find((x) => "typeId" in x)!;
  assert.equal(d.typeId, 0x34);
  assert.equal(d.typeName, "Provider Placement Opportunity Start");
  assert.equal(d.segmentationDurationSeconds, 300);
  assert.equal(d.upidTypeName, "MPU");
  assert.equal(d.upidText, 'ADSP {"pod":3}');
  assert.equal(d.segmentNum, 2);
  assert.equal(d.segmentsExpected, 5);
});

test("the encoder reproduces the published splice_insert vector byte for byte", () => {
  // Rebuilt from the vector's own fields. Only the descriptor loop differs: the
  // vector carries a 10-byte avail_descriptor the simulator has no use for, so
  // the sections match through the command and section_length differs by 10.
  const spec = decodePayloadBytes("/DAvAAAAAAAA///wFAVIAACPf+/+c2nALv4AUsz1AAAAAAAKAAhDVUVJAAABNWLbowo=");
  const mine = buildSection({
    spliceInsert: {
      eventId: 0x4800008f, outOfNetwork: true, spliceTime: { ptsTime: 0x736_9c02e },
      durationSeconds: 0x52ccf5 / 90000, autoReturn: true,
      uniqueProgramId: 0, availNum: 0, availsExpected: 0,
    },
  });
  const hex = (b: Uint8Array, a: number, z: number) => Buffer.from(b.slice(a, z)).toString("hex");
  assert.equal(hex(mine, 3, 33), hex(spec, 3, 33), "header after section_length, and the command");
  assert.equal(spec[2] - mine[2], 10, "section_length differs by exactly the descriptor loop");
});

test("the 33-bit PTS field wraps rather than overflowing", () => {
  const p = buildPayload({ timeSignal: { ptsTime: 2 ** 33 + 12345 } });
  assert.equal(parseSpliceInfoSection(p.base64).timeSignal?.ptsTime, 12345);
});

/* ----------------------------------------------------------- the timeline */

test("avails snap to segment boundaries, because a packager cannot split a segment", () => {
  const tl = buildTimeline({
    name: "t", segmentSeconds: 6, startEpochMs: 0, ptsBaseSeconds: 0,
    durationSec: 120, signalStyle: "time_signal",
    avails: [{ id: 1, startSec: 31, durationSec: 29 }],
  });
  assert.equal(tl.avails[0].snappedStartSec, 30);
  assert.equal(tl.avails[0].snappedDurationSec, 30);
  // The signal still carries the instant the schedule asked for, not the snap.
  assert.equal(tl.signals.find((s) => s.kind === "out")!.mediaSec, 31);
});

test("programme segments inside an avail keep their programme naming", () => {
  const tl = buildTimeline({
    name: "t", segmentSeconds: 6, startEpochMs: 0, ptsBaseSeconds: 0,
    durationSec: 120, signalStyle: "time_signal",
    avails: [{ id: 1, startSec: 30, durationSec: 30 }],
  });
  const inside = tl.segments.filter((s) => s.availId !== undefined);
  assert.ok(inside.length > 0);
  // Naming them differently would make a pass-through look like a substitution.
  assert.ok(inside.every((s) => s.uri.startsWith("content_")), "no avail-specific naming");
});

/* ----------------------------------------------------------- the packager */

test("each marker style emits only its own tags", () => {
  const tl = buildTimeline({
    name: "t", segmentSeconds: 6, startEpochMs: 0, ptsBaseSeconds: 0,
    durationSec: 120, signalStyle: "time_signal",
    avails: [{ id: 1, startSec: 30, durationSec: 30 }],
  });
  const dr = writeMediaPlaylist(tl, { markerStyle: "daterange" }).text;
  assert.ok(dr.includes("#EXT-X-DATERANGE"));
  assert.ok(!dr.includes("#EXT-X-CUE-OUT"));

  const cue = writeMediaPlaylist(tl, { markerStyle: "cue-out" }).text;
  assert.ok(cue.includes("#EXT-X-CUE-OUT:30.000"));
  assert.ok(cue.includes("#EXT-X-CUE-IN"));
  assert.ok(!cue.includes("#EXT-X-DATERANGE"));

  const both = writeMediaPlaylist(tl, { markerStyle: "both" }).text;
  assert.ok(both.includes("#EXT-X-DATERANGE") && both.includes("#EXT-X-CUE-OUT"));
});

test("the packager's own output parses as a valid playlist", () => {
  const r = runChain();
  const a = r.analysis.origin;
  assert.ok(!("error" in a), "the analyser must accept the simulator's manifest");
});

/* ------------------------------------------------- the chain, end to end --
 * Each fault must produce its finding, and — the half that matters more — a
 * clean run must produce none. A simulator that always trips the analyser
 * proves nothing about either of them.
 */

function run(cfg: Partial<SimConfig>) {
  return runChain({
    ...DEFAULT_CONFIG, ...cfg,
    faults: { ...DEFAULT_CONFIG.faults, ...(cfg.faults ?? {}) },
  });
}

function originCodes(cfg: Partial<SimConfig>): string[] {
  const a = run(cfg).analysis.origin;
  if ("error" in a) throw new Error(a.error);
  return a.renditions.flatMap((r) => r.findings).concat(a.crossFindings).map((f) => f.code);
}

function availStatuses(cfg: Partial<SimConfig>): AvailStatus[] {
  const c = run(cfg).analysis.comparison;
  if ("error" in c) throw new Error(c.error);
  return c.avails.map((a) => a.status);
}

test("a clean run raises nothing worse than information", () => {
  const a = run({}).analysis.origin;
  if ("error" in a) throw new Error(a.error);
  const bad = a.renditions
    .flatMap((r) => r.findings)
    .concat(a.crossFindings)
    .filter((f) => f.severity !== "info");
  assert.deepEqual(bad.map((f) => f.code), [], "no warnings or errors on a correct stream");
});

test("a clean run grades every avail as filled", () => {
  assert.deepEqual(availStatuses({}), ["filled"]);
});

test("a corrupted CRC is caught in the manifest", () => {
  assert.ok(originCodes({ faults: { invalidCrc: true } }).includes("SCTE35_CRC_INVALID"));
  assert.ok(!originCodes({}).includes("SCTE35_CRC_INVALID"), "and not otherwise");
});

test("an avail signalled off a segment boundary shows up as a start-date mismatch", () => {
  assert.ok(originCodes({ faults: { availOffBoundary: true } }).includes("DATERANGE_START_DATE_MISMATCH"));
  assert.ok(!originCodes({}).includes("DATERANGE_START_DATE_MISMATCH"));
});

test("dropping the discontinuity is reported as signalling with nothing behind it", () => {
  assert.ok(originCodes({ faults: { noDiscontinuity: true } }).includes("SIGNALLING_ONLY_STREAM"));
  assert.ok(!originCodes({}).includes("SIGNALLING_ONLY_STREAM"));
});

test("under-fill, over-fill, pass-through and no-stitch each grade as themselves", () => {
  assert.deepEqual(availStatuses({ stitchMode: "under-fill" }), ["under-filled"]);
  assert.deepEqual(availStatuses({ stitchMode: "over-fill" }), ["over-filled"]);
  assert.deepEqual(availStatuses({ stitchMode: "passthrough" }), ["passthrough"]);
  assert.deepEqual(availStatuses({ stitchMode: "drop-markers" }), ["not-stitched"]);
});

test("an avail the packager never transcribed is lost, not merely mis-filled", () => {
  // The SSAI service reads the manifest. With no marker there is nothing to
  // stitch, so the break does not appear anywhere downstream and no comparison
  // can find it — which is precisely why this failure is so expensive.
  assert.deepEqual(availStatuses({ faults: { untranscribedAvail: 1001 } }), []);
  const r = run({ faults: { untranscribedAvail: 1001 } });
  assert.equal(r.ssai.avails.length, 0, "nothing was stitched");
  assert.ok(!r.ssai.text.includes("ads/"), "no ad segments in the output");
  // The same run without the fault must still stitch, or this proves nothing.
  assert.equal(run({}).ssai.avails.length, 1);
});

test("both signalling styles and all marker styles produce an analysable stream", () => {
  for (const signalStyle of ["splice_insert", "time_signal"] as const) {
    for (const markerStyle of ["daterange", "cue-out", "both"] as const) {
      const r = run({ signalStyle, markerStyle });
      assert.ok(!("error" in r.analysis.origin), `${signalStyle}/${markerStyle}`);
      assert.deepEqual(availStatuses({ signalStyle, markerStyle }), ["filled"], `${signalStyle}/${markerStyle}`);
    }
  }
});

test("a window that opens mid-break is information, not an error", () => {
  // The short-window case reproduces the live-edge false positive the monitor
  // was taught to suppress; it must stay suppressed.
  const a = run({ faults: { shortWindow: true } }).analysis.origin;
  if ("error" in a) throw new Error(a.error);
  const orphan = a.renditions.flatMap((r) => r.findings).find((f) => f.code === "ORPHAN_CUE_IN");
  if (orphan) assert.equal(orphan.severity, "info", "a sliding window is not a fault");
});

/* ------------------------------------------------------ DASH and CSAI ---- */

function dashCodes(cfg: Partial<SimConfig>, side: "origin" | "ssai"): string[] {
  const a = run({ protocol: "dash", ...cfg }).analysis[side];
  if ("error" in a) throw new Error(a.error);
  return a.renditions.flatMap((r) => r.findings).concat(a.crossFindings).map((f) => f.code);
}

test("a clean DASH run raises nothing on either side", () => {
  assert.deepEqual(dashCodes({}, "origin"), []);
  assert.deepEqual(dashCodes({}, "ssai"), []);
});

test("the DASH pipeline is single-period in and multi-period out", () => {
  const r = run({ protocol: "dash" });
  const src = r.analysis.origin;
  const out = r.analysis.ssai;
  if ("error" in src || "error" in out) throw new Error("analysis failed");
  assert.equal(src.meta.mpd?.periodCount, 1, "the packager describes the avail with an Event");
  assert.ok((out.meta.mpd?.periodCount ?? 0) > 1, "the ad service splits the presentation");
});

test("DASH faults land on the manifest that actually carries them", () => {
  // Continuity and gaps are properties of the split output, not of the source.
  assert.ok(dashCodes({ faults: { noPeriodContinuity: true } }, "ssai").includes("NO_PERIOD_CONTINUITY_SIGNAL"));
  assert.ok(!dashCodes({ faults: { noPeriodContinuity: true } }, "origin").includes("NO_PERIOD_CONTINUITY_SIGNAL"));
  assert.ok(dashCodes({ faults: { periodGap: true } }, "ssai").includes("PERIOD_TIMELINE_GAP"));
  // A missing presentationTimeOffset is wrong wherever it appears.
  assert.ok(dashCodes({ faults: { dropPresentationTimeOffset: true } }, "origin").includes("PTO_MISMATCH"));
});

test("the SCTE-35 in a DASH EventStream is the same section the encoder emitted", () => {
  const r = run({ protocol: "dash" });
  const payload = r.timeline.signals[0].base64;
  const mpd = r.stages.find((s) => s.id === "packager")!.text!;
  assert.ok(mpd.includes(`<scte35:Binary>${payload}</scte35:Binary>`));
  assert.equal(parseSpliceInfoSection(payload).crcValid, true);
});

test("client-side insertion leaves the manifest alone", () => {
  const r = run({ adMode: "csai" });
  assert.ok(r.csai, "a client-side run models the player");
  assert.equal(r.csai!.manifestUnchanged, true);
  // Nothing was stitched, so there is no stitched manifest to compare against.
  assert.ok("error" in r.analysis.comparison);
  assert.ok(!r.stages.find((s) => s.id === "origin")!.text!.includes("ads/"));
});

test("each client-side failure produces its own outcome", () => {
  assert.equal(run({ adMode: "csai" }).csai!.outcome, "filled");
  assert.equal(run({ adMode: "csai", faults: { adBlocked: true } }).csai!.outcome, "empty");
  assert.equal(run({ adMode: "csai", faults: { adServerTimeout: true } }).csai!.outcome, "empty");
  assert.equal(run({ adMode: "csai", faults: { creativeFailsToLoad: true } }).csai!.outcome, "under-filled");
});

test("a blocked client-side ad fires no beacons at all", () => {
  const blocked = run({ adMode: "csai", faults: { adBlocked: true } }).csai!;
  assert.equal(blocked.events.filter((e) => e.kind === "beacon").length, 0);
  // Server-side, the same avail still reports, which is the trade being shown.
  assert.ok(run({}).ssai.beacons.length > 0);
});
