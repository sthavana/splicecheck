import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseVast, analyzeVast, followWrappers, parseVmap, analyzeVmap, parseVastDuration,
  type VastFetcher, type StreamProfile,
} from "../src/lib/vast";

/*
 * SCTE-35 says an avail exists; VAST says what goes in it. An avail signalled
 * perfectly and filled with a creative the packager cannot use is still an
 * unfilled avail — and from the manifest it looks like a signalling fault.
 *
 * The checks lean on what a stitcher can do that a browser cannot, and the
 * reverse: no JavaScript engine, no playback-time negotiation, and an existing
 * ladder the creative has to fit into.
 */

const GOOD = `<?xml version="1.0"?>
<VAST version="4.2">
  <Ad id="a1"><InLine>
    <AdSystem>Test</AdSystem><AdTitle>Northbridge Motors</AdTitle>
    <Impression><![CDATA[https://ads.example/imp]]></Impression>
    <Error><![CDATA[https://ads.example/err]]></Error>
    <Creatives><Creative id="c1">
      <UniversalAdId idRegistry="Ad-ID">ABCD0001000H</UniversalAdId>
      <Linear>
        <Duration>00:00:30</Duration>
        <TrackingEvents>
          <Tracking event="start"/><Tracking event="firstQuartile"/><Tracking event="midpoint"/>
          <Tracking event="thirdQuartile"/><Tracking event="complete"/>
        </TrackingEvents>
        <MediaFiles>
          <MediaFile type="video/mp4" codec="avc1.64001f" width="1280" height="720" bitrate="2500" delivery="progressive"><![CDATA[https://cdn.example/a.mp4]]></MediaFile>
        </MediaFiles>
      </Linear>
    </Creative></Creatives>
  </InLine></Ad>
</VAST>`;

const PROFILE: StreamProfile = {
  codecs: ["avc1.640028", "avc1.64001f"],
  bandwidths: [5_000_000, 3_000_000],
  availSeconds: 30,
  serverSide: true,
};

const codes = (xml: string, profile: StreamProfile = PROFILE) =>
  analyzeVast(parseVast(xml), profile).findings.map((f) => `${f.severity}:${f.code}`);

/* ------------------------------------------------------------- parsing */

test("a VAST response parses to its ads, creatives and media", () => {
  const d = parseVast(GOOD);
  assert.equal(d.version, "4.2");
  assert.equal(d.ads.length, 1);
  assert.equal(d.empty, false);
  const ad = d.ads[0];
  assert.equal(ad.wrapper, false);
  assert.equal(ad.adTitle, "Northbridge Motors");
  assert.deepEqual(ad.impressions, ["https://ads.example/imp"]);
  const c = ad.creatives[0];
  assert.equal(c.kind, "linear");
  assert.equal(c.durationSec, 30);
  assert.equal(c.universalAdId, "ABCD0001000H");
  assert.equal(c.universalAdIdRegistry, "Ad-ID");
  assert.equal(c.mediaFiles[0].codec, "avc1.64001f");
  assert.equal(c.mediaFiles[0].bitrate, 2500);
  assert.deepEqual(c.trackingEvents, ["start", "firstQuartile", "midpoint", "thirdQuartile", "complete"]);
});

test("durations parse in the form VAST states them", () => {
  assert.equal(parseVastDuration("00:00:30"), 30);
  assert.equal(parseVastDuration("00:01:05.500"), 65.5);
  assert.equal(parseVastDuration("01:00:00"), 3600);
  assert.equal(parseVastDuration(undefined), undefined);
  assert.equal(parseVastDuration("nonsense"), undefined);
});

test("something that is not VAST is rejected rather than parsed as empty", () => {
  assert.throws(() => parseVast("<html><body>404</body></html>"), /not a VAST document/);
});

/* --------------------------------------------------------- the response */

test("a response that fits the stream raises nothing", () => {
  assert.deepEqual(codes(GOOD), []);
});

