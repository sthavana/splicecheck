/**
 * SCTE-35 splice_info_section decoder.
 * Implements ANSI/SCTE 35 (2022) section 9.2 and the descriptor loop in section 10.
 */

class BitReader {
  private bytes: Uint8Array;
  private pos = 0; // bit position

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }

  read(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++) {
      const byte = this.bytes[this.pos >> 3];
      if (byte === undefined) throw new Error("SCTE-35 payload truncated");
      const bit = (byte >> (7 - (this.pos & 7))) & 1;
      v = v * 2 + bit;
      this.pos++;
    }
    return v;
  }

  readBytes(n: number): Uint8Array {
    if (this.pos & 7) throw new Error("unaligned byte read");
    const start = this.pos >> 3;
    if (start + n > this.bytes.length) throw new Error("SCTE-35 payload truncated");
    this.pos += n * 8;
    return this.bytes.slice(start, start + n);
  }

  skip(n: number) {
    this.pos += n;
  }

  get bytePos(): number {
    return this.pos >> 3;
  }

  seekByte(n: number) {
    this.pos = n * 8;
  }
}

export interface SpliceTime {
  timeSpecified: boolean;
  /** 90kHz ticks */
  ptsTime?: number;
  /** seconds */
  ptsSeconds?: number;
}

export interface BreakDuration {
  autoReturn: boolean;
  ticks: number;
  seconds: number;
}

export interface SpliceInsert {
  spliceEventId: number;
  cancel: boolean;
  outOfNetwork?: boolean;
  programSplice?: boolean;
  spliceImmediate?: boolean;
  spliceTime?: SpliceTime;
  breakDuration?: BreakDuration;
  uniqueProgramId?: number;
  availNum?: number;
  availsExpected?: number;
}

/**
 * One event of a splice_schedule. Where splice_insert says "splice now, or at
 * this PTS", a schedule states a list of future splices against UTC — which is
 * why it is rare in streaming: it presumes a clock the packager and the encoder
 * agree on, and everything downstream works in PTS.
 */
export interface SpliceScheduleEvent {
  spliceEventId: number;
  cancel: boolean;
  outOfNetwork?: boolean;
  programSplice?: boolean;
  /** Seconds since the epoch, as the 32-bit UTC field states it. */
  utcSpliceTime?: number;
  utcSpliceTimeIso?: string;
  breakDuration?: BreakDuration;
  uniqueProgramId?: number;
  availNum?: number;
  availsExpected?: number;
}

export interface SegmentationDescriptor {
  tag: 0x02;
  segmentationEventId: number;
  cancel: boolean;
  programSegmentation?: boolean;
  deliveryNotRestricted?: boolean;
  webDeliveryAllowed?: boolean;
  noRegionalBlackout?: boolean;
  archiveAllowed?: boolean;
  deviceRestrictions?: number;
  /** 90kHz ticks */
  segmentationDurationTicks?: number;
  segmentationDurationSeconds?: number;
  upidType: number;
  upidTypeName: string;
  upidHex: string;
  upidText: string;
  typeId: number;
  typeName: string;
  segmentNum: number;
  segmentsExpected: number;
  subSegmentNum?: number;
  subSegmentsExpected?: number;
}

export interface GenericDescriptor {
  tag: number;
  tagName: string;
  identifier: string;
  lengthBytes: number;
  rawHex: string;
}

export type SpliceDescriptor = SegmentationDescriptor | GenericDescriptor;

export interface SpliceInfoSection {
  tableId: number;
  sectionLength: number;
  protocolVersion: number;
  encrypted: boolean;
  encryptionAlgorithm: number;
  ptsAdjustment: number;
  tier: number;
  spliceCommandType: number;
  spliceCommandName: string;
  spliceInsert?: SpliceInsert;
  timeSignal?: SpliceTime;
  spliceSchedule?: SpliceScheduleEvent[];
  descriptors: SpliceDescriptor[];
  crc32: number;
  crcValid: boolean;
  /** raw bytes, hex */
  hex: string;
}

export const SPLICE_COMMANDS: Record<number, string> = {
  0x00: "splice_null",
  0x04: "splice_schedule",
  0x05: "splice_insert",
  0x06: "time_signal",
  0x07: "bandwidth_reservation",
  0xff: "private_command",
};

