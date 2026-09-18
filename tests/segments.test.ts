import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { findEmsgBoxes, readBaseMediaDecodeTime, readBoxes } from "../src/lib/mp4";
import { readId3Pes, scanTransportStream, looksLikeTransportStream } from "../src/lib/ts";
import { readSegment, compareWithManifest, type SegmentProbe } from "../src/lib/segments";
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
  const findings = compareWithManifest(
    rendition([]),
    probeOf([{ carriage: "mpeg-ts", segmentUri: "a.ts", hex: "", eventId: 99, pdt: T, outOfNetwork: true, section: { crcValid: true } as never }]),
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
