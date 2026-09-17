import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeUrl, analyzeText } from "../src/lib/runner";
import { comparePipeline } from "../src/lib/pipeline";
import { getSample, recordedFetcher, sampleEntryUrl } from "../src/lib/samples";

async function sample(id: string) {
  const s = getSample(id)!;
  return analyzeUrl(sampleEntryUrl(s), 6, recordedFetcher(s));
}

test("classifies every SSAI outcome in the worked example", async () => {
  const [src, out] = await Promise.all([sample("ssai-source"), sample("ssai-output")]);
  const c = comparePipeline(src, out, { source: "packager feed", stitched: "SSAI output" });

  assert.deepEqual(
    c.avails.map((a) => a.status),
    ["filled", "under-filled", "passthrough", "not-stitched"],
  );

  assert.equal(c.summary.verdict, "fail");
  assert.equal(c.summary.filled, 1);
  assert.equal(c.summary.underFilled, 1);
  assert.equal(c.summary.passthrough, 1);
  assert.equal(c.summary.notStitched, 1);

  // 30s filled + 18s partially filled, out of 120s signalled.
  assert.ok(Math.abs(c.summary.fillRate - 0.4) < 0.001);

  const codes = c.findings.map((f) => f.code);
  assert.ok(codes.includes("AVAIL_NOT_STITCHED"));
  assert.ok(codes.includes("AVAIL_PASSED_THROUGH"));
  assert.ok(codes.includes("AVAIL_UNDER_FILLED"));
});

test("an avail missing from the end of the output is still caught", async () => {
  // The comparison window must come from the media extent. If it came from
  // where the breaks are, a missing final avail would shrink the window until
  // it excluded itself and the failure would disappear.
  const [src, out] = await Promise.all([sample("ssai-source"), sample("ssai-output")]);
  const c = comparePipeline(src, out);
  const missing = c.avails.filter((a) => a.status === "not-stitched");
  assert.equal(missing.length, 1);
  assert.ok(missing[0].pdt! > c.avails[0].pdt!, "the missing avail is the last one");
});

test("a correctly stitched stream produces no findings at all", async () => {
  const src = await sample("ssai-source");

  // Rebuild the source timeline exactly, substituting ad media into each
  // avail. The content runs between avails are 12s, 12s, 6s and 6s.
  const lines = [
    "#EXTM3U",
    "#EXT-X-VERSION:6",
    "#EXT-X-TARGETDURATION:6",
    "#EXT-X-PROGRAM-DATE-TIME:2026-09-17T12:00:00.000Z",
  ];
  const contentBefore = [2, 2, 1, 1];
  let seq = 2000;
  for (let i = 0; i < 4; i++) {
    for (let s = 0; s < contentBefore[i]; s++) lines.push("#EXTINF:6.000,", `content/prog_${seq++}.ts`);
    lines.push("#EXT-X-CUE-OUT:30.0", "#EXT-X-DISCONTINUITY");
    for (let s = 0; s < 5; s++) lines.push("#EXTINF:6.000,", `ads/creative-${100 + i}/seg_000${s}.ts`);
    lines.push("#EXT-X-CUE-IN", "#EXT-X-DISCONTINUITY");
  }
  lines.push("#EXTINF:6.000,", `content/prog_${seq++}.ts`, "#EXT-X-ENDLIST");
  const out = analyzeText(lines.join("\n"), "stitched");

  const c = comparePipeline(src, out);
  assert.equal(c.summary.filled, 4, "all four avails filled");
  assert.equal(c.summary.fillRate, 1);
  assert.deepEqual(c.findings, [], "a healthy pipeline must report nothing");
  assert.equal(c.summary.verdict, "pass");
});

test("refuses to compare streams that share no wall clock", async () => {
  const src = await sample("ssai-source");
  const noPdt = analyzeText(
    ["#EXTM3U", "#EXT-X-TARGETDURATION:6", "#EXTINF:6.000,", "a.ts", "#EXT-X-CUE-OUT:30.0", "#EXTINF:6.000,", "b.ts", "#EXT-X-CUE-IN", "#EXTINF:6.000,", "c.ts", "#EXT-X-ENDLIST"].join("\n"),
    "no-pdt",
  );
  const c = comparePipeline(src, noPdt);
  assert.ok(
    c.findings.some((f) => f.code === "NO_COMMON_CLOCK"),
    "without a shared clock the comparison is meaningless and must say so",
  );
});

test("substitution detection distinguishes ad media from passthrough", async () => {
  const [src, out] = await Promise.all([sample("ssai-source"), sample("ssai-output")]);
  const c = comparePipeline(src, out);
  const filled = c.avails.find((a) => a.status === "filled")!;
  const passed = c.avails.find((a) => a.status === "passthrough")!;
  assert.equal(filled.substituted, true, "ad segment paths differ from the surrounding programme");
  assert.equal(passed.substituted, false, "passthrough reuses the programme's own path shape");
});
