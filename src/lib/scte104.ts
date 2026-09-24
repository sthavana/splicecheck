/**
 * SCTE-104: the message automation sends an encoder, before any of this is
 * SCTE-35.
 *
 * Everything else in this project starts at the encoder's output. This is the
 * input — the first transcription in the chain, and the only one nobody
 * downstream can see. Playout automation opens a TCP session to the encoder and
 * sends operations; the encoder turns them into splice_info_sections and
 * inserts them into the transport stream.
 *
 * That hop is where the chain's first opportunity to disagree with itself sits.
 * A pre-roll that is too short, a splice the automation marked immediate, an
 * event id that changes on the way through — all of them originate here and are
 * reported downstream as a packaging fault.
 *
 * Messages arrive as bytes: from a capture, a vendor's debug log, or an
 * automation system's own trace. This reads them.
 */

import type { Finding, Severity } from "./analyze";
import type { SpliceInfoSection } from "./scte35";

/** Operations this decoder understands, from SCTE 104 2019 table 8-3. */
export const SCTE104_OPS: Record<number, string> = {
  0x0000: "inject_response_data",
  0x0001: "init_request_data",
  0x0002: "init_response_data",
  0x0003: "alive_request_data",
  0x0004: "alive_response_data",
  0x0007: "inject_complete_response_data",
  0x0008: "config_request_data",
  0x0009: "config_response_data",
  0x0101: "splice_request_data",
  0x0102: "splice_null_request_data",
  0x0103: "start_schedule_download_request_data",
  0x0104: "time_signal_request_data",
  0x0105: "insert_descriptor_request_data",
  0x0106: "insert_DTMF_descriptor_request_data",
  0x0107: "insert_segmentation_descriptor_request_data",
  0x0108: "proprietary_command_request_data",
  0x0109: "schedule_definition_data",
  0x010a: "insert_tier_data",
  0x010b: "insert_time_descriptor",
};

/** splice_insert_type, table 8-5. */
export const SPLICE_INSERT_TYPES: Record<number, string> = {
  0x00: "reserved",
  0x01: "spliceStart_normal",
  0x02: "spliceStart_immediate",
  0x03: "spliceEnd_normal",
  0x04: "spliceEnd_immediate",
  0x05: "splice_cancel",
};

export interface SpliceRequest {
  spliceInsertType: number;
  spliceInsertTypeName: string;
  spliceEventId: number;
  uniqueProgramId: number;
  /** Milliseconds between the message and the splice point. */
  preRollMs: number;
  /** Tenths of a second, as the field states it. */
  breakDurationTenths: number;
  breakDurationSeconds: number;
  availNum: number;
  availsExpected: number;
  autoReturn: boolean;
}

export interface SegmentationRequest {
  eventId: number;
  eventCancelIndicator: boolean;
  durationTenths?: number;
  durationSeconds?: number;
  upidType: number;
  upidHex: string;
  upidText: string;
  typeId: number;
  segmentNum: number;
  segmentsExpected: number;
}

export interface Scte104Operation {
  opId: number;
  opName: string;
  lengthBytes: number;
  spliceRequest?: SpliceRequest;
  segmentation?: SegmentationRequest;
  /** For operations this decoder does not break down. */
  rawHex?: string;
}

export interface Scte104Message {
  /** A single message carries one operation; a multiple message carries many. */
  kind: "single" | "multiple";
  protocolVersion: number;
  asIndex: number;
  messageNumber: number;
  dpiPidIndex: number;
  /** Only in a multiple operation message. */
  scte35ProtocolVersion?: number;
  timestamp?: { type: number; typeName: string; utcSeconds?: number; utcIso?: string };
  operations: Scte104Operation[];
  hex: string;
}

const TIME_TYPES: Record<number, string> = {
  0: "none",
  1: "UTC",
  2: "VITC",
  3: "GPI",
};

