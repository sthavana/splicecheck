import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { findEmsgBoxes, readBaseMediaDecodeTime, readBoxes } from "../src/lib/mp4";
import { readId3Pes, scanTransportStream, looksLikeTransportStream } from "../src/lib/ts";
import { readSegment, compareWithManifest, resolveDashSegments, type SegmentProbe } from "../src/lib/segments";
import { fillTemplate, parseMpd } from "../src/lib/dash";
import { analyzeText } from "../src/lib/runner";
import { parseSpliceInfoSection } from "../src/lib/scte35";
import type { RenditionAnalysis } from "../src/lib/analyze";

const seg = (name: string) => new Uint8Array(readFileSync(`fixtures/segments/${name}`));

test("walks ISO BMFF boxes without needing to decode media", () => {
  const types = readBoxes(seg("cmaf-emsg.m4s")).map((b) => b.type);
  assert.deepEqual(types, ["styp", "emsg", "moof", "mdat"]);
  assert.equal(readBaseMediaDecodeTime(seg("cmaf-emsg.m4s")), 324_000_000);
});

test("reads a version-1 emsg, which states an absolute media time", () => {
  const [e] = findEmsgBoxes(seg("cmaf-emsg.m4s"));
  assert.equal(e.version, 1);
  assert.equal(e.schemeIdUri, "urn:scte:scte35:2013:bin");
  assert.equal(e.id, 770001);
  assert.equal(e.presentationTime, 324_000_000);
  assert.equal(e.presentationTimeDelta, undefined);
  const s = parseSpliceInfoSection("0x" + Buffer.from(e.messageData).toString("hex"));
  assert.equal(s.crcValid, true);
  assert.equal(s.spliceInsert?.spliceEventId, 770001);
  assert.equal(s.spliceInsert?.breakDuration?.seconds, 30);
});

test("reads a version-0 emsg, which is timed from its own segment", () => {
  const [e] = findEmsgBoxes(seg("cmaf-emsg-v0.m4s"));
  assert.equal(e.version, 0);
  assert.equal(e.presentationTimeDelta, 180_000);
  assert.equal(e.presentationTime, undefined);
});

test("follows PAT to PMT to find a stream_type 0x86 cue PID", () => {
  const buf = seg("stream.ts");
  assert.ok(looksLikeTransportStream(buf));
  const scan = scanTransportStream(buf);
  assert.deepEqual(scan.scte35Pids, [0x01f0]);
  assert.equal(scan.cues.length, 2);
  assert.ok(scan.cues.every((c) => c.carriage === "section"));
  const ids = scan.cues.map(
    (c) => parseSpliceInfoSection("0x" + Buffer.from(c.data).toString("hex")).spliceInsert!.spliceEventId,
  );
  assert.deepEqual(ids, [880001, 880002]);
});

test("reads a cue carried as an ID3 PRIV frame in a metadata PES", () => {
  // This is how HLS transport streams usually carry SCTE-35 — not on a
  // stream_type 0x86 PID, which is what a naive scanner looks for.
  const scan = scanTransportStream(seg("stream-id3.ts"));
  assert.deepEqual(scan.metadataPids, [0x0230]);
  assert.deepEqual(scan.scte35Pids, [], "there is no 0x86 PID in this stream");
  assert.equal(scan.cues.length, 1);
  const cue = scan.cues[0];
  assert.equal(cue.carriage, "id3-pes");
  assert.match(cue.owner!, /scte35/);
  assert.equal(cue.pts! / 90000, 7200, "the PES timestamp places the cue on the clock");
  const s = parseSpliceInfoSection("0x" + Buffer.from(cue.data).toString("hex"));
  assert.equal(s.crcValid, true);
  assert.equal(s.spliceInsert?.spliceEventId, 990001);
});

test("ignores ID3 frames that are not SCTE-35", () => {
  const notScte = Buffer.concat([
    Buffer.from([0x00, 0x00, 0x01, 0xbd, 0x00, 0x20, 0x80, 0x00, 0x00]),
    Buffer.from("ID3"), Buffer.from([4, 0, 0, 0, 0, 0, 20]),
    Buffer.from("PRIV"), Buffer.from([0, 0, 0, 10]), Buffer.from([0, 0]),
    Buffer.from("com.apple.streaming.transportStreamTimestamp\0"),
    Buffer.from([0, 0, 0, 0, 0, 0, 0, 1]),
  ]);
  assert.deepEqual(readId3Pes(new Uint8Array(notScte)), []);
});

