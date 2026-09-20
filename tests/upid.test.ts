import { test } from "node:test";
import assert from "node:assert/strict";
import { validateUpid, parseSpliceInfoSection } from "../src/lib/scte35";
import { buildPayload } from "../src/lib/sim/scte35Encode";
import { analyzeText } from "../src/lib/runner";

/*
 * A malformed UPID is a valid cue that identifies nothing. It parses, its CRC
 * validates, the break opens on time — and the ad system looks the creative up
 * by this value and finds none. The avail goes unfilled for a reason nothing
 * else in the signalling chain reports.
 */

const enc = (s: string) => new Uint8Array(Buffer.from(s, "utf8"));
const hex = (h: string) => new Uint8Array(Buffer.from(h, "hex"));
const code = (t: number, b: Uint8Array, txt = "") => validateUpid(t, b, txt)?.code;

test("a well-formed Ad-ID passes, in both of its lengths", () => {
  assert.equal(code(0x03, enc("ABCD0001000"), "ABCD0001000"), undefined);
  assert.equal(code(0x03, enc("ABCD0001000H"), "ABCD0001000H"), undefined);
});

test("an Ad-ID that is not one is reported", () => {
  // Ad systems look creatives up by this exact string.
  assert.equal(code(0x03, enc("abcd0001000"), "abcd0001000"), "UPID_MALFORMED_ADID", "lower case");
  assert.equal(code(0x03, enc("ABC123"), "ABC123"), "UPID_MALFORMED_ADID", "too short");
  assert.equal(code(0x03, enc("ABCD-001000"), "ABCD-001000"), "UPID_MALFORMED_ADID", "punctuation");
});

test("types with a fixed length are checked against it", () => {
  assert.equal(code(0x10, hex("0102030405060708090a0b0c0d0e0f10")), undefined, "UUID, 16 bytes");
  assert.equal(code(0x10, hex("0102030405060708")), "UPID_WRONG_LENGTH");
  assert.equal(code(0x0a, hex("10161a2b3c4d5e6f70819200")), undefined, "EIDR, 12 bytes");
  assert.equal(code(0x0a, hex("10161a2b3c4d5e6f7081")), "UPID_WRONG_LENGTH");
});

test("a URI UPID has to be a URI", () => {
  assert.equal(code(0x0f, enc("https://ads.example/x"), "https://ads.example/x"), undefined);
  assert.equal(code(0x0f, enc("not a uri"), "not a uri"), "UPID_MALFORMED_URI");
});

test("an MPU with only its format identifier carries no payload", () => {
  assert.equal(code(0x0c, enc('ADSP{"pod":1}')), undefined);
  assert.equal(code(0x0c, enc("ADSP")), "UPID_MPU_NO_PRIVATE_DATA");
});

test("a MID whose sub-UPIDs do not fit is truncated", () => {
  assert.equal(code(0x0d, hex("03044142434408084142434445464748")), undefined, "two sub-UPIDs");
  assert.equal(code(0x0d, hex("0308414243")), "UPID_MID_TRUNCATED");
});

test("type 0 means no UPID, so bytes with it are contradictory", () => {
  assert.equal(code(0x00, new Uint8Array(0)), undefined);
  assert.equal(code(0x00, enc("something")), "UPID_TYPE_NOT_USED");
});

test("declaring a type and carrying nothing is reported", () => {
  assert.equal(code(0x03, new Uint8Array(0), ""), "UPID_EMPTY");
});

/* --------------------------------------------- through a real playlist -- */

function playlist(payload: string): string {
  return `#EXTM3U
#EXT-X-VERSION:6
#EXT-X-TARGETDURATION:6
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-PROGRAM-DATE-TIME:2026-01-01T00:00:00.000Z
#EXTINF:6.0,
a.ts
#EXT-X-DISCONTINUITY
#EXT-OATCLS-SCTE35:${payload}
#EXT-X-CUE-OUT:30.000
#EXTINF:6.0,
b.ts
#EXT-X-DISCONTINUITY
#EXT-X-CUE-IN
#EXTINF:6.0,
c.ts
#EXT-X-ENDLIST
`;
}

function playlistCodes(upidType: number, upid: string | Uint8Array): string[] {
  const p = buildPayload({
    timeSignal: { ptsTime: 900000 },
    descriptors: [{ eventId: 1, typeId: 0x34, durationSeconds: 30, upidType, upid }],
  });
  return analyzeText(playlist(p.base64), "x.m3u8")
    .renditions.flatMap((r) => r.findings)
    .filter((f) => f.code.startsWith("UPID_"))
    .map((f) => f.code);
}

test("the rule reaches a break in a real playlist, and only when it should", () => {
  assert.deepEqual(playlistCodes(0x03, "ABCD0001000H"), []);
  assert.deepEqual(playlistCodes(0x03, "abc-123"), ["UPID_MALFORMED_ADID"]);
  assert.deepEqual(playlistCodes(0x0c, 'ADSP{"pod":1}'), []);
  assert.deepEqual(playlistCodes(0x0c, "ADSP"), ["UPID_MPU_NO_PRIVATE_DATA"]);
});

/* ----------------------------------------------------- splice_schedule -- */

test("splice_schedule decodes, which the command table already claimed", () => {
  // A schedule states future splices against UTC rather than PTS, which is why
  // it is rare in streaming: everything downstream works in PTS.
  // Two events, an hour apart, each a 90s and a 60s avail. Constructed rather
  // than taken from a capture, because splice_schedule is rare enough that no
  // public vector carries one — the CRC assertion below is what makes it
  // trustworthy.
  const SCHEDULE = "/DA4AAAAAAAA///wJwQCAAAbWX//azbsgP4Ae5igAAEBAgAAG1p//2s2+pD+AFJlwAABAQIAAByanUQ=";
  const s = parseSpliceInfoSection(SCHEDULE);
  assert.equal(s.spliceCommandName, "splice_schedule");
  assert.equal(s.crcValid, true, "a section the decoder accepts must validate");
  assert.ok(s.spliceSchedule, "the events must be decoded, not skipped");
  assert.equal(s.spliceSchedule!.length, 2);
  for (const e of s.spliceSchedule!) {
    assert.ok(e.spliceEventId > 0);
    assert.equal(e.outOfNetwork, true);
    assert.ok(e.utcSpliceTimeIso, "a schedule states wall clock, not PTS");
    assert.ok(e.breakDuration!.seconds > 0);
  }
});
