import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { analyzeText } from "../src/lib/runner";
import { analyzeCrossVariant } from "../src/lib/analyze";
import { comparePipeline } from "../src/lib/pipeline";

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

test("cross-rendition: a break at the very edge of the shared window is not called missing", () => {
  // Two renditions of the same stream whose windows have rolled slightly
  // differently: the older break's CUE-OUT has already gone from one.
  const head = ["#EXTM3U", "#EXT-X-VERSION:6", "#EXT-X-TARGETDURATION:6"];
  const withEdgeBreak = [
    ...head,
    "#EXT-X-PROGRAM-DATE-TIME:2026-09-17T10:00:00.000Z",
    "#EXT-X-CUE-OUT:12.0",
    "#EXTINF:6.000,",
    "ad_a0.ts",
    "#EXTINF:6.000,",
    "ad_a1.ts",
    "#EXT-X-CUE-IN",
    "#EXTINF:6.000,",
    "prog_a.ts",
  ].join("\n");
  const withoutIt = [
    ...head,
    "#EXT-X-PROGRAM-DATE-TIME:2026-09-17T10:00:00.000Z",
    "#EXTINF:6.000,",
    "ad_a0.ts",
    "#EXTINF:6.000,",
    "ad_a1.ts",
    "#EXT-X-CUE-IN",
    "#EXTINF:6.000,",
    "prog_a.ts",
  ].join("\n");

  const a = analyzeText(withEdgeBreak, "a").renditions[0];
  const b = analyzeText(withoutIt, "b").renditions[0];
  a.label = "video";
  b.label = "audio";
  const cross = analyzeCrossVariant([a, b]);
  assert.ok(
    !cross.some((f) => f.code === "VARIANT_MISSING_BREAK"),
    "window skew between renditions must not read as a missing break",
  );
});

test("cross-rendition: a break closing earlier in audio than video is not a count mismatch", () => {
  // Audio segments are shorter, so the audio rendition reaches the return
  // first and the newest break is closed there while still open in video.
  const build = (closed: boolean, segDur: number) => {
    const lines = [
      "#EXTM3U",
      "#EXT-X-VERSION:6",
      "#EXT-X-TARGETDURATION:6",
      "#EXT-X-PROGRAM-DATE-TIME:2026-09-17T10:00:00.000Z",
    ];
    for (let i = 0; i < 20; i++) lines.push(`#EXTINF:${segDur.toFixed(3)},`, `prog_${i}.ts`);
    lines.push("#EXT-X-CUE-OUT:12.0", "#EXT-X-DISCONTINUITY");
    for (let i = 0; i < 2; i++) lines.push(`#EXTINF:${segDur.toFixed(3)},`, `ad_${i}.ts`);
    if (closed) lines.push("#EXT-X-CUE-IN", "#EXT-X-DISCONTINUITY", "#EXTINF:6.000,", "tail.ts");
    return lines.join("\n");
  };
  const video = analyzeText(build(false, 6), "video").renditions[0];
  const audio = analyzeText(build(true, 6), "audio").renditions[0];
  video.label = "video";
  audio.label = "audio";
  const cross = analyzeCrossVariant([video, audio]);
  assert.ok(
    !cross.some((f) => f.code === "VARIANT_BREAK_COUNT_MISMATCH"),
    "a break straddling the live edge must not count as a signalling difference",
  );
});

// ------------------------------------------------------------ interstitials --

test("HLS interstitials: every planted defect is reported, once", () => {
  const r = analyzeText(readFileSync("fixtures/interstitials.m3u8", "utf8"), "interstitials.m3u8");
  const rd = r.renditions[0];
  assert.equal(rd.interstitials!.length, 7);

  const codes = rd.findings.map((f) => f.code);
  for (const expected of [
    "INTERSTITIAL_NO_ASSET",
    "INTERSTITIAL_AMBIGUOUS_ASSET",
    "INTERSTITIAL_UNBOUNDED",
    "INTERSTITIAL_UNKNOWN_ATTRIBUTE_VALUE",
    "INTERSTITIAL_PRE_AND_POST",
    "INTERSTITIAL_OVERLAP",
  ]) {
    assert.ok(codes.includes(expected), `expected ${expected}`);
  }
  // Only one pair actually overlaps, so only one overlap may be reported.
  assert.equal(codes.filter((c) => c === "INTERSTITIAL_OVERLAP").length, 1);
});