test("resolves a cue to wall clock through the segment's presentation time", () => {
  const pdt = Date.UTC(2026, 8, 18, 12, 0, 0);
  const signals = readSegment(seg("cmaf-emsg-v0.m4s"), "https://example.com/a.m4s", pdt);
  assert.equal(signals.length, 1);
  // 180000 ticks at 90kHz is two seconds past the start of the segment.
  assert.equal(signals[0].pdt, pdt + 2000);
});

function rendition(breaks: RenditionAnalysis["breaks"]): RenditionAnalysis {
  return {
    label: "video",
    uri: "https://example.com/v.m3u8",
    protocol: "hls",
    breaks,
    findings: [],
    stats: {} as RenditionAnalysis["stats"],
  } as RenditionAnalysis;
}

function probeOf(signals: SegmentProbe["signals"]): SegmentProbe {
  return { attempted: 4, fetched: 4, bytes: 1000, format: "mpeg-ts", signals, findings: [], fetchErrors: [] };
}

const T = Date.UTC(2026, 8, 18, 12, 0, 0);

test("agreement: the manifest and the stream stating different instants is an error", () => {
  const findings = compareWithManifest(
    rendition([{ index: 0, startTime: 0, pdt: T, eventId: 42, segmentCount: 1, closed: true, inProgress: false, outLine: 0, outTag: "", discontinuityAtStart: true, discontinuityAtEnd: true }]),
    probeOf([{ carriage: "mpeg-ts", segmentUri: "a.ts", hex: "", eventId: 42, pdt: T + 2130, outOfNetwork: true, section: { crcValid: true } as never }]),
  );
  const f = findings.find((x) => x.code === "INBAND_MANIFEST_TIME_MISMATCH");
  assert.ok(f, "a 2.13s disagreement must be reported");
  assert.equal(f.severity, "error");
  assert.match(f.title, /2\.130s/);
});

test("agreement: matching signals report nothing", () => {
  const findings = compareWithManifest(
    rendition([{ index: 0, startTime: 0, pdt: T, eventId: 42, segmentCount: 1, closed: true, inProgress: false, outLine: 0, outTag: "", discontinuityAtStart: true, discontinuityAtEnd: true }]),
    probeOf([{ carriage: "mpeg-ts", segmentUri: "a.ts", hex: "", eventId: 42, pdt: T, outOfNetwork: true, section: { crcValid: true } as never }]),
  );
  assert.deepEqual(findings, []);
});

test("agreement: a cue the packager never transcribed is an error", () => {
  // The manifest transcribes one avail and misses another, which is what
  // makes the miss a fault rather than a design.
  const findings = compareWithManifest(
    rendition([{ index: 0, startTime: 0, pdt: T, eventId: 1, segmentCount: 1, closed: true, inProgress: false, outLine: 0, outTag: "", discontinuityAtStart: true, discontinuityAtEnd: true }]),
    probeOf([{ carriage: "mpeg-ts", segmentUri: "a.ts", hex: "", eventId: 99, pdt: T + 600_000, outOfNetwork: true, section: { crcValid: true } as never }]),
  );
  assert.ok(findings.some((f) => f.code === "INBAND_SIGNAL_NOT_IN_MANIFEST"));
});

test("agreement: a break clipped by the window still counts as transcribed", () => {
  // The window opening mid-break does not mean the packager failed to write
  // the tag, so the inband cue for it must not read as untranscribed.
  const findings = compareWithManifest(
    rendition([{ index: 0, startTime: 0, pdt: T, eventId: 42, windowClipped: true, segmentCount: 1, closed: true, inProgress: false, outLine: 0, outTag: "", discontinuityAtStart: true, discontinuityAtEnd: true }]),
    probeOf([{ carriage: "mpeg-ts", segmentUri: "a.ts", hex: "", eventId: 42, pdt: T, outOfNetwork: true, section: { crcValid: true } as never }]),
  );
  assert.ok(!findings.some((f) => f.code === "INBAND_SIGNAL_NOT_IN_MANIFEST"));
});

