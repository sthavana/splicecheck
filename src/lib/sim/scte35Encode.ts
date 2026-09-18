/**
 * SCTE-35 splice_info_section encoder — the inverse of the decoder in
 * `../scte35.ts`, following the same clause numbering (ANSI/SCTE 35 2022
 * section 9.2 and the descriptor loop in section 10).
 *
 * The simulator needs to emit signalling that is real rather than a plausible
 * looking string: everything produced here is decoded back by the project's own
 * parser in the tests, and the CRC is computed the same way a receiver checks
 * it. A payload that this writes and that parser rejects is a bug in one of the
 * two, which is the point of keeping them as a matched pair.
 */

import { crc32Mpeg } from "../scte35";

class BitWriter {
  private bits: number[] = [];

  /**
   * Values wider than 32 bits are ordinary here — pts_time is 33 and
   * segmentation_duration is 40 — so this works in floating point rather than
   * with shifts, which would silently truncate at 32.
   */
  write(n: number, value: number) {
    if (n > 40) throw new Error(`field of ${n} bits is wider than this writer supports`);
    if (value < 0) throw new Error("negative value in a bit field");
    const v = Math.floor(value);
    for (let i = n - 1; i >= 0; i--) {
      this.bits.push(Math.floor(v / Math.pow(2, i)) % 2);
    }
  }

  /** Reserved fields are all-ones on the wire, not all-zeros. */
  reserved(n: number) {
    for (let i = 0; i < n; i++) this.bits.push(1);
  }

  flag(b: boolean) {
    this.bits.push(b ? 1 : 0);
  }

  bytes(b: Uint8Array) {
    if (this.bits.length % 8) throw new Error("unaligned byte write");
    for (const x of b) this.write(8, x);
  }

  get bitLength(): number {
    return this.bits.length;
  }

  finish(): Uint8Array {
    if (this.bits.length % 8) throw new Error("section did not end on a byte boundary");
    const out = new Uint8Array(this.bits.length / 8);
    for (let i = 0; i < this.bits.length; i++) {
      if (this.bits[i]) out[i >> 3] |= 1 << (7 - (i & 7));
    }
    return out;
  }
}

export interface SpliceTimeSpec {
  /** 90kHz ticks. Omit for an immediate splice. */
  ptsTime?: number;
}

export interface SegmentationDescriptorSpec {
  eventId: number;
  /** See SEGMENTATION_TYPES in ../scte35. 0x34 / 0x35 are the placement pair. */
  typeId: number;
  /** Seconds. Only start types carry one. */
  durationSeconds?: number;
  upidType?: number;
  /** Text for the printable UPID types, or raw bytes for the rest. */
  upid?: string | Uint8Array;
  segmentNum?: number;
  segmentsExpected?: number;
  /** Absent means delivery_not_restricted, which is the common live case. */
  restrictions?: {
    webDeliveryAllowed: boolean;
    noRegionalBlackout: boolean;
    archiveAllowed: boolean;
    deviceRestrictions: number;
  };
}

export interface SpliceInsertSpec {
  eventId: number;
  /** True opens an avail (out of network), false returns to programme. */
  outOfNetwork: boolean;
  spliceTime?: SpliceTimeSpec;
  /** Omit on the return signal. */
  durationSeconds?: number;
  /** When false the encoder promises an explicit return signal. */
  autoReturn?: boolean;
  uniqueProgramId?: number;
  availNum?: number;
  availsExpected?: number;
  /** Splice at the first opportunity; no splice_time is carried. */
  immediate?: boolean;
}

export interface SectionSpec {
  ptsAdjustment?: number;
  tier?: number;
  spliceInsert?: SpliceInsertSpec;
  /** A time_signal carries no parameters of its own; meaning lives in the descriptors. */
  timeSignal?: SpliceTimeSpec;
  descriptors?: SegmentationDescriptorSpec[];
}

export const TICKS_PER_SECOND = 90000;

/** The 33-bit PTS field wraps roughly every 26.5 hours. */
export const PTS_MODULUS = 2 ** 33;

export function secondsToTicks(seconds: number): number {
  return Math.round(seconds * TICKS_PER_SECOND) % PTS_MODULUS;
}

function writeSpliceTime(w: BitWriter, t: SpliceTimeSpec | undefined) {
  if (!t || t.ptsTime === undefined) {
    w.flag(false); // time_specified_flag
    w.reserved(7);
    return;
  }
  w.flag(true);
  w.reserved(6);
  w.write(33, t.ptsTime % PTS_MODULUS);
}

function upidBytes(spec: SegmentationDescriptorSpec): Uint8Array {
  if (spec.upid === undefined) return new Uint8Array(0);
  if (spec.upid instanceof Uint8Array) return spec.upid;
  return new Uint8Array(Buffer.from(spec.upid, "utf8"));
}