test("HLS interstitials: attributes are read off the DATERANGE", () => {
  const r = analyzeText(readFileSync("fixtures/interstitials.m3u8", "utf8"), "i.m3u8");
  const pre = r.renditions[0].interstitials!.find((i) => i.id === "pre")!;
  assert.deepEqual(pre.cue, ["PRE", "ONCE"]);
  assert.equal(pre.duration, 15);
  assert.equal(pre.assetUri, "https://ads.example.com/preroll.m3u8");
  assert.equal(pre.assetList, undefined);
});

test("HLS interstitials: a well-formed one reports nothing", () => {
  const clean = [
    "#EXTM3U",
    "#EXT-X-VERSION:9",
    "#EXT-X-TARGETDURATION:6",
    "#EXT-X-PROGRAM-DATE-TIME:2026-09-18T10:00:00.000Z",
    '#EXT-X-DATERANGE:ID="mid",CLASS="com.apple.hls.interstitial",START-DATE="2026-09-18T10:00:12.000Z",DURATION=30.0,X-ASSET-LIST="https://ads.example.com/list.json",X-RESUME-OFFSET=0,X-SNAP="OUT,IN"',
    "#EXTINF:6.000,",
    "a.ts",
    "#EXTINF:6.000,",
    "b.ts",
    "#EXT-X-ENDLIST",
  ].join("\n");
  const r = analyzeText(clean, "clean.m3u8");
  assert.equal(r.summary.errors, 0);
  assert.equal(r.summary.warnings, 0);
  assert.equal(r.renditions[0].interstitials!.length, 1);
});

test("HLS: an interstitial DATERANGE is not counted as a spliced avail", () => {
  // The two models are different: an interstitial names an asset for the
  // player to load, and splices nothing into this playlist.
  const r = analyzeText(readFileSync("fixtures/interstitials.m3u8", "utf8"), "i.m3u8");
  assert.equal(r.renditions[0].breaks.length, 0);
  assert.ok(r.renditions[0].findings.some((f) => f.code === "INTERSTITIAL_SIGNALLING"));
});

/* ------------------------------------------------- break left open live --
 * A break open at the live edge is normally just a break on air, so this rule
 * turns on the one thing that separates the two cases: the duration the break
 * declared for itself. Both halves are tested, because a rule that fires on a
 * healthy stream is worse than no rule.
 */

const ON_AIR = `#EXTM3U
#EXT-X-VERSION:6
#EXT-X-TARGETDURATION:6
#EXT-X-MEDIA-SEQUENCE:10
#EXT-X-PROGRAM-DATE-TIME:2026-01-01T00:00:00.000Z
#EXTINF:6.000,
a.ts
#EXT-X-CUE-OUT:60.000
#EXTINF:6.000,
b.ts
#EXTINF:6.000,
c.ts
`;

const more = (n: number, tag: string) =>
  Array.from({ length: n }, (_, i) => `#EXTINF:6.000,\n${tag}${i}.ts`).join("\n") + "\n";

function severityCodes(text: string): string[] {
  const r = analyzeText(text, "live.m3u8");
  return r.renditions.flatMap((x) => x.findings).map((f) => `${f.severity}:${f.code}`);
}

test("a break on air well inside its declared duration is only information", () => {
  // 12s elapsed against a 60s declaration: the CUE-IN is not due yet.
  assert.ok(severityCodes(ON_AIR).includes("info:BREAK_IN_PROGRESS"));
  assert.ok(!severityCodes(ON_AIR).some((c) => c.includes("BREAK_OVERRUN_UNCLOSED")));
});

test("a break just past its declared duration stays inside the margin", () => {
  // 66s against 60s, with a 6s target duration: one segment late is not a fault.
  const edge = ON_AIR + more(9, "e");
  assert.ok(severityCodes(edge).includes("info:BREAK_IN_PROGRESS"));
  assert.ok(!severityCodes(edge).some((c) => c.includes("BREAK_OVERRUN_UNCLOSED")));
});

