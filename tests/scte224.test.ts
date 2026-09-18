import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { compareScte224, isScte224, parseScte224 } from "../src/lib/scte224";
import { analyzeText } from "../src/lib/runner";

const xml = () => readFileSync("fixtures/policy.scte224.xml", "utf8");
const streamBreaks = () =>
  analyzeText(readFileSync("fixtures/samples/ssai-source/playlist.m3u8", "utf8"), "source.m3u8")
    .renditions[0].breaks;

// A point in time after the fixture's policy is effective and its stale point
// has expired, so the comparison is deterministic.
const NOW = Date.UTC(2026, 8, 17, 12, 30, 0);

test("recognises an SCTE-224 document", () => {
  assert.equal(isScte224(xml()), true);
  assert.equal(isScte224("#EXTM3U\n#EXT-X-VERSION:6"), false);
  assert.equal(isScte224('<?xml version="1.0"?><MPD xmlns="urn:mpeg:dash:schema:mpd:2011"/>'), false);
});

test("parses media points, their policies and their windows", () => {
  const doc = parseScte224(xml());
  assert.equal(doc.media.length, 1);
  const points = doc.media[0].mediaPoints;
  assert.equal(points.length, 5);

  const blackout = points.find((p) => p.id === "mp-blackout-start")!;
  assert.equal(blackout.matchTime, Date.UTC(2026, 8, 17, 12, 0, 12));
  assert.equal(blackout.expectedDuration, 30);
  assert.deepEqual(blackout.applies, ["policy/regional-blackout"]);
  assert.deepEqual(blackout.signalPointIds, ["PROMO-1187"]);

  const stale = points.find((p) => p.id === "mp-stale")!;
  assert.equal(stale.expires, Date.UTC(2026, 8, 16, 9, 0, 0));
});

test("lines policy points up against the signals a stream carries", () => {
  const cmp = compareScte224(parseScte224(xml()), streamBreaks(), { now: NOW });
  assert.equal(cmp.matched.length, 3);
  assert.deepEqual(
    cmp.matched.map((m) => m.point.id),
    ["mp-blackout-start", "mp-break-2", "mp-no-policy"],
  );
  assert.ok(cmp.matched.every((m) => (m.driftSeconds ?? 0) < 0.001), "these line up exactly");
});

test("a policy written for a different length of event is reported", () => {
  const cmp = compareScte224(parseScte224(xml()), streamBreaks(), { now: NOW });
  const f = cmp.findings.find((x) => x.code === "SCTE224_DURATION_MISMATCH");
  assert.ok(f);
  assert.match(f.title, /expects 60s but the stream signals 30s/);
});

test("a point that matches nothing is reported: the policy will not fire", () => {
  const cmp = compareScte224(parseScte224(xml()), streamBreaks(), { now: NOW });
  const f = cmp.findings.find((x) => x.code === "SCTE224_POINT_UNMATCHED");
  assert.ok(f);
  assert.match(f.title, /mp-orphan/);
});

test("a point attaching no policy is reported", () => {
  const cmp = compareScte224(parseScte224(xml()), streamBreaks(), { now: NOW });
  assert.ok(cmp.findings.some((x) => x.code === "SCTE224_POINT_NO_POLICY"));
});

test("an expired point is noted but not matched", () => {
  const cmp = compareScte224(parseScte224(xml()), streamBreaks(), { now: NOW });
  assert.ok(cmp.findings.some((x) => x.code === "SCTE224_POINT_EXPIRED"));
  assert.ok(!cmp.matched.some((m) => m.point.id === "mp-stale"));
});

test("signals the policy says nothing about are noted, not condemned", () => {
  // A blackout schedule does not govern every ad break, so this is context
  // rather than a fault.
  const cmp = compareScte224(parseScte224(xml()), streamBreaks(), { now: NOW });
  const f = cmp.findings.find((x) => x.code === "SCTE224_SIGNAL_NOT_GOVERNED");
  assert.ok(f);
  assert.equal(f.severity, "info");
});

test("a policy that matches its stream exactly reports nothing", () => {
  const clean = `<?xml version="1.0"?>
<Media xmlns="urn:scte:224" id="c/1">
  <MediaPoint id="a" matchTime="2026-09-17T12:00:12Z" expectedDuration="PT30S">
    <Apply policy="p/1"/>
  </MediaPoint>
  <MediaPoint id="b" matchTime="2026-09-17T12:00:54Z" expectedDuration="PT30S">
    <Apply policy="p/1"/>
  </MediaPoint>
  <MediaPoint id="c" matchTime="2026-09-17T12:01:30Z" expectedDuration="PT30S">
    <Apply policy="p/1"/>
  </MediaPoint>
  <MediaPoint id="d" matchTime="2026-09-17T12:02:06Z" expectedDuration="PT30S">
    <Apply policy="p/1"/>
  </MediaPoint>
</Media>`;
  const cmp = compareScte224(parseScte224(clean), streamBreaks(), { now: NOW });
  assert.equal(cmp.matched.length, 4);
  assert.deepEqual(cmp.findings, [], "a policy that agrees with its stream must be silent");
});