test("an empty response is no fill, which is not malformed but is not nothing", () => {
  const c = codes(`<VAST version="4.2"/>`);
  assert.deepEqual(c, ["warning:VAST_NO_FILL"]);
});

test("an ad with nothing to count is an error", () => {
  assert.ok(codes(GOOD.replace(/<Impression>[\s\S]*?<\/Impression>/, "")).includes("error:VAST_NO_IMPRESSION"));
  assert.ok(codes(GOOD.replace(/<Error>[\s\S]*?<\/Error>/, "")).includes("info:VAST_NO_ERROR_URL"));
});

test("a stitcher needs a duration before it fetches anything", () => {
  assert.ok(codes(GOOD.replace("<Duration>00:00:30</Duration>", "")).includes("error:VAST_NO_DURATION"));
});

test("incomplete quartile tracking is reported, and complete tracking is not", () => {
  assert.ok(codes(GOOD.replace('<Tracking event="midpoint"/>', "")).includes("warning:VAST_INCOMPLETE_TRACKING"));
  assert.ok(
    codes(GOOD.replace(/<TrackingEvents>[\s\S]*?<\/TrackingEvents>/, "")).includes("warning:VAST_NO_TRACKING"),
  );
  assert.ok(!codes(GOOD).some((c) => c.includes("TRACKING")));
});

test("an executable creative cannot run server-side, and that is the whole point", () => {
  // VPAID is JavaScript. A stitcher has no browser, so an all-VPAID response
  // is unfillable by construction however good the signalling around it is.
  const vpaid = GOOD.replace('type="video/mp4" codec="avc1.64001f"', 'type="application/javascript" apiFramework="VPAID"');
  assert.ok(codes(vpaid).includes("error:VAST_EXECUTABLE_CREATIVE"));
  // Client-side, the same response is fine.
  assert.ok(!codes(vpaid, { ...PROFILE, serverSide: false }).some((c) => c.includes("EXECUTABLE")));
});

test("a creative encoded unlike the programme forces a decoder reset", () => {
  assert.ok(codes(GOOD.replace('codec="avc1.64001f"', 'codec="hvc1.1.6.L93.B0"')).includes("warning:VAST_CODEC_MISMATCH"));
  // Same family, different profile, is not a mismatch.
  assert.ok(!codes(GOOD.replace('codec="avc1.64001f"', 'codec="avc1.4d401f"')).some((c) => c.includes("CODEC_MISMATCH")));
});

test("a creative heavier than the top rung is worth mentioning", () => {
  assert.ok(codes(GOOD.replace('bitrate="2500"', 'bitrate="12000"')).includes("info:VAST_BITRATE_ABOVE_LADDER"));
});

test("the pod is measured against the avail it was requested for", () => {
  assert.ok(codes(GOOD.replace("00:00:30", "00:00:45")).includes("error:VAST_POD_OVERRUNS_AVAIL"));
  assert.ok(codes(GOOD.replace("00:00:30", "00:00:15")).includes("warning:VAST_POD_UNDERFILLS_AVAIL"));
  // With no avail stated there is nothing to measure against.
  assert.ok(!codes(GOOD.replace("00:00:30", "00:00:45"), { codecs: PROFILE.codecs }).some((c) => c.includes("POD_")));
});

test("no media at all is the fill that cannot be delivered", () => {
  assert.ok(codes(GOOD.replace(/<MediaFiles>[\s\S]*?<\/MediaFiles>/, "")).includes("error:VAST_NO_MEDIA_FILE"));
});

/* ------------------------------------------------------- the wrappers */

const WRAP = (to: string) =>
  `<VAST version="4.2"><Ad id="w"><Wrapper><AdSystem>X</AdSystem><VASTAdTagURI><![CDATA[${to}]]></VASTAdTagURI></Wrapper></Ad></VAST>`;