export const SEGMENTATION_TYPES: Record<number, string> = {
  0x00: "Not Indicated",
  0x01: "Content Identification",
  0x10: "Program Start",
  0x11: "Program End",
  0x12: "Program Early Termination",
  0x13: "Program Breakaway",
  0x14: "Program Resumption",
  0x15: "Program Runover Planned",
  0x16: "Program Runover Unplanned",
  0x17: "Program Overlap Start",
  0x18: "Program Blackout Override",
  0x19: "Program Join",
  0x20: "Chapter Start",
  0x21: "Chapter End",
  0x22: "Break Start",
  0x23: "Break End",
  0x24: "Opening Credit Start",
  0x25: "Opening Credit End",
  0x26: "Closing Credit Start",
  0x27: "Closing Credit End",
  0x30: "Provider Advertisement Start",
  0x31: "Provider Advertisement End",
  0x32: "Distributor Advertisement Start",
  0x33: "Distributor Advertisement End",
  0x34: "Provider Placement Opportunity Start",
  0x35: "Provider Placement Opportunity End",
  0x36: "Distributor Placement Opportunity Start",
  0x37: "Distributor Placement Opportunity End",
  0x38: "Provider Overlay Placement Opportunity Start",
  0x39: "Provider Overlay Placement Opportunity End",
  0x3a: "Distributor Overlay Placement Opportunity Start",
  0x3b: "Distributor Overlay Placement Opportunity End",
  0x3c: "Provider Promo Start",
  0x3d: "Provider Promo End",
  0x3e: "Distributor Promo Start",
  0x3f: "Distributor Promo End",
  0x40: "Unscheduled Event Start",
  0x41: "Unscheduled Event End",
  0x42: "Alternate Content Opportunity Start",
  0x43: "Alternate Content Opportunity End",
  0x44: "Provider Ad Block Start",
  0x45: "Provider Ad Block End",
  0x46: "Distributor Ad Block Start",
  0x47: "Distributor Ad Block End",
  0x50: "Network Start",
  0x51: "Network End",
};

/** Segmentation type IDs that open a break/opportunity. */
export const START_TYPES = new Set([
  0x10, 0x13, 0x17, 0x20, 0x22, 0x24, 0x26, 0x30, 0x32, 0x34, 0x36, 0x38, 0x3a,
  0x3c, 0x3e, 0x40, 0x42, 0x44, 0x46, 0x50,
]);

/** Segmentation type IDs that close a break/opportunity. */
export const END_TYPES = new Set([
  0x11, 0x14, 0x21, 0x23, 0x25, 0x27, 0x31, 0x33, 0x35, 0x37, 0x39, 0x3b, 0x3d,
  0x3f, 0x41, 0x43, 0x45, 0x47, 0x51,
]);

/** Pairs a start type with the end type that closes it. */
export const TYPE_PAIRS: Record<number, number> = {
  0x10: 0x11, 0x13: 0x14, 0x20: 0x21, 0x22: 0x23, 0x24: 0x25, 0x26: 0x27,
  0x30: 0x31, 0x32: 0x33, 0x34: 0x35, 0x36: 0x37, 0x38: 0x39, 0x3a: 0x3b,
  0x3c: 0x3d, 0x3e: 0x3f, 0x40: 0x41, 0x42: 0x43, 0x44: 0x45, 0x46: 0x47,
  0x50: 0x51,
};

export const UPID_TYPES: Record<number, string> = {
  0x00: "Not Used",
  0x01: "User Defined (deprecated)",
  0x02: "ISCI (deprecated)",
  0x03: "Ad-ID",
  0x04: "UMID",
  0x05: "ISAN (deprecated)",
  0x06: "ISAN",
  0x07: "TID",
  0x08: "TI",
  0x09: "ADI",
  0x0a: "EIDR",
  0x0b: "ATSC Content Identifier",
  0x0c: "MPU",
  0x0d: "MID",
  0x0e: "ADS Information",
  0x0f: "URI",
  0x10: "UUID",
  0x11: "SCR",
};

