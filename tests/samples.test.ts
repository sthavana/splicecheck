import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeUrl } from "../src/lib/runner";
import { SAMPLES, getSample, recordedFetcher, sampleEntryUrl } from "../src/lib/samples";

/**
 * These run against real captures from production services. They are the
 * regression guard that matters: a change that alters what the analyser says
 * about an actual operator's stream fails the build.
 */

async function analyzeSample(id: string) {
  const s = getSample(id)!;
  return analyzeUrl(sampleEntryUrl(s), 6, recordedFetcher(s));
}

test("every declared sample has its bundle on disk", async () => {
  for (const s of SAMPLES) {
    const r = await analyzeSample(s.id);
    assert.ok(r.renditions.length > 0, `${s.id} produced no renditions`);
  }
});

test("multi-period DASH: periods, paired avails, and the continuity finding", async () => {
  const r = await analyzeSample("multiperiod-dash");
  const mpd = r.renditions[0];

  assert.equal(mpd.protocol, "dash");
  assert.equal(r.summary.errors, 0, "this manifest is well-formed; errors here mean a false positive");
  assert.equal(mpd.periods!.length, 13);
  assert.equal(mpd.breaks.length, 9);

  // Each avail is opened by a 0x30 descriptor and closed by the 0x31 that
  // carries the same segmentation_event_id.
  for (const b of mpd.breaks) {
    assert.equal(b.segmentationTypeId, 0x30, "Provider Advertisement Start");
    assert.ok(b.closed, `break ${b.index} should be closed by its end descriptor`);
    assert.equal(b.boundedBy, "end event");
    assert.ok(
      Math.abs(b.actualDuration! - b.signalledDuration!) < 0.01,
      `break ${b.index} should land on its signalled duration`,
    );
  }

  const codes = new Set(mpd.findings.map((f) => f.code));
  assert.ok(codes.has("NO_PERIOD_CONTINUITY_SIGNAL"), "identical representations across boundaries, undeclared");
  // Timeline integrity: nothing should be reported about the boundaries.
  assert.ok(!codes.has("PERIOD_TIMELINE_GAP"));
  assert.ok(!codes.has("PERIOD_TIMELINE_OVERLAP"));
  assert.ok(!codes.has("PTO_MISMATCH"));
  assert.ok(!codes.has("UNCLOSED_BREAK"));
});

test("DASH EventStream: an avail bounded by auto_return is not reported as open", async () => {
  const r = await analyzeSample("unified-dash");
  const mpd = r.renditions[0];

  assert.equal(r.summary.errors, 0);
  assert.ok(mpd.breaks.length >= 4, "the window carries several avails");

  // These avails state their extent through splice_insert break_duration with
  // auto_return, so no end event is coming and none should be expected.
  for (const b of mpd.breaks) {
    assert.ok(b.closed, "an avail with a declared duration is bounded, not open");
    assert.equal(b.boundedBy, "auto_return duration");
    assert.equal(b.actualDuration, b.signalledDuration);
  }
  const codes = new Set(mpd.findings.map((f) => f.code));
  assert.ok(!codes.has("UNCLOSED_BREAK"));
  assert.ok(!codes.has("BREAK_IN_PROGRESS"));
  assert.ok(codes.has("SCTE35_CRC_INVALID"), "this packager ships a stale CRC");
});

test("recorded HLS: all renditions agree, and dual signalling counts once", async () => {
  const r = await analyzeSample("unified-hls");

  assert.equal(r.renditions.length, 4, "four renditions were captured");
  assert.equal(r.summary.errors, 0);
  assert.deepEqual(
    r.crossFindings.map((f) => f.code),
    [],
    "renditions splice at the same points, so cross-rendition comparison must stay silent",
  );

  const counts = new Set(r.renditions.map((x) => x.breaks.length));
  assert.equal(counts.size, 1, "every rendition carries the same number of breaks");

  const first = r.renditions[0];
  const codes = new Set(first.findings.map((f) => f.code));
  assert.ok(codes.has("DUAL_SIGNALLING"), "DATERANGE and CUE-OUT at one splice point");
  assert.ok(codes.has("SIGNALLING_ONLY_STREAM"), "no discontinuities: this feed is upstream of stitching");
  assert.ok(
    !codes.has("NO_DISCONTINUITY_AT_BREAK_START"),
    "an unstitched feed must not be accused of missing discontinuities",
  );
  assert.ok(codes.has("SCTE35_CRC_INVALID"), "this packager ships a stale CRC");

  // The decoded SCTE-35 must agree with what the manifest advertises.
  for (const b of first.breaks.filter((x) => x.closed)) {
    assert.ok(Math.abs(b.actualDuration! - b.signalledDuration!) < 0.1);
  }
});
