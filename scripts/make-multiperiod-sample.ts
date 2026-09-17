/**
 * Generates fixtures/samples/multiperiod-dash/manifest.mpd — a synthetic but
 * realistic live multi-period DASH manifest where each avail is its own Period.
 *
 * Written rather than captured so the repository carries no operator's stream.
 * Every SCTE-35 payload is assembled here and verified by round-tripping it
 * through the project's own decoder, so the fixture cannot drift from the spec.
 *
 *   npx tsx scripts/make-multiperiod-sample.ts
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { crc32Mpeg, parseSpliceInfoSection } from "../src/lib/scte35";

const TIMESCALE = 10_000_000; // 100ns ticks, as several packagers emit
const VIDEO_SEG = 1.92;
const AUDIO_SEG = 1.92;

function b64(bytes: number[]): string {
  return Buffer.from(Uint8Array.from(bytes)).toString("base64");
}

/** time_signal carrying one segmentation_descriptor. */
function timeSignal(ptsSeconds: number, eventId: number, typeId: number, durationSeconds?: number): string {
  const pts = Math.round(ptsSeconds * 90000) % 2 ** 33;

  const desc: number[] = [];
  desc.push(0x43, 0x55, 0x45, 0x49); // "CUEI"
  desc.push((eventId >>> 24) & 0xff, (eventId >>> 16) & 0xff, (eventId >>> 8) & 0xff, eventId & 0xff);
  desc.push(0x7f); // cancel = 0, reserved
  const hasDuration = durationSeconds !== undefined;
  // program_segmentation = 1, duration flag, delivery_not_restricted = 1, reserved
  desc.push(0x80 | (hasDuration ? 0x40 : 0x00) | 0x20 | 0x1f);
  if (hasDuration) {
    const d = Math.round(durationSeconds! * 90000);
    desc.push(
      Math.floor(d / 2 ** 32) & 0xff,
      (d >>> 24) & 0xff,
      (d >>> 16) & 0xff,
      (d >>> 8) & 0xff,
      d & 0xff,
    );
  }
  desc.push(0x00, 0x00); // upid_type = Not Used, upid_length = 0
  desc.push(typeId, 0x00, 0x00); // segmentation_type_id, segment_num, segments_expected

  const loop: number[] = [0x02, desc.length, ...desc];

  const body: number[] = [];
  body.push(0x00); // protocol_version
  body.push(0x00, 0x00, 0x00, 0x00, 0x00); // encryption flags + pts_adjustment
  body.push(0x00); // cw_index
  body.push(0xff, 0xf0, 0x05); // tier 0xFFF + splice_command_length 5
  body.push(0x06); // time_signal
  body.push(0xfe | (Math.floor(pts / 2 ** 32) & 1)); // time_specified + reserved + pts MSB
  body.push((pts >>> 24) & 0xff, (pts >>> 16) & 0xff, (pts >>> 8) & 0xff, pts & 0xff);
  body.push((loop.length >> 8) & 0xff, loop.length & 0xff);
  body.push(...loop);

  const sectionLength = body.length + 4; // + CRC
  const bytes = [0xfc, 0x30 | ((sectionLength >> 8) & 0x0f), sectionLength & 0xff, ...body];
  const crc = crc32Mpeg(Uint8Array.from(bytes));
  bytes.push((crc >>> 24) & 0xff, (crc >>> 16) & 0xff, (crc >>> 8) & 0xff, crc & 0xff);
  return b64(bytes);
}

function timeline(startTicks: number, durationSeconds: number, segSeconds: number): string {
  const segTicks = Math.round(segSeconds * TIMESCALE);
  const whole = Math.floor(durationSeconds / segSeconds);
  const remainder = Math.round((durationSeconds - whole * segSeconds) * TIMESCALE);
  const parts = [`<S t="${startTicks}" d="${segTicks}"${whole > 1 ? ` r="${whole - 1}"` : ""} />`];
  if (remainder > 0) parts.push(`<S t="${startTicks + whole * segTicks}" d="${remainder}" />`);
  return parts.map((p) => `            ${p}`).join("\n");
}

interface Seg {
  kind: "content" | "ad";
  duration: number;
}

// A realistic hour-ish of linear: long programme segments broken by pods of
// 15.2s and 30.4s avails.
const PLAN: Seg[] = [
  { kind: "content", duration: 184.32 },
  { kind: "ad", duration: 30.4 },
  { kind: "ad", duration: 15.2 },
  { kind: "ad", duration: 30.4 },
  { kind: "content", duration: 249.6 },
  { kind: "ad", duration: 15.2 },
  { kind: "ad", duration: 30.4 },
  { kind: "ad", duration: 15.2 },
  { kind: "content", duration: 322.56 },
  { kind: "ad", duration: 30.4 },
  { kind: "ad", duration: 15.2 },
  { kind: "content", duration: 130.56 },
  { kind: "ad", duration: 15.2 },
];