const DESCRIPTOR_TAGS: Record<number, string> = {
  0x00: "avail_descriptor",
  0x01: "DTMF_descriptor",
  0x02: "segmentation_descriptor",
  0x03: "time_descriptor",
  0x04: "audio_descriptor",
};

/**
 * Whether a UPID is well formed for the type it claims to be.
 *
 * The decoder will render any bytes as a UPID, and a cue carrying a malformed
 * one is still a valid cue — it parses, its CRC validates, and the break opens
 * on time. What fails is downstream: an ad system looks the creative up by this
 * value and finds nothing, so the avail goes unfilled for a reason nothing in
 * the signalling chain reports.
 */
export interface UpidProblem {
  code: string;
  detail: string;
}

/** Types whose length the specification fixes. */
const UPID_FIXED_LENGTH: Record<number, number> = {
  0x06: 8, // ISAN
  0x08: 8, // TI, a 64-bit value
  0x0a: 12, // EIDR, the compact binary form
  0x10: 16, // UUID
};

/** Convenience for callers that hold a descriptor rather than raw bytes. */
export function validateDescriptorUpid(d: SegmentationDescriptor): UpidProblem | undefined {
  const hex = d.upidHex ?? "";
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  return validateUpid(d.upidType, bytes, d.upidText ?? "");
}

export function validateUpid(type: number, bytes: Uint8Array, text: string): UpidProblem | undefined {
  // Type 0 declares that no UPID is carried, so bytes with it are contradictory.
  if (type === 0x00) {
    return bytes.length > 0
      ? {
          code: "UPID_TYPE_NOT_USED",
          detail: `The descriptor declares segmentation_upid_type 0 ("Not Used") but carries ${bytes.length} bytes anyway. Receivers are entitled to ignore the value entirely, so whatever it identifies is not reaching the ad system.`,
        }
      : undefined;
  }

  if (bytes.length === 0) {
    return {
      code: "UPID_EMPTY",
      detail: `The descriptor declares a ${UPID_TYPES[type] ?? "0x" + type.toString(16)} UPID and then carries none. The break is signalled but nothing identifies what should run in it, so an ad system has no key to decision against.`,
    };
  }

  const fixed = UPID_FIXED_LENGTH[type];
  if (fixed !== undefined && bytes.length !== fixed) {
    return {
      code: "UPID_WRONG_LENGTH",
      detail: `A ${UPID_TYPES[type]} UPID is ${fixed} bytes; this one is ${bytes.length}. Parsers that read it positionally will take the wrong bytes, and those that validate the length will discard it.`,
    };
  }

  switch (type) {
    case 0x03: {
      // Ad-ID: four-character advertiser prefix, then seven, with an optional
      // trailing letter for the definition. Always upper case.
      if (!/^[A-Z0-9]{11,12}$/.test(text)) {
        return {
          code: "UPID_MALFORMED_ADID",
          detail: `"${text}" is not a valid Ad-ID. The format is eleven alphanumeric characters — a four-character advertiser prefix and a seven-character code — with an optional twelfth for the definition, all upper case. Ad systems look creatives up by this exact string, so a malformed one resolves to nothing.`,
        };
      }
      return undefined;
    }
    case 0x0f: {
      try {
        new URL(text);
      } catch {
        return {
          code: "UPID_MALFORMED_URI",
          detail: `The descriptor declares a URI UPID but "${text}" does not parse as one. Anything resolving it will fail, and most implementations will simply drop the segmentation descriptor.`,
        };
      }
      return undefined;
    }
    case 0x0c: {
      // MPU: a four-byte format identifier, then private data. Operators
      // commonly put JSON in the private part.
      if (bytes.length <= 4) {
        return {
          code: "UPID_MPU_NO_PRIVATE_DATA",
          detail: `An MPU UPID carries a four-byte format identifier followed by private data, and this one carries only the identifier. Whatever the operator encodes there — pod metadata, a placement id — is absent.`,
        };
      }
      return undefined;
    }
    case 0x0d: {
      // MID is a concatenation of sub-UPIDs, each with its own type and length.
      let i = 0;
      let count = 0;
      while (i + 2 <= bytes.length) {
        const len = bytes[i + 1];
        if (i + 2 + len > bytes.length) {
          return {
            code: "UPID_MID_TRUNCATED",
            detail: `The MID's sub-UPID ${count} declares ${len} bytes but only ${bytes.length - i - 2} remain. The concatenation is malformed, so every sub-UPID after this point is unreadable.`,
          };
        }
        i += 2 + len;
        count++;
      }
      return count === 0
        ? {
            code: "UPID_MID_EMPTY",
            detail: "The descriptor declares a MID — a concatenation of sub-UPIDs — but no complete sub-UPID could be read from it.",
          }
        : undefined;
    }
    default:
      return undefined;
  }
}

