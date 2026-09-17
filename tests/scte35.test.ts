import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSpliceInfoSection, crc32Mpeg } from "../src/lib/scte35";

test("decodes the SCTE-35 spec time_signal / placement opportunity vector", () => {
  const s = parseSpliceInfoSection(
    "/DA0AAAAAAAA///wBQb+cr0AUAAeAhxDVUVJSAAAjn/PAAGlmbAICAAAAAAsoKGKNAIAmsnRfg==",
  );
  assert.equal(s.spliceCommandName, "time_signal");
  assert.equal(s.crcValid, true, "published spec vectors must validate");
  assert.equal(s.timeSignal?.ptsTime, 1924989008);
  const d = s.descriptors.find((x) => "typeId" in x)!;
  assert.equal(d.typeId, 0x34, "Provider Placement Opportunity Start");
  assert.equal(d.segmentationEventId, 0x4800008e);
  assert.equal(Math.round(d.segmentationDurationSeconds!), 307);
  assert.equal(d.upidTypeName, "TI");
});

test("decodes the SCTE-35 spec splice_insert vector with an auto-return break", () => {
  const s = parseSpliceInfoSection("/DAvAAAAAAAA///wFAVIAACPf+/+c2nALv4AUsz1AAAAAAAKAAhDVUVJAAABNWLbowo=");
  assert.equal(s.spliceCommandName, "splice_insert");
  assert.equal(s.crcValid, true);
  assert.equal(s.spliceInsert?.spliceEventId, 0x4800008f);
  assert.equal(s.spliceInsert?.outOfNetwork, true);
  assert.equal(s.spliceInsert?.breakDuration?.autoReturn, true);
  assert.ok(Math.abs(s.spliceInsert!.breakDuration!.seconds - 60.294) < 0.001);
});

test("decodes two segmentation descriptors in one section", () => {
  const s = parseSpliceInfoSection(
    "/DBIAAAAAAAA///wBQb+ek2ItgAyAhdDVUVJSAAAGH+fCAgAAAAALMvDRBEAAAIXQ1VFSUgAABl/nwgIAAAAACyk26AQAACZcuND",
  );
  assert.equal(s.crcValid, true);
  const types = s.descriptors.filter((d) => "typeId" in d).map((d) => (d as { typeId: number }).typeId);
  assert.deepEqual(types, [0x11, 0x10], "Program End then Program Start");
});

test("accepts hex as well as base64, producing an identical decode", () => {
  const b64 = parseSpliceInfoSection("/DAvAAAAAAAA///wFAVIAACPf+/+c2nALv4AUsz1AAAAAAAKAAhDVUVJAAABNWLbowo=");
  const hex = parseSpliceInfoSection(
    "0xFC302F000000000000FFFFF014054800008F7FEFFE7369C02EFE0052CCF500000000000A0008435545490000013562DBA30A",
  );
  assert.equal(hex.hex, b64.hex);
  assert.equal(hex.spliceInsert?.spliceEventId, b64.spliceInsert?.spliceEventId);
});

test("renders an MPU UPID's format identifier and private payload", () => {
  // Operators commonly carry pod metadata as JSON in the MPU private data.
  // Generated here rather than taken from a live service.
  const s = parseSpliceInfoSection(
    "/DBSAAAAAAAAAP/wBQb+E0/ZAAA8AjpDVUVJAAdTe3//AAApMuAMJlRFU1R7InBvZCI6IjIvNSIsImFzc2V0IjoicHJvbW8tMTE4NyJ9MAAALWdtNA==",
  );
  assert.equal(s.crcValid, true);
  const d = s.descriptors.find((x) => "typeId" in x)! as {
    typeId: number;
    upidTypeName: string;
    upidText: string;
    segmentationDurationSeconds?: number;
  };
  assert.equal(d.typeId, 0x30, "Provider Advertisement Start");
  assert.equal(d.upidTypeName, "MPU");
  assert.equal(d.segmentationDurationSeconds, 30);
  assert.equal(d.upidText, 'TEST {"pod":"2/5","asset":"promo-1187"}');
});

test("reports a bad CRC rather than silently accepting it", () => {
  // Real payload from a live packager whose CRC was not recomputed after rewrite.
  const s = parseSpliceInfoSection(
    "0xFC302000000000000000FFF00F0500E1C2787FFFFE0034BC00C00000000000E4612424",
  );
  assert.equal(s.spliceInsert?.spliceEventId, 14795384, "the section itself decodes correctly");
  assert.equal(s.crcValid, false);
});

test("rejects payloads that are not a splice_info_section", () => {
  assert.throws(() => parseSpliceInfoSection("bm90LXNjdGUtMzUtYXQtYWxs"), /table_id|truncated/);
});

test("CRC-32 implementation matches the MPEG-2 definition", () => {
  // A conforming section CRCs to zero across its whole extent.
  const bytes = Buffer.from("/DAvAAAAAAAA///wFAVIAACPf+/+c2nALv4AUsz1AAAAAAAKAAhDVUVJAAABNWLbowo=", "base64");
  assert.equal(crc32Mpeg(new Uint8Array(bytes)), 0);
});