test("a break far past its declared duration and still open is an error", () => {
  // 90s against 60s. The packager has had five segments to write the CUE-IN.
  const over = ON_AIR + more(13, "d");
  assert.ok(severityCodes(over).includes("error:BREAK_OVERRUN_UNCLOSED"));
  assert.ok(!severityCodes(over).includes("info:BREAK_IN_PROGRESS"), "one verdict, not both");
});

test("a break with no declared duration is never judged on length", () => {
  // Nothing says how long it should be, so running long says nothing either.
  const noDuration = ON_AIR.replace("#EXT-X-CUE-OUT:60.000", "#EXT-X-CUE-OUT") + more(20, "f");
  assert.ok(!severityCodes(noDuration).some((c) => c.includes("BREAK_OVERRUN_UNCLOSED")));
});

test("a window that opens part-way through a break is not judged on length", () => {
  // The break's real extent is off the front of the window, so elapsed time
  // here is a property of the window, not of the break.
  const clipped = `#EXTM3U
#EXT-X-VERSION:6
#EXT-X-TARGETDURATION:6
#EXT-X-MEDIA-SEQUENCE:40
#EXT-X-CUE-OUT:30.000
#EXT-X-PROGRAM-DATE-TIME:2026-01-01T00:04:00.000Z
${more(15, "g")}`;
  assert.ok(!severityCodes(clipped).some((c) => c.includes("BREAK_OVERRUN_UNCLOSED")));
});

/* --------------------------------------------------- getting it off the screen --
 * A finding is only worth having if it can reach whoever runs the packager.
 * The report has to carry the codes, the locations and — the part people
 * forget — what was checked, so that finding nothing means something.
 */

import { analysisToMarkdown, comparisonToMarkdown, reportFilename } from "../src/lib/report";

const LIVE = readFileSync("fixtures/broken.m3u8", "utf8");

test("a report states what was checked, not only what was found", () => {
  const md = analysisToMarkdown(analyzeText(LIVE, "https://origin.example/live/index.m3u8"));
  assert.match(md, /# Ad signalling report/);
  assert.match(md, /\*\*Source:\*\* `https:\/\/origin\.example\/live\/index\.m3u8`/);
  assert.match(md, /## What was checked/);
  assert.match(md, /rendition\(s\)/);
  assert.match(md, /ad break\(s\) reconstructed/);
  // Absence of a segment probe has to be stated, or a clean report overclaims.
  assert.match(md, /Segments were not opened/);
});

test("every finding reaches the report with its code and location", () => {
  const r = analyzeText(LIVE, "https://origin.example/live/index.m3u8");
  const md = analysisToMarkdown(r);
  const all = [...r.crossFindings, ...r.renditions.flatMap((x) => x.findings)];
  assert.ok(all.length > 0, "fixture must produce findings");
  for (const f of all) {
    assert.ok(md.includes(f.code), `${f.code} missing from the report`);
  }
  assert.match(md, /Codes are stable/);
});

test("a clean analysis says so rather than printing an empty heading", () => {
  const clean = `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PROGRAM-DATE-TIME:2026-01-01T00:00:00.000Z\n#EXTINF:6.0,\na.ts\n#EXTINF:6.0,\nb.ts\n#EXT-X-ENDLIST\n`;
  const md = analysisToMarkdown(analyzeText(clean, "https://origin.example/vod.m3u8"));
  assert.match(md, /None\. Everything checked above is as it should be\./);
});

test("a pipeline comparison exports its avails and its fill rate", () => {
  const src = analyzeText(LIVE, "source");
  const out = analyzeText(LIVE, "output");
  const md = comparisonToMarkdown(comparePipeline(src, out));
  assert.match(md, /# Pipeline comparison report/);
  assert.match(md, /fill rate/i);
  assert.match(md, /\| # \| Wall clock \| Status \|/);
});

test("report filenames are safe, sortable and do not collide", () => {
  const at = Date.UTC(2026, 8, 19, 15, 4);
  const a = reportFilename("https://origin.example/live/ch1/index.m3u8", "md", at);
  assert.match(a, /^splicecheck-origin\.example-2026-09-19-15-04\.md$/);
  // A pasted manifest has no URL to name it after.
  assert.match(reportFilename("pasted manifest", "json", at), /^splicecheck-.*\.json$/);
  assert.ok(!/[/\\:*?"<>|]/.test(reportFilename('https://x.example/a b?c="d"', "md", at)));
});