/** MPEG-2 style CRC-32: poly 0x04C11DB7, init 0xFFFFFFFF, no reflection, no final XOR. */
export function crc32Mpeg(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const b of bytes) {
    crc = (crc ^ (b << 24)) >>> 0;
    for (let i = 0; i < 8; i++) {
      crc = (crc & 0x80000000 ? ((crc << 1) ^ 0x04c11db7) : crc << 1) >>> 0;
    }
  }
  return crc >>> 0;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Accepts base64, `0x`-prefixed hex, or bare hex. */
export function decodePayloadBytes(payload: string): Uint8Array {
  const s = payload.trim().replace(/^"|"$/g, "");
  if (/^0x[0-9a-fA-F]+$/.test(s) || (/^[0-9a-fA-F]+$/.test(s) && s.length % 2 === 0 && s.toLowerCase().startsWith("fc"))) {
    const hex = s.replace(/^0x/, "");
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
    return out;
  }
  const bin = Buffer.from(s, "base64");
  return new Uint8Array(bin);
}

function readSpliceTime(r: BitReader): SpliceTime {
  const timeSpecified = r.read(1) === 1;
  if (!timeSpecified) {
    r.skip(7);
    return { timeSpecified: false };
  }
  r.skip(6);
  const ptsTime = r.read(33);
  return { timeSpecified: true, ptsTime, ptsSeconds: ptsTime / 90000 };
}