const AST = Date.UTC(2026, 8, 17, 0, 0, 0);
const BASE_START = 86_400 * 3 + 4_215.36; // arbitrary point on the presentation timeline
let cursor = BASE_START;
let eventId = 480_100;

const periods: string[] = [];
PLAN.forEach((seg, i) => {
  const start = cursor;
  const startTicks = Math.round(start * TIMESCALE);
  const id = 91_000 + i;

  let events = "";
  if (seg.kind === "ad") {
    const startPayload = timeSignal(start, eventId, 0x30, seg.duration);
    const endPayload = timeSignal(start + seg.duration, eventId, 0x31);
    events = `    <EventStream schemeIdUri="urn:scte:scte35:2014:xml+bin" timescale="${TIMESCALE}">
      <Event id="${eventId}" presentationTime="${startTicks}" duration="${Math.round(seg.duration * TIMESCALE)}">
        <scte35:Signal><scte35:Binary>${startPayload}</scte35:Binary></scte35:Signal>
      </Event>
      <Event id="${eventId + 1}" presentationTime="${Math.round((start + seg.duration) * TIMESCALE)}">
        <scte35:Signal><scte35:Binary>${endPayload}</scte35:Binary></scte35:Signal>
      </Event>
    </EventStream>
`;
    eventId += 2;
  }

  periods.push(`  <Period id="${id}" start="PT${start.toFixed(4)}S">
${events}    <AdaptationSet id="0" mimeType="video/mp4" segmentAlignment="true" startWithSAP="1" par="16:9">
      <SegmentTemplate timescale="${TIMESCALE}" presentationTimeOffset="${startTicks}" media="$RepresentationID$_$Time$.m4v" initialization="$RepresentationID$_init.m4i">
        <SegmentTimeline>
${timeline(startTicks, seg.duration, VIDEO_SEG)}
        </SegmentTimeline>
      </SegmentTemplate>
      <Representation id="video-360" width="640" height="360" frameRate="30000/1001" codecs="avc1.4d401e" sar="1:1" bandwidth="800000" />
      <Representation id="video-720" width="1280" height="720" frameRate="60000/1001" codecs="avc1.640028" sar="1:1" bandwidth="3500000" />
      <Representation id="video-1080" width="1920" height="1080" frameRate="60000/1001" codecs="avc1.64002a" sar="1:1" bandwidth="5500000" />
    </AdaptationSet>
    <AdaptationSet id="1" mimeType="audio/mp4" lang="eng" segmentAlignment="true" startWithSAP="1">
      <SegmentTemplate timescale="${TIMESCALE}" presentationTimeOffset="${startTicks}" media="$RepresentationID$_$Time$.m4a" initialization="$RepresentationID$_init.m4i">
        <SegmentTimeline>
${timeline(startTicks, seg.duration, AUDIO_SEG)}
        </SegmentTimeline>
      </SegmentTemplate>
      <Representation id="audio-eng" audioSamplingRate="48000" codecs="mp4a.40.2" bandwidth="128000" />
    </AdaptationSet>
  </Period>`);

  cursor += seg.duration;
});

const mpd = `<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011"
     xmlns:scte35="urn:scte:scte35:2014:xml+bin"
     profiles="urn:mpeg:dash:profile:isoff-live:2011"
     type="dynamic"
     availabilityStartTime="${new Date(AST).toISOString().replace(".000", "")}"
     publishTime="${new Date(AST + cursor * 1000).toISOString().replace(".000", "")}"
     minimumUpdatePeriod="PT2S"
     minBufferTime="PT4S"
     timeShiftBufferDepth="PT30M"
     suggestedPresentationDelay="PT8S">
${periods.join("\n")}
</MPD>
`;

mkdirSync("fixtures/samples/multiperiod-dash", { recursive: true });
writeFileSync("fixtures/samples/multiperiod-dash/manifest.mpd", mpd);

// Every payload must survive the project's own decoder.
let checked = 0;
for (const m of mpd.matchAll(/<scte35:Binary>([^<]+)<\/scte35:Binary>/g)) {
  const s = parseSpliceInfoSection(m[1]);
  if (!s.crcValid) throw new Error("generated a payload with an invalid CRC");
  if (s.spliceCommandName !== "time_signal") throw new Error("expected time_signal");
  const d = s.descriptors.find((x) => "typeId" in x);
  if (!d) throw new Error("expected a segmentation_descriptor");
  checked++;
}
console.log(`wrote fixtures/samples/multiperiod-dash/manifest.mpd`);
console.log(`  ${PLAN.length} periods, ${PLAN.filter((p) => p.kind === "ad").length} avails`);
console.log(`  ${checked} SCTE-35 payloads generated and verified against the decoder`);
