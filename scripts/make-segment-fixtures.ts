/**
 * Builds the segment fixtures used to test inband SCTE-35 extraction:
 * a CMAF segment carrying an `emsg`, and a transport stream carrying
 * splice_info_sections on a PID the PMT declares as type 0x86.
 *
 *   npx tsx scripts/make-segment-fixtures.ts
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { crc32Mpeg, parseSpliceInfoSection } from "../src/lib/scte35";

const OUT = "fixtures/segments";

// ---------------------------------------------------------------- SCTE-35 --

/** splice_insert, out of network, auto_return, with a break duration. */
function spliceInsert(eventId: number, seconds: number, ptsSeconds?: number): Uint8Array {
  const ticks = Math.round(seconds * 90000);
  const immediate = ptsSeconds === undefined;
  const cmd: number[] = [];
  cmd.push((eventId >>> 24) & 0xff, (eventId >>> 16) & 0xff, (eventId >>> 8) & 0xff, eventId & 0xff);
  cmd.push(0x7f); // not cancelled
  // out_of_network | program_splice | duration_flag | splice_immediate | reserved(4)
  cmd.push(immediate ? 0xff : 0xef);
  if (!immediate) {
    const pts = Math.round(ptsSeconds! * 90000) % 2 ** 33;
    cmd.push(0xfe | (Math.floor(pts / 2 ** 32) & 1));
    cmd.push((pts >>> 24) & 0xff, (pts >>> 16) & 0xff, (pts >>> 8) & 0xff, pts & 0xff);
  }
  cmd.push(0xfe | (Math.floor(ticks / 2 ** 32) & 1));
  cmd.push((ticks >>> 24) & 0xff, (ticks >>> 16) & 0xff, (ticks >>> 8) & 0xff, ticks & 0xff);
  cmd.push(0x00, 0x01, 0x00, 0x00); // unique_program_id, avail_num, avails_expected

  const body: number[] = [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff, 0xf0 | ((cmd.length >> 8) & 0x0f), cmd.length & 0xff, 0x05, ...cmd];
  body.push(0x00, 0x00); // descriptor_loop_length
  const sectionLength = body.length + 4;
  const bytes = [0xfc, 0x30 | ((sectionLength >> 8) & 0x0f), sectionLength & 0xff, ...body];
  const crc = crc32Mpeg(Uint8Array.from(bytes));
  bytes.push((crc >>> 24) & 0xff, (crc >>> 16) & 0xff, (crc >>> 8) & 0xff, crc & 0xff);
  return Uint8Array.from(bytes);
}

// -------------------------------------------------------------- ISO BMFF --

function box(type: string, ...payloads: Uint8Array[]): Uint8Array {
  const body = Buffer.concat(payloads.map((p) => Buffer.from(p)));
  const out = Buffer.alloc(8 + body.length);
  out.writeUInt32BE(8 + body.length, 0);
  out.write(type, 4, "ascii");
  body.copy(out, 8);
  return new Uint8Array(out);
}

function u32(n: number): Uint8Array {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0, 0);
  return new Uint8Array(b);
}

function cstr(s: string): Uint8Array {
  return new Uint8Array(Buffer.concat([Buffer.from(s, "utf8"), Buffer.from([0])]));
}

/** version 1 emsg: absolute presentation_time on the media timeline. */
function emsgV1(scheme: string, value: string, timescale: number, presentationTime: number, duration: number, id: number, data: Uint8Array): Uint8Array {
  const pt = Buffer.alloc(8);
  pt.writeUInt32BE(Math.floor(presentationTime / 2 ** 32), 0);
  pt.writeUInt32BE(presentationTime >>> 0, 4);
  return box(
    "emsg",
    new Uint8Array([1, 0, 0, 0]),
    u32(timescale),
    new Uint8Array(pt),
    u32(duration),
    u32(id),
    cstr(scheme),
    cstr(value),
    data,
  );
}

/** version 0 emsg: presentation_time_delta from the segment start. */
function emsgV0(scheme: string, value: string, timescale: number, delta: number, duration: number, id: number, data: Uint8Array): Uint8Array {
  return box(
    "emsg",
    new Uint8Array([0, 0, 0, 0]),
    cstr(scheme),
    cstr(value),
    u32(timescale),
    u32(delta),
    u32(duration),
    u32(id),
    data,
  );
}

function tfdt(baseMediaDecodeTime: number): Uint8Array {
  const b = Buffer.alloc(8);
  b.writeUInt32BE(Math.floor(baseMediaDecodeTime / 2 ** 32), 0);
  b.writeUInt32BE(baseMediaDecodeTime >>> 0, 4);
  return box("tfdt", new Uint8Array([1, 0, 0, 0]), new Uint8Array(b));
}

// -------------------------------------------------- MPEG-2 transport stream --

const TS = 188;
let continuity = 0;