const INLINE = `<VAST version="4.2"><Ad id="i"><InLine><AdSystem>X</AdSystem><AdTitle>T</AdTitle><Impression><![CDATA[https://x/i]]></Impression><Creatives><Creative><Linear><Duration>00:00:30</Duration><MediaFiles><MediaFile type="video/mp4" codec="avc1.64001f" bitrate="2500"><![CDATA[https://cdn/a.mp4]]></MediaFile></MediaFiles></Linear></Creative></Creatives></InLine></Ad></VAST>`;

const serve = (map: Record<string, string>, ms = 120): VastFetcher => async (url) =>
  map[url] ? { ok: true, status: 200, text: map[url], ms } : { ok: false, status: 404, ms };

const chainOf = (start: string, map: Record<string, string>, ms?: number, maxDepth?: number) =>
  followWrappers(parseVast(start), "https://ads.example/root", { fetcher: serve(map, ms), maxDepth });

test("a chain that reaches an inline ad resolves cleanly", async () => {
  const c = await chainOf(WRAP("https://a/1"), { "https://a/1": WRAP("https://a/2"), "https://a/2": INLINE });
  assert.equal(c.hops.length, 2);
  assert.ok(c.resolved);
  assert.deepEqual(c.findings.map((f) => f.code), []);
});

test("a hop that does not answer ends the chain and the avail", async () => {
  const c = await chainOf(WRAP("https://a/1"), {});
  assert.deepEqual(c.findings.map((f) => f.code), ["VAST_WRAPPER_UNRESOLVED"]);
  assert.equal(c.resolved, undefined);
});

test("a chain that points back at itself is caught rather than followed", async () => {
  const c = await chainOf(WRAP("https://a/1"), { "https://a/1": WRAP("https://ads.example/root") });
  assert.ok(c.findings.some((f) => f.code === "VAST_WRAPPER_LOOP"));
});

test("a chain deeper than the guidance stops at the limit", async () => {
  const map = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`https://a/${i + 1}`, WRAP(`https://a/${i + 2}`)]));
  const c = await chainOf(WRAP("https://a/1"), map);
  assert.ok(c.findings.some((f) => f.code === "VAST_WRAPPER_TOO_DEEP"));
  assert.equal(c.hops.length, 5);
});

test("a redirect that answers with an error page fails like one that does not answer", async () => {
  const c = await chainOf(WRAP("https://a/1"), { "https://a/1": "<html>no</html>" });
  assert.ok(c.findings.some((f) => f.code === "VAST_WRAPPER_UNPARSEABLE"));
});

test("round trips are serial, so the total is what matters", async () => {
  const slow = await chainOf(WRAP("https://a/1"), { "https://a/1": WRAP("https://a/2"), "https://a/2": INLINE }, 1400);
  assert.ok(slow.findings.some((f) => f.code === "VAST_CHAIN_SLOW"), `${slow.totalMs}ms`);
  const quick = await chainOf(WRAP("https://a/1"), { "https://a/1": INLINE }, 150);
  assert.ok(!quick.findings.some((f) => f.code === "VAST_CHAIN_SLOW"));
});

/* ------------------------------------------------------------- VMAP */

const VMAP = `<?xml version="1.0"?><VMAP version="1.0">
 <AdBreak timeOffset="start" breakType="linear" breakId="pre"><AdSource><AdTagURI><![CDATA[https://ads/pre]]></AdTagURI></AdSource></AdBreak>
 <AdBreak timeOffset="00:10:00" breakType="linear" breakId="mid"><AdSource><AdTagURI><![CDATA[https://ads/m1]]></AdTagURI></AdSource></AdBreak>
</VMAP>`;

test("a VMAP parses to its breaks, with time offsets resolved", () => {
  const v = parseVmap(VMAP);
  assert.equal(v.breaks.length, 2);
  assert.equal(v.breaks[0].timeOffset, "start");
  assert.equal(v.breaks[0].offsetSec, undefined, "'start' is not a time");
  assert.equal(v.breaks[1].offsetSec, 600);
  assert.deepEqual(analyzeVmap(v).map((f) => f.code), []);
});

