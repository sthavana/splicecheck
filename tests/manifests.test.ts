import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { analyzeText } from "../src/lib/runner";

function codes(text: string): Set<string> {
  const r = analyzeText(text, "fixture");
  return new Set([...r.crossFindings, ...r.renditions.flatMap((x) => x.findings)].map((f) => f.code));
}

test("HLS: every planted defect is reported", () => {
  const found = codes(readFileSync("fixtures/broken.m3u8", "utf8"));
  for (const expected of [
    "TARGETDURATION_EXCEEDED",
    "SCTE35_DECODE_FAILED",
    "SCTE35_CRC_INVALID",
    "DATERANGE_START_DATE_MISMATCH",
    "SIGNAL_DURATION_DISAGREEMENT",
    "BREAK_UNDERRUN",
    "NO_DISCONTINUITY_AT_BREAK_END",
    "ORPHAN_CUE_IN",
    "UNCLOSED_BREAK",
  ]) {
    assert.ok(found.has(expected), `expected ${expected}`);
  }
});

test("DASH: every planted defect is reported", () => {
  const found = codes(readFileSync("fixtures/broken.mpd", "utf8"));
  for (const expected of [
    "DUPLICATE_PERIOD_ID",
    "PERIOD_TIMELINE_GAP",
    "PERIOD_TIMELINE_OVERLAP",
    "PTO_MISMATCH",
    "EMPTY_PERIOD",
    "REPRESENTATION_SET_CHANGED",
    "AV_DURATION_SKEW",
    "SCTE35_DECODE_FAILED",
    "UNCLOSED_BREAK",
  ]) {
    assert.ok(found.has(expected), `expected ${expected}`);
  }
});

test("HLS: a clean playlist with no ad signalling reports no faults", () => {
  const clean = [
    "#EXTM3U",
    "#EXT-X-VERSION:3",
    "#EXT-X-TARGETDURATION:6",
    "#EXT-X-MEDIA-SEQUENCE:0",
    "#EXT-X-PROGRAM-DATE-TIME:2026-09-17T10:00:00.000Z",
    "#EXTINF:6.000,",
    "a.ts",
    "#EXTINF:6.000,",
    "b.ts",
    "#EXT-X-ENDLIST",
  ].join("\n");
  const r = analyzeText(clean, "clean");
  assert.equal(r.summary.errors, 0);
  assert.equal(r.summary.warnings, 0);
  assert.equal(r.summary.verdict, "pass");
});

test("HLS: dual-signalled breaks are counted once, not twice", () => {
  // The same splice point carried as both a DATERANGE and a CUE-OUT.
  const dual = [
    "#EXTM3U",
    "#EXT-X-VERSION:6",
    "#EXT-X-TARGETDURATION:6",
    "#EXT-X-PROGRAM-DATE-TIME:2026-09-17T10:00:00.000Z",
    "#EXTINF:6.000,",
    "a.ts",
    '#EXT-X-DATERANGE:ID="b1",START-DATE="2026-09-17T10:00:06.000Z",PLANNED-DURATION=6.0,SCTE35-OUT=0xFC302000000000000000FFF00F0500E1C2787FFFFE0034BC00C00000000000E4612424',
    "#EXT-X-CUE-OUT:6.0",
    "#EXT-X-DISCONTINUITY",
    "#EXTINF:6.000,",
    "ad.ts",
    "#EXT-X-CUE-IN",
    "#EXT-X-DISCONTINUITY",
    "#EXTINF:6.000,",
    "c.ts",
    "#EXT-X-ENDLIST",
  ].join("\n");
  const r = analyzeText(dual, "dual");
  assert.equal(r.renditions[0].breaks.length, 1, "one splice point is one break");
});

test("HLS: an unstitched feed is not accused of missing discontinuities", () => {
  const signallingOnly = [
    "#EXTM3U",
    "#EXT-X-VERSION:6",
    "#EXT-X-TARGETDURATION:6",
    "#EXT-X-PROGRAM-DATE-TIME:2026-09-17T10:00:00.000Z",
    "#EXTINF:6.000,",
    "a.ts",
    "#EXT-X-CUE-OUT:6.0",
    "#EXTINF:6.000,",
    "b.ts",
    "#EXT-X-CUE-IN",
    "#EXTINF:6.000,",
    "c.ts",
    "#EXT-X-ENDLIST",
  ].join("\n");
  const found = codes(signallingOnly);
  assert.ok(!found.has("NO_DISCONTINUITY_AT_BREAK_START"));
  assert.ok(!found.has("NO_DISCONTINUITY_AT_BREAK_END"));
  assert.ok(found.has("SIGNALLING_ONLY_STREAM"));
});

