import { test } from "node:test";
import assert from "node:assert/strict";
import { parseScte104, analyzeScte104, compareScte104ToScte35, decodeMessageBytes } from "../src/lib/scte104";
import { parseSpliceInfoSection } from "../src/lib/scte35";
import { buildPayload } from "../src/lib/sim/scte35Encode";

/*
 * SCTE-104 is the first transcription in the chain and the only one nobody
 * downstream can see. Automation asks the encoder for a splice; the encoder
 * emits a splice_info_section. Two artefacts, different software, and nothing
 * in the delivery path compares them — which is the argument this project makes
 * about manifests and segments, one hop further upstream.
 */

/** A multiple_operation_message carrying one splice_request_data. */
function message(o: {
  type?: number;
  eventId?: number;
  preRollMs?: number;
  durTenths?: number;
  autoReturn?: boolean;
  availNum?: number;
  availsExpected?: number;
} = {}): string {
  const op: number[] = [];
  op.push(o.type ?? 0x01);
  const id = o.eventId ?? 5001;
  op.push((id >>> 24) & 255, (id >>> 16) & 255, (id >>> 8) & 255, id & 255);
  op.push(0x00, 0x01);
  const pr = o.preRollMs ?? 8000;
  op.push((pr >> 8) & 255, pr & 255);
  const dur = o.durTenths ?? 900;
  op.push((dur >> 8) & 255, dur & 255);
  op.push(o.availNum ?? 1, o.availsExpected ?? 1);
  op.push(o.autoReturn === false ? 0 : 1);

  const body = [0, 0, 1, 0x00, 0x01, 0, 0, 1, 0x01, 0x01, (op.length >> 8) & 255, op.length & 255, ...op];
  const size = 4 + body.length;
  return Buffer.from([0xff, 0xff, (size >> 8) & 255, size & 255, ...body]).toString("hex");
}

const codes = (hex: string) => analyzeScte104(parseScte104(hex)).map((f) => `${f.severity}:${f.code}`);

/* ------------------------------------------------------------ decoding */

test("a multiple operation message decodes to its operations", () => {
  const m = parseScte104(message());
  assert.equal(m.kind, "multiple");
  assert.equal(m.operations.length, 1);
  const op = m.operations[0];
  assert.equal(op.opName, "splice_request_data");
  const s = op.spliceRequest!;
  assert.equal(s.spliceInsertTypeName, "spliceStart_normal");
  assert.equal(s.spliceEventId, 5001);
  assert.equal(s.preRollMs, 8000);
  assert.equal(s.breakDurationSeconds, 90);
  assert.equal(s.autoReturn, true);
});

test("hex is accepted however it is pasted", () => {
  const plain = message();
  for (const form of [plain, "0x" + plain, plain.toUpperCase(), plain.replace(/(..)/g, "$1 ").trim()]) {
    assert.deepEqual([...decodeMessageBytes(form)], [...decodeMessageBytes(plain)]);
  }
  // Captures are often handed over as base64.
  assert.deepEqual(
    [...decodeMessageBytes(Buffer.from(plain, "hex").toString("base64"))],
    [...decodeMessageBytes(plain)],
  );
});

test("something too short to be a message is rejected rather than guessed at", () => {
  assert.throws(() => parseScte104("ffff"), /too short/);
});

/* --------------------------------------------------------------- rules */

test("a well-formed request with enough pre-roll raises nothing", () => {
  assert.deepEqual(codes(message()), []);
});

test("an immediate splice leaves the chain no warning at all", () => {
  assert.ok(codes(message({ type: 0x02 })).includes("warning:S104_IMMEDIATE_SPLICE"));
});

test("pre-roll under four seconds is the lead-time problem at its source", () => {
  assert.ok(codes(message({ preRollMs: 2000 })).includes("warning:S104_SHORT_PRE_ROLL"));
  assert.ok(!codes(message({ preRollMs: 8000 })).some((c) => c.includes("PRE_ROLL")));
  // A return does not need pre-roll in the same way, so it is not judged on it.
  assert.ok(!codes(message({ type: 0x03, preRollMs: 0 })).some((c) => c.includes("PRE_ROLL")));
});

test("a request with no duration cannot tell anyone how much to fill", () => {
  assert.ok(codes(message({ durTenths: 0 })).includes("warning:S104_NO_BREAK_DURATION"));
});

test("declining auto-return is noted, not condemned", () => {
  const c = codes(message({ autoReturn: false }));
  assert.ok(c.includes("info:S104_NO_AUTO_RETURN"));
  assert.ok(!c.some((x) => x.startsWith("error")));
});

test("avail numbering that cannot be right is reported", () => {
  assert.ok(codes(message({ availNum: 4, availsExpected: 2 })).includes("warning:S104_AVAIL_NUMBERING"));
});

/* ----------------------------------- against what the encoder emitted -- */

const asked = () => parseScte104(message());
const emitted = (o: { eventId?: number; duration?: number; outOfNetwork?: boolean } = {}) =>
  parseSpliceInfoSection(
    buildPayload({
      spliceInsert: {
        eventId: o.eventId ?? 5001,
        outOfNetwork: o.outOfNetwork ?? true,
        spliceTime: { ptsTime: 900000 },
        durationSeconds: o.duration ?? 90,
        autoReturn: true,
      },
    }).base64,
  );

test("a faithful transcription agrees on every field it can", () => {
  const c = compareScte104ToScte35(asked(), emitted());
  assert.deepEqual(c.findings.map((f) => f.code), []);
  assert.ok(c.checked.length >= 4);
  assert.ok(c.checked.every((k) => k.agrees), JSON.stringify(c.checked));
});

test("an event id that changes at the encoder breaks every reconciliation", () => {
  const c = compareScte104ToScte35(asked(), emitted({ eventId: 9999 }));
  assert.ok(c.findings.some((f) => f.code === "S104_EVENT_ID_CHANGED"));
  assert.ok(c.checked.some((k) => k.field === "event id" && !k.agrees));
});

test("a duration that changes means every break is the wrong length", () => {
  assert.ok(
    compareScte104ToScte35(asked(), emitted({ duration: 60 })).findings.some(
      (f) => f.code === "S104_DURATION_CHANGED",
    ),
  );
});

test("a break start emitted as a return is an error, not a nuance", () => {
  assert.ok(
    compareScte104ToScte35(asked(), emitted({ outOfNetwork: false })).findings.some(
      (f) => f.code === "S104_DIRECTION_CHANGED",
    ),
  );
});

test("splice_insert converted to time_signal is noted as deliberate", () => {
  // Many encoders are configured to do this, and it is not a fault — but the
  // two forms pair differently downstream, so it is worth seeing.
  const ts = parseSpliceInfoSection(
    buildPayload({
      timeSignal: { ptsTime: 900000 },
      descriptors: [{ eventId: 5001, typeId: 0x34, durationSeconds: 90 }],
    }).base64,
  );
  const c = compareScte104ToScte35(asked(), ts);
  const f = c.findings.find((x) => x.code === "S104_FORM_CHANGED");
  assert.ok(f);
  assert.equal(f!.severity, "info");
});

test("a splice requested and none emitted is the break that never happened", () => {
  const nothing = parseSpliceInfoSection(
    buildPayload({ spliceInsert: { eventId: 1, outOfNetwork: false, immediate: true } }).base64,
  );
  const c = compareScte104ToScte35(asked(), nothing);
  assert.ok(c.findings.some((f) => f.code === "S104_DIRECTION_CHANGED" || f.code === "S104_EVENT_ID_CHANGED"));
});