test("a break with nowhere to go, or no time to be at, is reported", () => {
  const broken = parseVmap(`<VMAP version="1.0"><AdBreak breakType="linear" breakId="x"><AdSource/></AdBreak></VMAP>`);
  const c = analyzeVmap(broken).map((f) => f.code);
  assert.ok(c.includes("VMAP_NO_TIME_OFFSET"));
  assert.ok(c.includes("VMAP_NO_AD_SOURCE"));
});

test("two breaks at one instant are a scheduling fault, not a pod", () => {
  const dup = parseVmap(VMAP.replace('breakId="pre"', 'breakId="dup"').replace('timeOffset="start"', 'timeOffset="00:10:00"'));
  assert.ok(analyzeVmap(dup).some((f) => f.code === "VMAP_DUPLICATE_OFFSET"));
});

test("a schedule with no breaks schedules nothing", () => {
  assert.ok(analyzeVmap(parseVmap(`<VMAP version="1.0"/>`)).some((f) => f.code === "VMAP_NO_BREAKS"));
});

/* --------------------------------------- the simulator's own VAST -------
 * The chain emits a VAST response in client-side mode. It is held to the same
 * standard as the SCTE-35 encoder: what the simulator writes, the real parser
 * must read back, and the rules must accept it. A simulator that emits
 * something its own analyser rejects is describing a world that does not exist.
 */

import { runChain, DEFAULT_CONFIG } from "../src/lib/sim/chain";

test("the VAST the simulator emits parses and passes", () => {
  const r = runChain({ ...DEFAULT_CONFIG, adMode: "csai", faults: {} });
  const xml = r.csai!.vast;
  const doc = parseVast(xml, "sim://csai/vast.xml");

  assert.ok(doc.ads.length > 0, "the simulator returned no ads");
  assert.equal(doc.empty, false);
  for (const ad of doc.ads) {
    assert.equal(ad.wrapper, false, "the simulator emits inline ads");
    assert.ok(ad.impressions.length > 0, "every ad must carry an impression");
    const linear = ad.creatives.find((c) => c.kind === "linear");
    assert.ok(linear, "every ad must carry a linear creative");
    assert.ok(linear!.durationSec! > 0);
    assert.ok(linear!.mediaFiles.length > 0);
  }

  const avail = r.csai!.signalledSec;
  const analysis = analyzeVast(doc, {
    codecs: ["avc1.640028"],
    bandwidths: [5_000_000],
    availSeconds: avail,
    serverSide: false,
  });
  const bad = analysis.findings.filter((f) => f.severity !== "info");
  assert.deepEqual(bad.map((f) => f.code), [], "the simulator's own response must satisfy the rules");
  assert.equal(analysis.totalDurationSec, avail, "the pod should fill the avail it was built for");
});

test("a blocked client-side run returns a response with no ads in it", () => {
  const r = runChain({ ...DEFAULT_CONFIG, adMode: "csai", faults: { adBlocked: true } });
  const doc = parseVast(r.csai!.vast, "sim://csai/vast.xml");
  assert.equal(doc.empty, true);
  assert.ok(analyzeVast(doc).findings.some((f) => f.code === "VAST_NO_FILL"));
});

test("a ladder's audio codecs are not compared against the ad's video", () => {
  // Every real ladder advertises mp4a alongside avc1. Comparing an H.264 ad
  // against "mp4a" would report a mismatch on every well-formed stream there is.
  const ladder: StreamProfile = { codecs: ["mp4a.40.2", "avc1.42C01F"], serverSide: true };
  assert.ok(!codes(GOOD, ladder).some((c) => c.includes("CODEC_MISMATCH")));
  // And a genuine mismatch still fires against the same ladder.
  assert.ok(
    codes(GOOD.replace('codec="avc1.64001f"', 'codec="hvc1.1.6.L93.B0"'), ladder).includes("warning:VAST_CODEC_MISMATCH"),
  );
});

test("an audio-only ladder makes no claim about the ad's video codec", () => {
  assert.ok(!codes(GOOD, { codecs: ["mp4a.40.2"], serverSide: true }).some((c) => c.includes("CODEC_MISMATCH")));
});