test("HLS live: a window opening mid-break is not an error", () => {
  // The DVR window has slid past a CUE-OUT, leaving its CUE-IN at the top.
  const live = [
    "#EXTM3U",
    "#EXT-X-VERSION:6",
    "#EXT-X-TARGETDURATION:6",
    "#EXT-X-MEDIA-SEQUENCE:500",
    "#EXT-X-PROGRAM-DATE-TIME:2026-09-17T10:00:00.000Z",
    "#EXTINF:6.000,",
    "ad_tail.ts",
    "#EXT-X-CUE-IN",
    "#EXTINF:6.000,",
    "prog_a.ts",
    "#EXT-X-CUE-OUT:12.0",
    "#EXTINF:6.000,",
    "ad_b0.ts",
    "#EXTINF:6.000,",
    "ad_b1.ts",
    "#EXT-X-CUE-IN",
    "#EXTINF:6.000,",
    "prog_b.ts",
  ].join("\n"); // no ENDLIST: live
  const r = analyzeText(live, "live");
  assert.equal(r.summary.errors, 0, "a sliding window must not make a healthy stream report errors");
  const orphan = r.renditions[0].findings.find((f) => f.code === "ORPHAN_CUE_IN");
  assert.ok(orphan);
  assert.equal(orphan.severity, "info");
});

test("HLS: a return with no departure after a paired break is still an error", () => {
  const broken = [
    "#EXTM3U",
    "#EXT-X-VERSION:6",
    "#EXT-X-TARGETDURATION:6",
    "#EXT-X-PROGRAM-DATE-TIME:2026-09-17T10:00:00.000Z",
    "#EXTINF:6.000,",
    "prog_a.ts",
    "#EXT-X-CUE-OUT:6.0",
    "#EXTINF:6.000,",
    "ad_a.ts",
    "#EXT-X-CUE-IN",
    "#EXTINF:6.000,",
    "prog_b.ts",
    "#EXT-X-CUE-IN",
    "#EXTINF:6.000,",
    "prog_c.ts",
  ].join("\n");
  const r = analyzeText(broken, "broken");
  const orphan = r.renditions[0].findings.find((f) => f.code === "ORPHAN_CUE_IN");
  assert.ok(orphan);
  assert.equal(orphan.severity, "error", "this one is not the window boundary");
});

test("HLS live: a DATERANGE left behind by the sliding window is not a mismatch", () => {
  // The tag persists at the top of the playlist while the segments it
  // originally preceded have aged out, so START-DATE reads as earlier than
  // the position it now occupies.
  const live = [
    "#EXTM3U",
    "#EXT-X-VERSION:6",
    "#EXT-X-TARGETDURATION:6",
    "#EXT-X-MEDIA-SEQUENCE:900",
    '#EXT-X-DATERANGE:ID="old",START-DATE="2026-09-17T09:59:30.000Z",PLANNED-DURATION=30.0',
    "#EXT-X-PROGRAM-DATE-TIME:2026-09-17T10:00:00.000Z",
    "#EXTINF:6.000,",
    "ad_tail.ts",
    "#EXT-X-CUE-IN",
    "#EXTINF:6.000,",
    "prog_a.ts",
  ].join("\n");
  const r = analyzeText(live, "live");
  assert.ok(
    !r.renditions[0].findings.some((f) => f.code === "DATERANGE_START_DATE_MISMATCH"),
    "a tag trimmed by the window must not be reported",
  );
});

test("HLS: a DATERANGE claiming a time it does not occupy is still reported", () => {
  const drifted = [
    "#EXTM3U",
    "#EXT-X-VERSION:6",
    "#EXT-X-TARGETDURATION:6",
    "#EXT-X-PROGRAM-DATE-TIME:2026-09-17T10:00:00.000Z",
    "#EXTINF:6.000,",
    "prog_a.ts",
    '#EXT-X-DATERANGE:ID="late",START-DATE="2026-09-17T10:00:20.000Z",PLANNED-DURATION=30.0',
    "#EXT-X-CUE-OUT:30.0",
    "#EXTINF:6.000,",
    "ad_a.ts",
    "#EXT-X-CUE-IN",
    "#EXTINF:6.000,",
    "prog_b.ts",
  ].join("\n");
  const r = analyzeText(drifted, "drifted");
  assert.ok(
    r.renditions[0].findings.some((f) => f.code === "DATERANGE_START_DATE_MISMATCH"),
    "START-DATE 8s after the position it occupies is a real inconsistency",
  );
});
