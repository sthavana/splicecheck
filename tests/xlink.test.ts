import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMpd } from "../src/lib/dash";
import { analyzeText } from "../src/lib/runner";
import { resolveRemotePeriods, type RemoteFetcher } from "../src/lib/xlink";

/*
 * A Period with xlink:href is a promise the manifest cannot keep on its own:
 * the packager reserves a hole and names a service that fills it at playback
 * time. Everything else about a manifest can be judged from its text; this can
 * only be judged by making the request a player would make.
 */

const CONTENT = `<AdaptationSet mimeType="video/mp4"><SegmentTemplate timescale="90000" presentationTimeOffset="PTO" media="c/$Number$.m4s" initialization="c/init.mp4"><SegmentTimeline><S t="T" d="540000" r="19"/></SegmentTimeline></SegmentTemplate><Representation id="v1" codecs="avc1.64001f" width="1280" height="720" bandwidth="3000000"/></AdaptationSet>`;

function mpdWith(adPeriod: string, opts: { live?: boolean } = {}): string {
  const content = (t: number) => CONTENT.replace(/PTO/, String(t)).replace(/T"/, `${t}"`);
  return `<?xml version="1.0"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" xmlns:xlink="http://www.w3.org/1999/xlink"
     type="${opts.live === false ? "static" : "dynamic"}" availabilityStartTime="2026-01-01T00:00:00Z"
     ${opts.live === false ? "" : 'minimumUpdatePeriod="PT6S"'} minBufferTime="PT4S">
  <Period id="p0" start="PT0S" duration="PT120S">${content(0)}</Period>
  ${adPeriod}
  <Period id="p1" start="PT210S" duration="PT120S">${content(18900000)}</Period>
</MPD>`;
}

const codes = (text: string) =>
  analyzeText(text, "https://example.com/manifest.mpd")
    .renditions.flatMap((r) => r.findings)
    .map((f) => `${f.severity}:${f.code}`);

/* ------------------------------------------------------- reading the text */

test("a remote Period is reported as depending on something outside the manifest", () => {
  const c = codes(mpdWith(`<Period id="ad" start="PT120S" duration="PT90S" xlink:href="https://ads.example/p?1" xlink:actuate="onRequest"/>`));
  assert.ok(c.includes("info:XLINK_REMOTE_PERIOD"));
});

test("a placeholder with no duration cannot have its extent known", () => {
  const c = codes(mpdWith(`<Period id="ad" start="PT120S" xlink:href="https://ads.example/p?1" xlink:actuate="onRequest"/>`));
  assert.ok(c.includes("error:XLINK_NO_DURATION"));
});

test("a placeholder that declares its duration does not raise that", () => {
  const c = codes(mpdWith(`<Period id="ad" start="PT120S" duration="PT90S" xlink:href="https://ads.example/p?1" xlink:actuate="onRequest"/>`));
  assert.ok(!c.some((x) => x.includes("XLINK_NO_DURATION")));
});

test("onLoad on a frequently refreshed live manifest is called out", () => {
  const c = codes(mpdWith(`<Period id="ad" start="PT120S" duration="PT90S" xlink:href="https://ads.example/p?1" xlink:actuate="onLoad"/>`));
  assert.ok(c.includes("warning:XLINK_ONLOAD_ON_LIVE"));
  // The same thing on-demand is nobody's problem: there is no refresh loop.
  const still = codes(mpdWith(`<Period id="ad" start="PT120S" duration="PT90S" xlink:href="https://ads.example/p?1" xlink:actuate="onLoad"/>`, { live: false }));
  assert.ok(!still.some((x) => x.includes("XLINK_ONLOAD_ON_LIVE")));
});

test("a missing actuate leaves the resolution time to the client", () => {
  const c = codes(mpdWith(`<Period id="ad" start="PT120S" duration="PT90S" xlink:href="https://ads.example/p?1"/>`));
  assert.ok(c.includes("warning:XLINK_NO_ACTUATE"));
});

test("an unresolved placeholder is not reported as an empty or broken Period", () => {
  // It has no AdaptationSets and no media by design. Reporting that as a
  // packaging fault would fire on every correct remote Period there is.
  const c = codes(mpdWith(`<Period id="ad" start="PT120S" duration="PT90S" xlink:href="https://ads.example/p?1" xlink:actuate="onRequest"/>`));
  for (const noise of ["EMPTY_PERIOD", "REPRESENTATION_SET_CHANGED", "NO_PERIOD_CONTINUITY_SIGNAL", "PERIOD_TIMELINE_GAP"]) {
    assert.ok(!c.some((x) => x.includes(noise)), `${noise} must not fire on a placeholder — got ${c.join(" ")}`);
  }
});

test("a manifest with no remote Periods raises nothing about xlink", () => {
  const c = codes(mpdWith(`<Period id="ad" start="PT120S" duration="PT90S">${CONTENT.replace(/PTO/, "10800000").replace(/T"/, '10800000"')}</Period>`));
  assert.ok(!c.some((x) => x.includes("XLINK")), c.join(" "));
});

/* ------------------------------------------------------- making the call */

const AD_PERIOD = `<Period id="ad" start="PT120S" duration="PT90S" xlink:href="https://ads.example/p?1" xlink:actuate="onRequest"/>`;
const doc = () => parseMpd(mpdWith(AD_PERIOD), "https://example.com/manifest.mpd");

const answers = (body: string, o: Partial<{ ok: boolean; status: number; ms: number }> = {}): RemoteFetcher =>
  async () => ({ ok: o.ok ?? true, status: o.status ?? 200, text: body, ms: o.ms ?? 120 });

const AD_BODY = (dur: string, codecs = "avc1.64001f", w = 1280, h = 720) =>
  `<Period id="ad-resolved" duration="${dur}"><AdaptationSet mimeType="video/mp4"><SegmentTemplate timescale="90000" media="a/$Number$.m4s" initialization="a/init.mp4"><SegmentTimeline><S t="0" d="540000" r="14"/></SegmentTimeline></SegmentTemplate><Representation id="v1" codecs="${codecs}" width="${w}" height="${h}" bandwidth="3000000"/></AdaptationSet></Period>`;

test("a resolution that matches the placeholder raises nothing", async () => {
  const r = await resolveRemotePeriods(doc(), { fetcher: answers(AD_BODY("PT90S")) });
  assert.equal(r.attempted, 1);
  assert.equal(r.resolved, 1);
  assert.deepEqual(r.findings.map((f) => f.code), []);
});

test("a service that does not answer loses the avail", async () => {
  const r = await resolveRemotePeriods(doc(), {
    fetcher: async () => ({ ok: false, status: 503, ms: 90 }),
  });
  assert.deepEqual(r.findings.map((f) => f.code), ["XLINK_RESOLVE_FAILED"]);
  assert.equal(r.resolved, 0);
});

test("a resolution slower than the playback deadline is reported", async () => {
  const r = await resolveRemotePeriods(doc(), { fetcher: answers(AD_BODY("PT90S"), { ms: 3400 }) });
  assert.ok(r.findings.some((f) => f.code === "XLINK_RESOLVE_SLOW"));
  // Fast enough, and it is not worth mentioning.
  const quick = await resolveRemotePeriods(doc(), { fetcher: answers(AD_BODY("PT90S"), { ms: 300 }) });
  assert.ok(!quick.findings.some((f) => f.code === "XLINK_RESOLVE_SLOW"));
});

test("content of a different length shifts every Period after it", async () => {
  const r = await resolveRemotePeriods(doc(), { fetcher: answers(AD_BODY("PT60S")) });
  const f = r.findings.find((x) => x.code === "XLINK_DURATION_MISMATCH");
  assert.ok(f, r.findings.map((x) => x.code).join(","));
  assert.match(f!.title, /60/);
  assert.match(f!.title, /90/);
});

test("an empty resolution is unsold inventory, not a fault", async () => {
  const r = await resolveRemotePeriods(doc(), { fetcher: answers('<Period id="none"/>') });
  const f = r.findings.find((x) => x.code === "XLINK_RESOLVED_EMPTY");
  if (f) assert.equal(f.severity, "warning");
});

test("an ad encoded differently from the programme is the decoder reset nobody expects", async () => {
  const r = await resolveRemotePeriods(doc(), { fetcher: answers(AD_BODY("PT90S", "hvc1.1.6.L93.B0", 1920, 1080)) });
  assert.ok(r.findings.some((f) => f.code === "XLINK_CODEC_MISMATCH"));
  // Same encode as the programme, and there is nothing to say.
  const same = await resolveRemotePeriods(doc(), { fetcher: answers(AD_BODY("PT90S")) });
  assert.ok(!same.findings.some((f) => f.code === "XLINK_CODEC_MISMATCH"));
});

test("a body that is not DASH fails as surely as no body at all", async () => {
  const r = await resolveRemotePeriods(doc(), { fetcher: answers("<html><body>404 not found</body></html>") });
  assert.ok(
    r.findings.some((f) => f.code === "XLINK_RESOLVE_UNPARSEABLE" || f.code === "XLINK_RESOLVED_EMPTY"),
    r.findings.map((f) => f.code).join(","),
  );
});

test("a manifest with nothing remote makes no requests at all", async () => {
  let called = 0;
  const plain = parseMpd(
    mpdWith(`<Period id="ad" start="PT120S" duration="PT90S">${CONTENT.replace(/PTO/, "10800000").replace(/T"/, '10800000"')}</Period>`),
    "https://example.com/manifest.mpd",
  );
  const r = await resolveRemotePeriods(plain, {
    fetcher: async () => {
      called++;
      return { ok: true, text: "", ms: 1 };
    },
  });
  assert.equal(called, 0);
  assert.equal(r.attempted, 0);
});