test("agreement: says so when the manifest is the only carriage", () => {
  const findings = compareWithManifest(
    rendition([{ index: 0, startTime: 0, pdt: T, eventId: 42, segmentCount: 1, closed: true, inProgress: false, outLine: 0, outTag: "", discontinuityAtStart: true, discontinuityAtEnd: true }]),
    probeOf([]),
  );
  const f = findings.find((x) => x.code === "NO_INBAND_SCTE35");
  assert.ok(f);
  assert.equal(f.severity, "info");
  assert.match(f.detail, /nothing to check the manifest against/);
});

// ---------------------------------------------------------------- DASH ----

test("fills SegmentTemplate identifiers, including printf widths", () => {
  assert.equal(
    fillTemplate("$RepresentationID$/$Number$.m4s", { RepresentationID: "V300", Number: 42 }),
    "V300/42.m4s",
  );
  assert.equal(
    fillTemplate("v/seg_$Number%05d$.m4s", { Number: 42 }),
    "v/seg_00042.m4s",
    "a fixed-width number is what some packagers name files by",
  );
  assert.equal(fillTemplate("$RepresentationID$_$Time$.m4v", { RepresentationID: "v1", Time: 900 }), "v1_900.m4v");
  assert.equal(fillTemplate("a$$b", {}), "a$b", "$$ is an escaped dollar");
});

test("resolves segment URLs from a timeline", () => {
  const mpd = parseMpd(readFileSync("fixtures/samples/multiperiod-dash/manifest.mpd", "utf8"), "https://cdn.example.com/live/manifest.mpd");
  const period = mpd.periods[1];
  const video = period.adaptationSets.find((a) => a.mimeType?.startsWith("video"))!;
  const { init, segments } = resolveDashSegments(mpd, period, video);

  assert.match(init!, /^https:\/\/cdn\.example\.com\/live\/video-360_init\.m4i$/);
  assert.ok(segments.length > 0);
  assert.match(segments[0].url, /^https:\/\/cdn\.example\.com\/live\/video-360_\d+\.m4v$/);
  // Segment start times must land on the period, not on some other frame.
  assert.ok(Math.abs(segments[0].start - period.start) < 0.001);
  assert.ok(segments.every((s) => s.pdt !== undefined), "availabilityStartTime makes these wall-clock addressable");
});

test("resolves segment URLs for a number-addressed stream", () => {
  // SegmentTemplate with @duration and no timeline: the numbers have to be
  // derived from startNumber and presentationTimeOffset.
  const xml = `<?xml version="1.0"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" availabilityStartTime="1970-01-01T00:00:00Z"
     mediaPresentationDuration="PT20S">
  <Period id="p0" start="PT0S" duration="PT20S">
    <AdaptationSet mimeType="video/mp4" id="0">
      <SegmentTemplate media="$RepresentationID$/$Number$.m4s" initialization="$RepresentationID$/init.mp4"
                       duration="2" startNumber="100" presentationTimeOffset="200" timescale="1"/>
      <Representation id="V300" bandwidth="300000" codecs="avc1.64001e" width="640" height="360"/>
    </AdaptationSet>
  </Period>
</MPD>`;
  const mpd = parseMpd(xml, "https://example.com/live/Manifest.mpd");
  const period = mpd.periods[0];
  const video = period.adaptationSets[0];
  assert.equal(video.usesTimeline, false);
  assert.equal(video.segmentDuration, 2);

  const { segments } = resolveDashSegments(mpd, period, video);
  assert.ok(segments.length > 0, "a number-addressed stream must still be addressable");
  // startNumber addresses the first segment of the period…
  assert.match(segments[0].url, /V300\/100\.m4s$/);
  // …and `start` is presentation time, which begins at the period's own start.
  // The 200 from presentationTimeOffset is media time, a different frame.
  assert.equal(segments[0].start, 0);
  assert.equal(segments[1].start, 2);
});

test("a number-addressed period is not reported as empty", () => {
  // There is no timeline to total up, which is not the same as no media.
  const xml = `<?xml version="1.0"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT10S">
  <Period id="p0" start="PT0S" duration="PT10S">
    <AdaptationSet mimeType="video/mp4" id="0">
      <SegmentTemplate media="$Number$.m4s" duration="2" startNumber="1" timescale="1"/>
      <Representation id="v" bandwidth="1" codecs="avc1.64001e"/>
    </AdaptationSet>
  </Period>
</MPD>`;
  const r = analyzeText(xml, "number-addressed.mpd");
  assert.ok(!r.renditions[0].findings.some((f) => f.code === "EMPTY_PERIOD"));
});

