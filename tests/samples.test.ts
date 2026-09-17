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

test("recorded multi-period DASH: periods, breaks and the continuity finding", async () => {
  const r = await analyzeSample("telus-dash");
  const mpd = r.renditions[0];

  assert.equal(mpd.protocol, "dash");
  assert.equal(r.summary.errors, 0, "this is a well-formed service; errors here mean a false positive");
  assert.ok(mpd.periods!.length >= 20, "multi-period capture");
  assert.ok(mpd.breaks.length >= 20, "each avail is signalled");

  // Ad breaks pair start to end by segmentation event id.
  const closed = mpd.breaks.filter((b) => b.closed);
  assert.ok(closed.length >= 20);
  for (const b of closed) {
    assert.ok(b.eventId !== undefined, "every break carries a segmentation event id");
  }

  // In this capture every avail overruns its signalled duration by a uniform
  // 15ms or 30ms — quantisation, not a fault — except exactly one, which runs
  // 128ms short. That outlier is the interesting part and must stay reported:
  // it is ~4 frames of the last creative in the pod being cut.
  const drift = (b: (typeof closed)[number]) => b.actualDuration! - b.signalledDuration!;
  const outliers = closed.filter((b) => Math.abs(drift(b)) > 0.05);
  assert.equal(outliers.length, 1, "one avail in this capture genuinely runs short");
  assert.ok(drift(outliers[0]) < 0, "it underruns rather than overruns");
  assert.ok(Math.abs(drift(outliers[0]) + 0.1285) < 0.005, "by about 128ms");
  for (const b of closed.filter((x) => !outliers.includes(x))) {
    assert.ok(Math.abs(drift(b)) <= 0.05, `break ${b.index} drifted unexpectedly`);
  }
  assert.ok(
    mpd.findings.some((f) => f.code === "BREAK_UNDERRUN"),
    "the short avail must be reported",
  );

  const codes = new Set(mpd.findings.map((f) => f.code));
  assert.ok(codes.has("NO_PERIOD_CONTINUITY_SIGNAL"), "identical representations across boundaries, undeclared");
  assert.ok(codes.has("EVENT_MISSING_ID"), "SCTE-35 events cannot be deduplicated across MPD refreshes");
  assert.ok(codes.has("DUPLICATE_EVENT_STREAMS"), "same signal in a standard and a vendor scheme");

  // Period continuity: no boundary should be reported as a gap or overlap.
  assert.ok(!codes.has("PERIOD_TIMELINE_GAP"));
  assert.ok(!codes.has("PERIOD_TIMELINE_OVERLAP"));
  assert.ok(!codes.has("PTO_MISMATCH"));
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