function tsPacket(pid: number, payload: Uint8Array, unitStart: boolean): Uint8Array {
  const p = Buffer.alloc(TS, 0xff);
  p[0] = 0x47;
  p[1] = ((unitStart ? 0x40 : 0x00) | ((pid >> 8) & 0x1f)) & 0xff;
  p[2] = pid & 0xff;
  p[3] = 0x10 | (continuity++ & 0x0f); // payload only
  Buffer.from(payload).copy(p, 4, 0, Math.min(payload.length, TS - 4));
  return new Uint8Array(p);
}

/** Wraps a PSI section with its pointer_field. */
function sectionPayload(section: Uint8Array): Uint8Array {
  return new Uint8Array(Buffer.concat([Buffer.from([0x00]), Buffer.from(section)]));
}

function withCrc(head: number[]): Uint8Array {
  const crc = crc32Mpeg(Uint8Array.from(head));
  return Uint8Array.from([...head, (crc >>> 24) & 0xff, (crc >>> 16) & 0xff, (crc >>> 8) & 0xff, crc & 0xff]);
}

function pat(programNumber: number, pmtPid: number): Uint8Array {
  const sectionLength = 5 + 4 + 4; // tsid..last_section + one program + CRC
  return withCrc([
    0x00,
    0xb0 | ((sectionLength >> 8) & 0x0f),
    sectionLength & 0xff,
    0x00, 0x01,       // transport_stream_id
    0xc1,             // version 0, current
    0x00, 0x00,       // section_number, last_section_number
    (programNumber >> 8) & 0xff, programNumber & 0xff,
    0xe0 | ((pmtPid >> 8) & 0x1f), pmtPid & 0xff,
  ]);
}

function pmt(programNumber: number, pcrPid: number, videoPid: number, scte35Pid: number): Uint8Array {
  const streams = [
    [0x1b, videoPid],   // H.264
    [0x86, scte35Pid],  // SCTE-35
  ];
  const esBytes: number[] = [];
  for (const [type, pid] of streams) {
    esBytes.push(type, 0xe0 | ((pid >> 8) & 0x1f), pid & 0xff, 0xf0, 0x00);
  }
  const sectionLength = 9 + esBytes.length + 4;
  return withCrc([
    0x02,
    0xb0 | ((sectionLength >> 8) & 0x0f),
    sectionLength & 0xff,
    (programNumber >> 8) & 0xff, programNumber & 0xff,
    0xc1, 0x00, 0x00,
    0xe0 | ((pcrPid >> 8) & 0x1f), pcrPid & 0xff,
    0xf0, 0x00,       // program_info_length
    ...esBytes,
  ]);
}

// ------------------------------------------------------------------ build --

mkdirSync(OUT, { recursive: true });

// 1. CMAF segment with a version-1 emsg carrying SCTE-35.
const scte = spliceInsert(770001, 30, 3600);
const cmaf = Buffer.concat([
  Buffer.from(box("styp", new Uint8Array(Buffer.from("cmfsmsdh", "ascii")))),
  Buffer.from(emsgV1("urn:scte:scte35:2013:bin", "", 90000, 324_000_000, 2_700_000, 770001, scte)),
  Buffer.from(box("moof", box("mfhd", u32(0), u32(12)), box("traf", box("tfhd", u32(0), u32(1)), tfdt(324_000_000)))),
  Buffer.from(box("mdat", new Uint8Array(64))),
]);
writeFileSync(`${OUT}/cmaf-emsg.m4s`, cmaf);

// 2. The same signal as a version-0 emsg, which is delta-timed.
const cmaf0 = Buffer.concat([
  Buffer.from(box("styp", new Uint8Array(Buffer.from("cmfs", "ascii")))),
  Buffer.from(emsgV0("urn:scte:scte35:2013:bin", "", 90000, 180_000, 2_700_000, 770002, spliceInsert(770002, 30, 3602))),
  Buffer.from(box("moof", box("mfhd", u32(0), u32(13)), box("traf", box("tfhd", u32(0), u32(1)), tfdt(324_180_000)))),
  Buffer.from(box("mdat", new Uint8Array(32))),
]);
writeFileSync(`${OUT}/cmaf-emsg-v0.m4s`, cmaf0);

// 3. Transport stream: PAT, PMT declaring a type-0x86 PID, then two cues.
const VIDEO_PID = 0x0100;
const SCTE_PID = 0x01f0;
const PMT_PID = 0x1000;
const packets: Uint8Array[] = [
  tsPacket(0, sectionPayload(pat(1, PMT_PID)), true),
  tsPacket(PMT_PID, sectionPayload(pmt(1, VIDEO_PID, VIDEO_PID, SCTE_PID)), true),
  tsPacket(VIDEO_PID, new Uint8Array(180), true),
  tsPacket(SCTE_PID, sectionPayload(spliceInsert(880001, 30, 7200)), true),
  tsPacket(VIDEO_PID, new Uint8Array(180), false),
  tsPacket(SCTE_PID, sectionPayload(spliceInsert(880002, 15, 7260)), true),
];
writeFileSync(`${OUT}/stream.ts`, Buffer.concat(packets.map((p) => Buffer.from(p))));