class Reader {
  constructor(
    private b: Uint8Array,
    public pos = 0,
  ) {}
  u8(): number {
    if (this.pos >= this.b.length) throw new Error("SCTE-104 message truncated");
    return this.b[this.pos++];
  }
  u16(): number {
    return (this.u8() << 8) | this.u8();
  }
  u32(): number {
    return this.u16() * 65536 + this.u16();
  }
  bytes(n: number): Uint8Array {
    if (this.pos + n > this.b.length) throw new Error("SCTE-104 message truncated");
    const out = this.b.slice(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
  get remaining(): number {
    return this.b.length - this.pos;
  }
}

/** Accepts base64, `0x`-prefixed hex, or bare hex with or without separators. */
export function decodeMessageBytes(input: string): Uint8Array {
  const s = input.trim().replace(/^"|"$/g, "");
  const cleaned = s.replace(/^0x/i, "").replace(/[\s:,-]/g, "");
  if (/^[0-9a-fA-F]+$/.test(cleaned) && cleaned.length % 2 === 0) {
    const out = new Uint8Array(cleaned.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(cleaned.substr(i * 2, 2), 16);
    return out;
  }
  return new Uint8Array(Buffer.from(s, "base64"));
}

function toHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

function readSpliceRequest(r: Reader): SpliceRequest {
  const spliceInsertType = r.u8();
  const spliceEventId = r.u32();
  const uniqueProgramId = r.u16();
  const preRollMs = r.u16();
  const breakDurationTenths = r.u16();
  const availNum = r.u8();
  const availsExpected = r.u8();
  const autoReturn = r.u8() === 1;
  return {
    spliceInsertType,
    spliceInsertTypeName: SPLICE_INSERT_TYPES[spliceInsertType] ?? `unknown (0x${spliceInsertType.toString(16)})`,
    spliceEventId,
    uniqueProgramId,
    preRollMs,
    breakDurationTenths,
    breakDurationSeconds: breakDurationTenths / 10,
    availNum,
    availsExpected,
    autoReturn,
  };
}

function readSegmentation(r: Reader): SegmentationRequest {
  const eventId = r.u32();
  const eventCancelIndicator = r.u8() === 1;
  const durationTenths = r.u16();
  const upidType = r.u8();
  const upidLength = r.u8();
  const upid = r.bytes(upidLength);
  const typeId = r.u8();
  const segmentNum = r.u8();
  const segmentsExpected = r.u8();
  const printable = [0x01, 0x02, 0x03, 0x07, 0x09, 0x0a, 0x0b, 0x0e, 0x0f, 0x11].includes(upidType);
  return {
    eventId,
    eventCancelIndicator,
    durationTenths,
    durationSeconds: durationTenths / 10,
    upidType,
    upidHex: toHex(upid),
    upidText: printable ? Buffer.from(upid).toString("utf8").replace(/[^\x20-\x7e]/g, "") : "",
    typeId,
    segmentNum,
    segmentsExpected,
  };
}

function readOperation(opId: number, body: Uint8Array): Scte104Operation {
  const op: Scte104Operation = {
    opId,
    opName: SCTE104_OPS[opId] ?? `unknown (0x${opId.toString(16).padStart(4, "0")})`,
    lengthBytes: body.length,
  };
  const r = new Reader(body);
  try {
    if (opId === 0x0101) op.spliceRequest = readSpliceRequest(r);
    else if (opId === 0x0107) op.segmentation = readSegmentation(r);
    else op.rawHex = toHex(body);
  } catch {
    op.rawHex = toHex(body);
  }
  return op;
}

export function parseScte104(input: string): Scte104Message {
  const bytes = decodeMessageBytes(input);
  if (bytes.length < 6) throw new Error("too short to be an SCTE-104 message");
  const r = new Reader(bytes);

  // A multiple operation message is identified by opID 0xFFFF in the first
  // field; anything else is a single operation message whose opID it is.
  const first = r.u16();
  const hex = toHex(bytes);

  if (first === 0xffff) {
    const messageSize = r.u16();
    void messageSize;
    const protocolVersion = r.u8();
    const asIndex = r.u8();
    const messageNumber = r.u8();
    const dpiPidIndex = r.u16();
    const scte35ProtocolVersion = r.u8();
    const timeType = r.u8();
    let timestamp: Scte104Message["timestamp"];
    if (timeType === 1) {
      const utc = r.u32();
      r.u8(); // microseconds, high
      r.u16(); // microseconds, low
      timestamp = { type: timeType, typeName: TIME_TYPES[timeType], utcSeconds: utc, utcIso: new Date(utc * 1000).toISOString() };
    } else if (timeType === 2) {
      r.bytes(4);
      timestamp = { type: timeType, typeName: TIME_TYPES[timeType] };
    } else if (timeType === 3) {
      r.bytes(2);
      timestamp = { type: timeType, typeName: TIME_TYPES[timeType] };
    } else {
      timestamp = { type: 0, typeName: TIME_TYPES[0] };
    }

    const numOps = r.u8();
    const operations: Scte104Operation[] = [];
    for (let i = 0; i < numOps && r.remaining >= 4; i++) {
      const opId = r.u16();
      const len = r.u16();
      operations.push(readOperation(opId, r.bytes(Math.min(len, r.remaining))));
    }

    return {
      kind: "multiple",
      protocolVersion,
      asIndex,
      messageNumber,
      dpiPidIndex,
      scte35ProtocolVersion,
      timestamp,
      operations,
      hex,
    };
  }

  const messageSize = r.u16();
  void messageSize;
  const protocolVersion = r.u8();
  const asIndex = r.u8();
  const messageNumber = r.u8();
  const dpiPidIndex = r.u16();
  const body = r.bytes(r.remaining);
  return {
    kind: "single",
    protocolVersion,
    asIndex,
    messageNumber,
    dpiPidIndex,
    operations: [readOperation(first, body)],
    hex,
  };
}

/* --------------------------------------------------------------- rules -- */

/**
 * Below this, an ad decision cannot complete before the splice point. The
 * figure is not in any specification — it is the practical floor the industry
 * converged on, and it is the same lead-time problem the low-latency rules
 * measure from the other end.
 */
const SHORT_PRE_ROLL_MS = 4000;

export function analyzeScte104(msg: Scte104Message): Finding[] {
  const findings: Finding[] = [];
  const add = (severity: Severity, code: string, title: string, detail: string) =>
    findings.push({ severity, code, title, detail });

  if (msg.operations.length === 0) {
    add(
      "warning",
      "S104_NO_OPERATIONS",
      "The message carries no operations",
      "A well-formed message with nothing in it. Whatever the automation system intended to ask for, the encoder was asked for nothing.",
    );
    return findings;
  }

  for (const op of msg.operations) {
    if (!SCTE104_OPS[op.opId]) {
      add(
        "info",
        "S104_UNKNOWN_OPERATION",
        `Operation 0x${op.opId.toString(16).padStart(4, "0")} is not a standard opID`,
        "The operation is outside the set the specification defines. Vendors do use private ranges, and an encoder that does not recognise it will ignore it — so whatever it was meant to do will silently not happen.",
      );
      continue;
    }

    const s = op.spliceRequest;
    if (s) {
      // The whole lead-time argument, at its source.
      const starts = s.spliceInsertType === 0x01 || s.spliceInsertType === 0x02;
      if (starts && s.spliceInsertType === 0x02) {
        add(
          "warning",
          "S104_IMMEDIATE_SPLICE",
          "The splice is requested as immediate",
          "spliceStart_immediate tells the encoder to splice at the first opportunity rather than at a stated pre-roll. Everything downstream then learns of the break at the moment it begins: an ad decision service has no time to call out, choose a pod and have creatives ready, and commonly returns slate for the first seconds of the avail. Automation that can schedule the splice should state a pre-roll instead.",
        );
      } else if (starts && s.preRollMs < SHORT_PRE_ROLL_MS) {
        add(
          "warning",
          "S104_SHORT_PRE_ROLL",
          `Pre-roll is ${(s.preRollMs / 1000).toFixed(1)}s`,
          `The encoder is told to splice ${(s.preRollMs / 1000).toFixed(1)}s from now, and that is the entire warning the rest of the chain gets. An ad decision has to reach a decision service, run an auction, select a pod and confirm the creatives are ready inside it. Under about four seconds, fill rates fall sharply — and the symptom appears at the far end of the chain as an avail that did not fill.`,
        );
      }

      if (starts && s.breakDurationTenths === 0) {
        add(
          "warning",
          "S104_NO_BREAK_DURATION",
          "The splice request states no break duration",
          "Nothing tells the encoder how long the avail runs, so the SCTE-35 it emits carries no duration either. An ad decision service cannot be told how much inventory to fill, and the return depends entirely on a second message arriving.",
        );
      }

      if (starts && !s.autoReturn && s.breakDurationTenths > 0) {
        add(
          "info",
          "S104_NO_AUTO_RETURN",
          "The break does not auto-return",
          "The automation promises an explicit spliceEnd rather than letting the duration close the break. That is a normal choice, and it makes the return dependent on a second message: if it is lost, receivers honouring auto_return would have come back on their own and these will not.",
        );
      }

      if (s.availsExpected > 0 && s.availNum > s.availsExpected) {
        add(
          "warning",
          "S104_AVAIL_NUMBERING",
          `This is avail ${s.availNum} of ${s.availsExpected}`,
          "The avail number is higher than the number expected in the break. Systems that count avails in a pod will either discard this one or lose track of the pod's shape.",
        );
      }
    }
  }

  return findings;
}

/* --------------------------------------- against what the encoder emitted */

export interface Scte104Comparison {
  findings: Finding[];
  /** Fields present on both sides, and whether they agree. */
  checked: { field: string; requested: string; emitted: string; agrees: boolean }[];
}

/**
 * The first transcription in the chain, checked.
 *
 * An encoder is handed an SCTE-104 operation and emits a splice_info_section.
 * The two are separate artefacts produced by different software, and nothing in
 * the delivery path compares them — which is the same argument this project
 * makes about manifests and segments, one hop further upstream.
 */
export function compareScte104ToScte35(
  msg: Scte104Message,
  section: SpliceInfoSection,
): Scte104Comparison {
  const findings: Finding[] = [];
  const checked: Scte104Comparison["checked"] = [];
  const add = (severity: Severity, code: string, title: string, detail: string) =>
    findings.push({ severity, code, title, detail });

  const splice = msg.operations.find((o) => o.spliceRequest)?.spliceRequest;
  const seg104 = msg.operations.find((o) => o.segmentation)?.segmentation;
  const si = section.spliceInsert;
  const descriptors = section.descriptors.filter((d) => "typeId" in d) as {
    typeId: number;
    segmentationEventId: number;
    segmentationDurationSeconds?: number;
  }[];

  if (!splice && !seg104) {
    add(
      "info",
      "S104_NOTHING_TO_COMPARE",
      "The message carries no splice or segmentation request",
      "Only requests that ask for a splice have a counterpart in the emitted section; alive and config operations have nothing to compare against.",
    );
    return { findings, checked };
  }

  const note = (field: string, requested: unknown, emitted: unknown) => {
    const a = String(requested ?? "—");
    const b = String(emitted ?? "—");
    checked.push({ field, requested: a, emitted: b, agrees: a === b });
    return a === b;
  };

  if (splice) {
    if (si) {
      if (!note("event id", splice.spliceEventId, si.spliceEventId)) {
        add(
          "error",
          "S104_EVENT_ID_CHANGED",
          `Automation asked for event ${splice.spliceEventId}, the encoder emitted ${si.spliceEventId}`,
          "Every system downstream keys on the event id: it is how a break start is paired with its end, how an ad system deduplicates, and how anybody reconciles a report against a schedule. An id that changes at the encoder makes the automation's record and the stream's record impossible to line up.",
        );
      }
      const wantsOut = splice.spliceInsertType === 0x01 || splice.spliceInsertType === 0x02;
      if (!note("out of network", wantsOut, si.outOfNetwork)) {
        add(
          "error",
          "S104_DIRECTION_CHANGED",
          `Automation asked for ${splice.spliceInsertTypeName} and the encoder emitted out_of_network=${si.outOfNetwork}`,
          "The request to leave the programme became a request to return to it, or the reverse. A break will open where one should close, and the avail state machine downstream is wrong from this point on.",
        );
      }
      if (splice.breakDurationTenths > 0) {
        const emitted = si.breakDuration?.seconds;
        const agrees =
          emitted !== undefined && Math.abs(emitted - splice.breakDurationSeconds) < 0.05;
        checked.push({
          field: "duration",
          requested: `${splice.breakDurationSeconds}s`,
          emitted: emitted !== undefined ? `${emitted.toFixed(1)}s` : "—",
          agrees,
        });
        if (!agrees) {
          add(
            "error",
            "S104_DURATION_CHANGED",
            `Automation asked for ${splice.breakDurationSeconds}s, the encoder emitted ${emitted?.toFixed(1) ?? "no"} duration`,
            "The avail length the automation scheduled is not the one the stream advertises. Ad decisioning fills to the figure in the SCTE-35, and the schedule was built against the other one, so every break is the wrong length by the same amount.",
          );
        }
      }
      note("auto return", splice.autoReturn, si.breakDuration?.autoReturn);
    } else if (section.timeSignal) {
      add(
        "info",
        "S104_FORM_CHANGED",
        "Automation requested a splice_insert and the encoder emitted a time_signal",
        "This is a normal and deliberate conversion — a time_signal with segmentation descriptors carries more than a splice_insert can, and many encoders are configured to do it. It is worth noticing because the two forms pair differently downstream, and a receiver expecting one may not act on the other.",
      );
    } else {
      add(
        "error",
        "S104_NO_SPLICE_EMITTED",
        "A splice was requested and the section carries no splice command",
        `The automation asked for ${splice.spliceInsertTypeName} and the encoder emitted ${section.spliceCommandName}. Nothing downstream will open a break, and the schedule will record one that never happened.`,
      );
    }
  }

  if (seg104) {
    const match = descriptors.find((d) => d.segmentationEventId === seg104.eventId);
    note("segmentation event id", seg104.eventId, match?.segmentationEventId);
    if (!match && descriptors.length > 0) {
      add(
        "error",
        "S104_SEGMENTATION_EVENT_ID_CHANGED",
        `Automation asked for segmentation event ${seg104.eventId}, the section carries ${descriptors.map((d) => d.segmentationEventId).join(", ")}`,
        "The segmentation descriptor's event id is what pairs a start with its end. Changed at the encoder, the pairing downstream is against an id the automation has never heard of.",
      );
    } else if (match) {
      note("segmentation type", `0x${seg104.typeId.toString(16)}`, `0x${match.typeId.toString(16)}`);
      if (seg104.typeId !== match.typeId) {
        add(
          "error",
          "S104_SEGMENTATION_TYPE_CHANGED",
          `Automation asked for segmentation type 0x${seg104.typeId.toString(16)}, the encoder emitted 0x${match.typeId.toString(16)}`,
          "The segmentation type says what kind of opportunity this is — a provider placement opportunity, a distributor one, a chapter, a blackout. Systems apply different rules to each, so a changed type is a break handled under the wrong policy.",
        );
      }
    }
  }

  return { findings, checked };
}