test("a stream declaring SCTE-35 inband says so", () => {
  const xml = `<?xml version="1.0"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="dynamic" availabilityStartTime="1970-01-01T00:00:00Z"
     minimumUpdatePeriod="PT2S" timeShiftBufferDepth="PT60S">
  <Period id="p0" start="PT0S">
    <AdaptationSet mimeType="video/mp4" id="0">
      <InbandEventStream schemeIdUri="urn:scte:scte35:2013:bin"/>
      <SegmentTemplate media="$Number$.m4s" duration="2" startNumber="0" timescale="1"/>
      <Representation id="v" bandwidth="1" codecs="avc1.64001e"/>
    </AdaptationSet>
  </Period>
</MPD>`;
  const r = analyzeText(xml, "inband.mpd");
  const f = r.renditions[0].findings.find((x) => x.code === "INBAND_EVENT_STREAM_DECLARED");
  assert.ok(f, "the manifest is telling you it is not the whole story");
  assert.match(f.detail, /a manifest-only view of this stream will always report no ad signalling/);
});

test("agreement: inband-only signalling is a design, not a dropped cue", () => {
  // When the manifest carries no avails at all it was never transcribing, so
  // a cue that exists only in the segments is not something the packager lost.
  const findings = compareWithManifest(
    rendition([]),
    probeOf([{ carriage: "emsg", segmentUri: "a.m4s", hex: "", eventId: 7, pdt: T, outOfNetwork: true, section: { crcValid: true } as never }]),
  );
  const f = findings.find((x) => x.code === "INBAND_ONLY_SIGNALLING");
  assert.ok(f);
  assert.equal(f.severity, "info");
  assert.ok(!findings.some((x) => x.code === "INBAND_SIGNAL_NOT_IN_MANIFEST"));
});

test("agreement: a dropped cue is still an error when the manifest transcribes others", () => {
  const findings = compareWithManifest(
    rendition([{ index: 0, startTime: 0, pdt: T, eventId: 1, segmentCount: 1, closed: true, inProgress: false, outLine: 0, outTag: "", discontinuityAtStart: true, discontinuityAtEnd: true }]),
    probeOf([{ carriage: "emsg", segmentUri: "a.m4s", hex: "", eventId: 7, pdt: T + 600_000, outOfNetwork: true, section: { crcValid: true } as never }]),
  );
  assert.ok(findings.some((x) => x.code === "INBAND_SIGNAL_NOT_IN_MANIFEST"));
});

/* --------------------------------------------- sampling an on-demand asset --
 * A live window with no avails in it is scanned end to end, because a cue can
 * sit in one segment out of thirty and the window is only minutes long. An
 * on-demand asset cannot be treated the same way: it is addressable end to end,
 * its segments are routinely a megabyte each, and taking the last sixty reads
 * the end of the film. One probe pulled 26MB against a checkbox that promises
 * a few before these were separated.
 */

import { spread } from "../src/lib/segments";

test("a spread keeps both ends and stays inside the budget", () => {
  const items = Array.from({ length: 600 }, (_, i) => i);
  const picked = spread(items, 5);
  assert.equal(picked.length, 5);
  assert.equal(picked[0], 0, "the first segment is always sampled");
  assert.equal(picked[picked.length - 1], 599, "and so is the last");
  assert.deepEqual([...picked].sort((a, b) => a - b), picked, "in timeline order");
});

test("a spread is evenly distributed rather than clustered", () => {
  const picked = spread(Array.from({ length: 600 }, (_, i) => i), 7);
  const gaps = picked.slice(1).map((v, i) => v - picked[i]);
  assert.ok(Math.max(...gaps) - Math.min(...gaps) <= 1, `gaps ${gaps.join(",")}`);
});

test("a spread never invents or duplicates segments", () => {
  const items = [10, 20, 30];
  assert.deepEqual(spread(items, 5), items, "fewer segments than the budget returns them all");
  assert.deepEqual(spread(items, 3), items);
  assert.equal(new Set(spread(Array.from({ length: 50 }, (_, i) => i), 12)).size, 12, "no duplicates");
});