// 4. Transport stream carrying the cue the way HLS usually does: an ID3 PRIV
//    frame inside a metadata PES, on a stream_type 0x15 PID, with a PTS.
function pmtWithMetadata(programNumber: number, pcrPid: number, videoPid: number, metaPid: number): Uint8Array {
  const esBytes: number[] = [];
  esBytes.push(0x1b, 0xe0 | ((videoPid >> 8) & 0x1f), videoPid & 0xff, 0xf0, 0x00);
  // metadata_descriptor (0x26) naming ID3 as the format
  const md = [0x26, 0x0d, 0xff, 0xff, 0x49, 0x44, 0x33, 0x20, 0xff, 0x49, 0x44, 0x33, 0x20, 0x00, 0x0f];
  esBytes.push(0x15, 0xe0 | ((metaPid >> 8) & 0x1f), metaPid & 0xff, 0xf0 | ((md.length >> 8) & 0x0f), md.length & 0xff, ...md);
  const sectionLength = 9 + esBytes.length + 4;
  return withCrc([
    0x02, 0xb0 | ((sectionLength >> 8) & 0x0f), sectionLength & 0xff,
    (programNumber >> 8) & 0xff, programNumber & 0xff,
    0xc1, 0x00, 0x00,
    0xe0 | ((pcrPid >> 8) & 0x1f), pcrPid & 0xff,
    0xf0, 0x00,
    ...esBytes,
  ]);
}

function id3PrivPes(pts: number, owner: string, payload: Uint8Array): Uint8Array {
  const ownerBytes = Buffer.from(owner + "\0", "ascii");
  const frameBody = Buffer.concat([ownerBytes, Buffer.from(payload)]);
  const frame = Buffer.alloc(10 + frameBody.length);
  frame.write("PRIV", 0, "ascii");
  frame.writeUInt32BE(frameBody.length, 4);
  frameBody.copy(frame, 10);

  const id3 = Buffer.alloc(10 + frame.length);
  id3.write("ID3", 0, "ascii");
  id3[3] = 4; id3[4] = 0; id3[5] = 0;
  const sz = frame.length;
  id3[6] = (sz >> 21) & 0x7f; id3[7] = (sz >> 14) & 0x7f; id3[8] = (sz >> 7) & 0x7f; id3[9] = sz & 0x7f;
  frame.copy(id3, 10);

  const ptsBytes = Buffer.alloc(5);
  ptsBytes[0] = 0x21 | ((Math.floor(pts / 2 ** 30) & 0x07) << 1);
  ptsBytes[1] = (Math.floor(pts / 2 ** 22) & 0xff);
  ptsBytes[2] = 0x01 | ((Math.floor(pts / 2 ** 15) & 0x7f) << 1);
  ptsBytes[3] = (Math.floor(pts / 2 ** 7) & 0xff);
  ptsBytes[4] = 0x01 | ((pts & 0x7f) << 1);

  const header = Buffer.alloc(9);
  header[0] = 0x00; header[1] = 0x00; header[2] = 0x01; header[3] = 0xbd;
  header.writeUInt16BE(3 + 5 + id3.length, 4); // PES_packet_length
  header[6] = 0x80; header[7] = 0x80; header[8] = 5;
  return new Uint8Array(Buffer.concat([header, ptsBytes, id3]));
}

const META_PID = 0x0230;
const id3Pes = id3PrivPes(
  Math.round(7200 * 90000) % 2 ** 33,
  "urn:scte:scte35:2013:bin@",
  spliceInsert(990001, 30, 7200),
);
const id3Packets: Uint8Array[] = [
  tsPacket(0, sectionPayload(pat(1, PMT_PID)), true),
  tsPacket(PMT_PID, sectionPayload(pmtWithMetadata(1, VIDEO_PID, VIDEO_PID, META_PID)), true),
  tsPacket(VIDEO_PID, new Uint8Array(180), true),
  tsPacket(META_PID, id3Pes, true),
  tsPacket(VIDEO_PID, new Uint8Array(180), false),
];
writeFileSync(`${OUT}/stream-id3.ts`, Buffer.concat(id3Packets.map((p) => Buffer.from(p))));

// Everything generated must survive the project's own decoder.
for (const [name, s] of [
  ["emsg v1", scte],
  ["ts cue", spliceInsert(880001, 30, 7200)],
] as const) {
  const parsed = parseSpliceInfoSection("0x" + Buffer.from(s).toString("hex"));
  if (!parsed.crcValid) throw new Error(`${name}: generated an invalid CRC`);
}

console.log(`wrote ${OUT}/cmaf-emsg.m4s       (${cmaf.length} bytes, emsg v1)`);
console.log(`wrote ${OUT}/cmaf-emsg-v0.m4s    (${cmaf0.length} bytes, emsg v0)`);
console.log(`wrote ${OUT}/stream.ts           (${packets.length} packets, SCTE-35 section on PID 0x${SCTE_PID.toString(16)})`);
console.log(`wrote ${OUT}/stream-id3.ts       (${id3Packets.length} packets, ID3 PRIV cue on PID 0x${META_PID.toString(16)})`);
