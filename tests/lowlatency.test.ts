import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeText } from "../src/lib/runner";
import { parseMedia } from "../src/lib/hls";

/*
 * Low latency changes what the numbers in a manifest mean. A player is no
 * longer three segments behind the edge, it is about a second behind it, and
 * everything an ad decision has to do must fit inside that. These rules are
 * about the contract that makes the short distance sustainable — and, where it
 * is not, about saying so rather than letting the stream rebuffer.
 */

const codes = (text: string, uri = "https://example.com/index.m3u8") =>
  analyzeText(text, uri)
    .renditions.flatMap((r) => r.findings)
    .map((f) => `${f.severity}:${f.code}`);

const ll = (codes: string[]) => codes.filter((c) => c.includes("LL_"));

/* ------------------------------------------------------------------ HLS */

const HLS = `#EXTM3U
#EXT-X-VERSION:9
#EXT-X-TARGETDURATION:4
#EXT-X-PART-INF:PART-TARGET=0.33334
#EXT-X-SERVER-CONTROL:CAN-BLOCK-RELOAD=YES,PART-HOLD-BACK=1.5,CAN-SKIP-UNTIL=24.0,CAN-SKIP-DATERANGES=YES
#EXT-X-MEDIA-SEQUENCE:266
#EXT-X-PROGRAM-DATE-TIME:2026-01-01T00:00:00.000Z
#EXTINF:4.00008,
fileSequence266.mp4
#EXT-X-CUE-OUT:30.000
#EXT-X-PART:DURATION=0.33334,URI="part267.1.mp4",INDEPENDENT=YES
#EXT-X-PART:DURATION=0.33334,URI="part267.2.mp4"
#EXTINF:4.00008,
fileSequence267.mp4
#EXT-X-PRELOAD-HINT:TYPE=PART,URI="part268.1.mp4"
#EXT-X-RENDITION-REPORT:URI="../1M/index.m3u8",LAST-MSN=267,LAST-PART=1
`;

test("the low-latency tags are parsed rather than merely detected", () => {
  const m = parseMedia(HLS, "https://example.com/index.m3u8");
  assert.equal(m.lowLatency, true);
  assert.equal(m.partTargetDuration, 0.33334);
  assert.equal(m.parts.length, 2);
  assert.equal(m.parts[0].independent, true);
  assert.equal(m.parts[1].independent, false);
  assert.equal(m.serverControl?.canBlockReload, true);
  assert.equal(m.serverControl?.partHoldBack, 1.5);
  assert.equal(m.serverControl?.canSkipDateRanges, true);
  assert.equal(m.preloadHint?.uri, "part268.1.mp4");
  assert.equal(m.renditionReports[0].lastMsn, 267);
});

test("a correctly formed low-latency playlist raises nothing above information", () => {
  const bad = ll(codes(HLS)).filter((c) => !c.startsWith("info:"));
  assert.deepEqual(bad, []);
});

test("PART-HOLD-BACK below three part durations is an error", () => {
  // The specification's floor. Under it, a client sits closer to live than the
  // publishing cadence can sustain and runs out of parts.
  const c = ll(codes(HLS.replace("PART-HOLD-BACK=1.5", "PART-HOLD-BACK=0.8")));
  assert.ok(c.includes("error:LL_PART_HOLD_BACK_TOO_SMALL"), c.join(" "));
  // Exactly three times is allowed.
  assert.ok(!ll(codes(HLS.replace("PART-HOLD-BACK=1.5", "PART-HOLD-BACK=1.00002"))).some((x) => x.includes("HOLD_BACK")));
});