function writeSegmentationDescriptor(spec: SegmentationDescriptorSpec): Uint8Array {
  const w = new BitWriter();
  w.write(32, spec.eventId);
  w.flag(false); // segmentation_event_cancel_indicator
  w.reserved(7);

  w.flag(true); // program_segmentation_flag — the simulator never splits by component
  const hasDuration = spec.durationSeconds !== undefined;
  w.flag(hasDuration);
  const notRestricted = !spec.restrictions;
  w.flag(notRestricted);

  if (!notRestricted) {
    const r = spec.restrictions!;
    w.flag(r.webDeliveryAllowed);
    w.flag(r.noRegionalBlackout);
    w.flag(r.archiveAllowed);
    w.write(2, r.deviceRestrictions);
  } else {
    w.reserved(5);
  }

  if (hasDuration) w.write(40, Math.round(spec.durationSeconds! * TICKS_PER_SECOND));

  const upid = upidBytes(spec);
  w.write(8, spec.upidType ?? 0x00);
  w.write(8, upid.length);
  w.bytes(upid);

  w.write(8, spec.typeId);
  w.write(8, spec.segmentNum ?? 1);
  w.write(8, spec.segmentsExpected ?? 1);

  // Placement opportunity types carry the sub-segment pair (2022 section 10.3.3).
  if ([0x34, 0x36, 0x38, 0x3a].includes(spec.typeId)) {
    w.write(8, 0);
    w.write(8, 0);
  }

  return w.finish();
}

function writeSpliceInsert(spec: SpliceInsertSpec): Uint8Array {
  const w = new BitWriter();
  w.write(32, spec.eventId);
  w.flag(false); // splice_event_cancel_indicator
  w.reserved(7);

  w.flag(spec.outOfNetwork);
  w.flag(true); // program_splice_flag
  const hasDuration = spec.durationSeconds !== undefined;
  w.flag(hasDuration);
  const immediate = spec.immediate === true;
  w.flag(immediate);
  w.reserved(4);

  if (!immediate) writeSpliceTime(w, spec.spliceTime);

  if (hasDuration) {
    w.flag(spec.autoReturn ?? true);
    w.reserved(6);
    w.write(33, Math.round(spec.durationSeconds! * TICKS_PER_SECOND));
  }

  w.write(16, spec.uniqueProgramId ?? 1);
  w.write(8, spec.availNum ?? 0);
  w.write(8, spec.availsExpected ?? 0);
  return w.finish();
}

/** Builds a complete splice_info_section and returns its bytes. */
export function buildSection(spec: SectionSpec): Uint8Array {
  if (!spec.spliceInsert && !spec.timeSignal) {
    throw new Error("a section needs either a splice_insert or a time_signal");
  }
  if (spec.spliceInsert && spec.timeSignal) {
    throw new Error("a section carries one command, not both");
  }

  const commandType = spec.spliceInsert ? 0x05 : 0x06;
  let command: Uint8Array;
  if (spec.spliceInsert) {
    command = writeSpliceInsert(spec.spliceInsert);
  } else {
    const w = new BitWriter();
    writeSpliceTime(w, spec.timeSignal);
    command = w.finish();
  }

  // Each descriptor is the 'CUEI' identifier followed by its body.
  const descriptors = (spec.descriptors ?? []).map((d) => {
    const body = writeSegmentationDescriptor(d);
    const out = new Uint8Array(2 + 4 + body.length);
    out[0] = 0x02; // segmentation_descriptor
    out[1] = 4 + body.length;
    out.set([0x43, 0x55, 0x45, 0x49], 2); // 'CUEI'
    out.set(body, 6);
    return out;
  });
  const descriptorLoopLength = descriptors.reduce((n, d) => n + d.length, 0);

  // section_length counts everything after the field itself, including the CRC:
  // the 11 bytes from protocol_version through splice_command_type, the command,
  // the 2-byte loop length, the loop, and 4 bytes of CRC.
  const sectionLength = 11 + command.length + 2 + descriptorLoopLength + 4;

  const w = new BitWriter();
  w.write(8, 0xfc); // table_id
  w.flag(false); // section_syntax_indicator
  w.flag(false); // private_indicator
  w.reserved(2); // sap_type: 3 = not applicable
  w.write(12, sectionLength);
  w.write(8, 0); // protocol_version
  w.flag(false); // encrypted_packet
  w.write(6, 0); // encryption_algorithm
  w.write(33, (spec.ptsAdjustment ?? 0) % PTS_MODULUS);
  w.reserved(8); // cw_index — reserved, and all-ones on the wire when not encrypted
  w.write(12, spec.tier ?? 0xfff);
  w.write(12, command.length);
  w.write(8, commandType);
  w.bytes(command);
  w.write(16, descriptorLoopLength);
  for (const d of descriptors) w.bytes(d);

  const body = w.finish();
  const out = new Uint8Array(body.length + 4);
  out.set(body, 0);
  // A receiver runs the CRC over the whole section and expects zero, which
  // holds when the value computed over the body is appended to it.
  const crc = crc32Mpeg(body);
  out[body.length] = (crc >>> 24) & 0xff;
  out[body.length + 1] = (crc >>> 16) & 0xff;
  out[body.length + 2] = (crc >>> 8) & 0xff;
  out[body.length + 3] = crc & 0xff;
  return out;
}

export function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

export function toHex(bytes: Uint8Array): string {
  return "0x" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
}

/** Convenience: a section as both of the forms manifests carry. */
export function buildPayload(spec: SectionSpec): { base64: string; hex: string; bytes: Uint8Array } {
  const bytes = buildSection(spec);
  return { base64: toBase64(bytes), hex: toHex(bytes), bytes };
}