function readUpid(type: number, bytes: Uint8Array): { hex: string; text: string } {
  const hex = toHex(bytes);
  let text = "";
  // Types that carry printable text per SCTE 35 Table 22.
  if ([0x01, 0x02, 0x03, 0x07, 0x09, 0x0a, 0x0b, 0x0e, 0x0f, 0x11].includes(type)) {
    text = Buffer.from(bytes).toString("utf8").replace(/[^\x20-\x7e]/g, "");
  } else if (type === 0x08 && bytes.length === 8) {
    // Turner Identifier is a 64-bit value.
    text = "0x" + hex;
  } else if (type === 0x0c && bytes.length > 4) {
    // MPU: a 4-byte format_identifier followed by private data, which
    // operators commonly use to carry pod metadata as JSON.
    const fid = Buffer.from(bytes.slice(0, 4)).toString("ascii").replace(/[^\x20-\x7e]/g, "");
    const priv = Buffer.from(bytes.slice(4)).toString("utf8");
    text = /^[\x20-\x7e\s]*$/.test(priv) ? `${fid} ${priv}` : `${fid} 0x${hex.slice(8)}`;
  } else if (type === 0x0d) {
    // MID: a concatenation of sub-UPIDs, each with its own type and length.
    const parts: string[] = [];
    let i = 0;
    while (i + 2 <= bytes.length) {
      const t = bytes[i];
      const len = bytes[i + 1];
      const body = bytes.slice(i + 2, i + 2 + len);
      if (i + 2 + len > bytes.length) break;
      const sub = readUpid(t, body);
      parts.push(`${UPID_TYPES[t] ?? "0x" + t.toString(16)}=${sub.text || sub.hex}`);
      i += 2 + len;
    }
    text = parts.join(" | ");
  } else if (type === 0x10 && bytes.length === 16) {
    text = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  return { hex, text };
}

function parseSegmentationDescriptor(body: Uint8Array): SegmentationDescriptor {
  const r = new BitReader(body);
  const segmentationEventId = r.read(32);
  const cancel = r.read(1) === 1;
  r.skip(7); // reserved (2022 spec puts event_id_compliance_indicator here)

  const d: SegmentationDescriptor = {
    tag: 0x02,
    segmentationEventId,
    cancel,
    upidType: 0,
    upidTypeName: "",
    upidHex: "",
    upidText: "",
    typeId: 0,
    typeName: "",
    segmentNum: 0,
    segmentsExpected: 0,
  };
  if (cancel) return d;

  const programSegmentation = r.read(1) === 1;
  const durationFlag = r.read(1) === 1;
  const deliveryNotRestricted = r.read(1) === 1;
  d.programSegmentation = programSegmentation;
  d.deliveryNotRestricted = deliveryNotRestricted;

  if (!deliveryNotRestricted) {
    d.webDeliveryAllowed = r.read(1) === 1;
    d.noRegionalBlackout = r.read(1) === 1;
    d.archiveAllowed = r.read(1) === 1;
    d.deviceRestrictions = r.read(2);
  } else {
    r.skip(5);
  }

  if (!programSegmentation) {
    const componentCount = r.read(8);
    for (let i = 0; i < componentCount; i++) {
      r.skip(8); // component_tag
      r.skip(7); // reserved
      r.skip(33); // pts_offset
    }
  }

  if (durationFlag) {
    const ticks = r.read(40);
    d.segmentationDurationTicks = ticks;
    d.segmentationDurationSeconds = ticks / 90000;
  }

  const upidType = r.read(8);
  const upidLength = r.read(8);
  const upidBytes = upidLength > 0 ? r.readBytes(upidLength) : new Uint8Array(0);
  const upid = readUpid(upidType, upidBytes);
  d.upidType = upidType;
  d.upidTypeName = UPID_TYPES[upidType] ?? `Reserved (0x${upidType.toString(16)})`;
  d.upidHex = upid.hex;
  d.upidText = upid.text;

  d.typeId = r.read(8);
  d.typeName = SEGMENTATION_TYPES[d.typeId] ?? `Reserved (0x${d.typeId.toString(16)})`;
  d.segmentNum = r.read(8);
  d.segmentsExpected = r.read(8);

  if ([0x34, 0x36, 0x38, 0x3a].includes(d.typeId)) {
    try {
      d.subSegmentNum = r.read(8);
      d.subSegmentsExpected = r.read(8);
    } catch {
      // Optional trailing fields; encoders often omit them.
    }
  }
  return d;
}

export function parseSpliceInfoSection(payload: string): SpliceInfoSection {
  const bytes = decodePayloadBytes(payload);
  if (bytes.length < 14) throw new Error("payload too short to be a splice_info_section");

  const r = new BitReader(bytes);
  const tableId = r.read(8);
  if (tableId !== 0xfc) {
    throw new Error(`table_id is 0x${tableId.toString(16)}, expected 0xFC`);
  }
  r.skip(1); // section_syntax_indicator
  r.skip(1); // private_indicator
  r.skip(2); // sap_type
  const sectionLength = r.read(12);
  const totalLength = sectionLength + 3;

  const protocolVersion = r.read(8);
  const encrypted = r.read(1) === 1;
  const encryptionAlgorithm = r.read(6);
  const ptsAdjustment = r.read(33);
  r.skip(8); // cw_index
  const tier = r.read(12);
  const spliceCommandLength = r.read(12);
  const spliceCommandType = r.read(8);
  const commandStart = r.bytePos;

  const out: SpliceInfoSection = {
    tableId,
    sectionLength,
    protocolVersion,
    encrypted,
    encryptionAlgorithm,
    ptsAdjustment,
    tier,
    spliceCommandType,
    spliceCommandName: SPLICE_COMMANDS[spliceCommandType] ?? `unknown (0x${spliceCommandType.toString(16)})`,
    descriptors: [],
    crc32: 0,
    crcValid: false,
    hex: toHex(bytes),
  };

  if (spliceCommandType === 0x05) {
    const si: SpliceInsert = { spliceEventId: r.read(32), cancel: false };
    si.cancel = r.read(1) === 1;
    r.skip(7);
    if (!si.cancel) {
      si.outOfNetwork = r.read(1) === 1;
      si.programSplice = r.read(1) === 1;
      const durationFlag = r.read(1) === 1;
      si.spliceImmediate = r.read(1) === 1;
      r.skip(4);
      if (si.programSplice && !si.spliceImmediate) {
        si.spliceTime = readSpliceTime(r);
      }
      if (!si.programSplice) {
        const componentCount = r.read(8);
        for (let i = 0; i < componentCount; i++) {
          r.skip(8);
          if (!si.spliceImmediate) readSpliceTime(r);
        }
      }
      if (durationFlag) {
        const autoReturn = r.read(1) === 1;
        r.skip(6);
        const ticks = r.read(33);
        si.breakDuration = { autoReturn, ticks, seconds: ticks / 90000 };
      }
      si.uniqueProgramId = r.read(16);
      si.availNum = r.read(8);
      si.availsExpected = r.read(8);
    }
    out.spliceInsert = si;
  } else if (spliceCommandType === 0x06) {
    out.timeSignal = readSpliceTime(r);
  } else if (spliceCommandType === 0x04) {
    // splice_schedule: a count, then that many events stated against UTC
    // rather than PTS (2022 section 9.3.2).
    const count = r.read(8);
    const events: SpliceScheduleEvent[] = [];
    for (let i = 0; i < count; i++) {
      const ev: SpliceScheduleEvent = { spliceEventId: r.read(32), cancel: r.read(1) === 1 };
      r.skip(7);
      if (!ev.cancel) {
        ev.outOfNetwork = r.read(1) === 1;
        ev.programSplice = r.read(1) === 1;
        const durationFlag = r.read(1) === 1;
        r.skip(5);
        if (ev.programSplice) {
          const utc = r.read(32);
          ev.utcSpliceTime = utc;
          // The field is seconds since the epoch; 0 means "as soon as possible".
          ev.utcSpliceTimeIso = utc > 0 ? new Date(utc * 1000).toISOString() : undefined;
        } else {
          const componentCount = r.read(8);
          for (let c = 0; c < componentCount; c++) {
            r.skip(8); // component_tag
            r.skip(32); // utc_splice_time
          }
        }
        if (durationFlag) {
          const autoReturn = r.read(1) === 1;
          r.skip(6);
          const ticks = r.read(33);
          ev.breakDuration = { autoReturn, ticks, seconds: ticks / 90000 };
        }
        ev.uniqueProgramId = r.read(16);
        ev.availNum = r.read(8);
        ev.availsExpected = r.read(8);
      }
      events.push(ev);
    }
    out.spliceSchedule = events;
  }

  // splice_command_length may be 0xFFF ("unknown"); fall back to where parsing landed.
  if (spliceCommandLength !== 0xfff) {
    r.seekByte(commandStart + spliceCommandLength);
  }

  const descriptorLoopLength = r.read(16);
  const loopEnd = r.bytePos + descriptorLoopLength;
  while (r.bytePos + 2 <= loopEnd && r.bytePos + 2 <= bytes.length) {
    const tag = r.read(8);
    const len = r.read(8);
    const start = r.bytePos;
    if (start + len > bytes.length) break;
    const body = bytes.slice(start, start + len);
    if (tag === 0x02 && len >= 5) {
      try {
        // Skip the 4-byte identifier ('CUEI').
        out.descriptors.push(parseSegmentationDescriptor(body.slice(4)));
      } catch {
        out.descriptors.push({
          tag,
          tagName: "segmentation_descriptor (unparseable)",
          identifier: Buffer.from(body.slice(0, 4)).toString("ascii"),
          lengthBytes: len,
          rawHex: toHex(body),
        });
      }
    } else {
      out.descriptors.push({
        tag,
        tagName: DESCRIPTOR_TAGS[tag] ?? `descriptor 0x${tag.toString(16)}`,
        identifier: len >= 4 ? Buffer.from(body.slice(0, 4)).toString("ascii") : "",
        lengthBytes: len,
        rawHex: toHex(body),
      });
    }
    r.seekByte(start + len);
  }

  if (totalLength >= 4 && totalLength <= bytes.length) {
    const section = bytes.slice(0, totalLength);
    const dv = new DataView(section.buffer, section.byteOffset, section.byteLength);
    out.crc32 = dv.getUint32(totalLength - 4);
    out.crcValid = crc32Mpeg(section) === 0;
  }

  return out;
}