test("parts without a server control contract are an error", () => {
  const c = ll(codes(HLS.replace(/#EXT-X-SERVER-CONTROL:.*\n/, "")));
  assert.ok(c.includes("error:LL_NO_SERVER_CONTROL"));
});

test("parts without blocking reload spend the latency they saved", () => {
  const c = ll(codes(HLS.replace("CAN-BLOCK-RELOAD=YES", "CAN-BLOCK-RELOAD=NO")));
  assert.ok(c.includes("warning:LL_NO_BLOCKING_RELOAD"));
});

test("delta updates that drop DATERANGE hide the break from half the viewers", () => {
  // The one that matters for advertising: clients using delta updates stop
  // seeing the ad signalling while clients doing full reloads still see it.
  const c = ll(codes(HLS.replace(",CAN-SKIP-DATERANGES=YES", "")));
  assert.ok(c.includes("warning:LL_DELTA_UPDATE_DROPS_DATERANGES"), c.join(" "));
  // Offering no delta updates at all is not the same fault.
  assert.ok(!ll(codes(HLS.replace(",CAN-SKIP-UNTIL=24.0,CAN-SKIP-DATERANGES=YES", ""))).some((x) => x.includes("DELTA")));
});

test("the decision budget is stated when the stream carries advertising", () => {
  assert.ok(ll(codes(HLS)).includes("info:LL_AD_DECISION_BUDGET"));
  // No markers, nothing to say about ad decisions.
  assert.ok(!ll(codes(HLS.replace("#EXT-X-CUE-OUT:30.000\n", ""))).some((x) => x.includes("BUDGET")));
});

test("an ordinary playlist gets none of these rules", () => {
  const plain = HLS.replace(/#EXT-X-PART[^\n]*\n/g, "")
    .replace(/#EXT-X-PRELOAD-HINT[^\n]*\n/, "")
    .replace(/#EXT-X-SERVER-CONTROL[^\n]*\n/, "")
    .replace(/#EXT-X-RENDITION-REPORT[^\n]*\n/, "");
  assert.deepEqual(ll(codes(plain)), []);
});

/* ----------------------------------------------------------------- DASH */

const DASH = (o: { sd?: boolean; chunked?: boolean; segTicks?: number; spd?: string } = {}) => `<?xml version="1.0"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="dynamic" availabilityStartTime="2026-01-01T00:00:00Z"
     minimumUpdatePeriod="PT0S" minBufferTime="PT1S" suggestedPresentationDelay="${o.spd ?? "PT3S"}">
  ${o.sd === false ? "" : `<ServiceDescription id="0"><Latency target="3000" min="2000" max="6000"/></ServiceDescription>`}
  <Period id="p0" start="PT0S">
    <EventStream schemeIdUri="urn:scte:scte35:2014:xml+bin" timescale="90000"><Event presentationTime="0" duration="2700000" id="1"/></EventStream>
    <AdaptationSet mimeType="video/mp4" segmentAlignment="true">
      <SegmentTemplate timescale="90000" duration="${o.segTicks ?? 180000}" startNumber="1"
        ${o.chunked === false ? "" : 'availabilityTimeOffset="1.9" availabilityTimeComplete="false"'}
        media="v/$Number$.m4s" initialization="v/init.mp4"/>
      <Representation id="v1" codecs="avc1.64001f" width="1280" height="720" bandwidth="3000000"/>
    </AdaptationSet>
  </Period>
</MPD>`;

const dashLl = (o = {}) => ll(codes(DASH(o), "https://example.com/manifest.mpd"));

test("a correctly formed low-latency MPD raises nothing above information", () => {
  assert.deepEqual(dashLl().filter((c) => !c.startsWith("info:")), []);
});

test("chunked delivery with no declared target leaves every player to guess", () => {
  assert.ok(dashLl({ sd: false }).includes("warning:LL_DASH_NO_LATENCY_TARGET"));
});

test("a target shorter than a segment is unreachable without chunking", () => {
  // 6s segments, 3s target, segments only available once complete.
  assert.ok(dashLl({ chunked: false, segTicks: 540000 }).includes("error:LL_DASH_TARGET_UNREACHABLE"));
  // The same target with 2s segments is simply achievable.
  assert.ok(!dashLl({ chunked: false }).some((c) => c.includes("UNREACHABLE")));
});

test("two different live points in one manifest are reported", () => {
  assert.ok(dashLl({ spd: "PT12S" }).includes("warning:LL_DASH_DELAY_DISAGREEMENT"));
  assert.ok(!dashLl({ spd: "PT3S" }).some((c) => c.includes("DISAGREEMENT")));
});

test("publishing early while claiming the segment is complete is contradictory", () => {
  const text = DASH().replace(' availabilityTimeComplete="false"', "");
  assert.ok(ll(codes(text, "https://example.com/manifest.mpd")).includes("warning:LL_DASH_EARLY_AVAILABILITY_WITHOUT_CHUNKING"));
});

test("an ordinary live MPD gets none of these rules", () => {
  assert.deepEqual(dashLl({ sd: false, chunked: false }), []);
});
