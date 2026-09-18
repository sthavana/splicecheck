/**
 * The encoder stage: a channel timeline and the SCTE-35 it emits.
 *
 * Everything downstream is a transcription of this. The timeline is the only
 * place that knows where an avail really is; the packager, the origin and the
 * SSAI service each get a chance to describe it differently, which is where
 * the interesting failures come from.
 */

import { buildPayload, PTS_MODULUS, TICKS_PER_SECOND } from "./scte35Encode";

export interface AvailSpec {
  id: number;
  /** Seconds into the programme. */
  startSec: number;
  durationSec: number;
}

export type SignalStyle = "splice_insert" | "time_signal";

export interface ChannelSpec {
  name: string;
  /** Target segment duration. Real packagers only hit this on GOP boundaries. */
  segmentSeconds: number;
  /** Wall-clock of media time zero, for EXT-X-PROGRAM-DATE-TIME. */
  startEpochMs: number;
  /** The encoder's PTS base. Non-zero bases are the normal case, not the exception. */
  ptsBaseSeconds: number;
  /** How long a programme this channel models. */
  durationSec: number;
  avails: AvailSpec[];
  signalStyle: SignalStyle;
}

export interface TimelineSegment {
  index: number;
  startSec: number;
  durationSec: number;
  /** Which avail this segment falls inside, if any. */
  availId?: number;
  /** True on the first segment of an avail and the first segment after it. */
  splicePoint: boolean;
  pdtMs: number;
  uri: string;
}

export interface EncoderSignal {
  availId: number;
  kind: "out" | "in";
  /** Seconds into the programme. */
  mediaSec: number;
  /** 90kHz ticks, including the channel's PTS base. */
  pts: number;
  command: SignalStyle;
  /** Set on an out signal. */
  durationSec?: number;
  base64: string;
  hex: string;
  /** True when the section was deliberately corrupted, to model an encoder fault. */
  corrupted?: boolean;
}

export interface Timeline {
  spec: ChannelSpec;
  segments: TimelineSegment[];
  signals: EncoderSignal[];
  /** Avails as the timeline actually realised them, after boundary snapping. */
  avails: (AvailSpec & { snappedStartSec: number; snappedDurationSec: number })[];
}

export interface TimelineFaults {
  /**
   * Place the avail where the schedule asked rather than on a segment
   * boundary. A packager cannot split a segment, so the break it writes will
   * not be where the encoder signalled it.
   */
  availOffBoundary?: boolean;
  /** Corrupt the CRC of every out signal, as a failing encoder would. */
  invalidCrc?: boolean;
}

/** Segment index containing a given media time. */
function segmentIndexAt(sec: number, segmentSeconds: number): number {
  return Math.floor(sec / segmentSeconds);
}

/**
 * Builds the programme timeline and the signalling that describes it.
 *
 * Avails snap to segment boundaries by default because that is what a packager
 * can actually represent: a break has to begin where a segment begins. The
 * off-boundary fault keeps the requested time instead, so the difference
 * between what was signalled and what can be delivered becomes visible.
 */
export function buildTimeline(spec: ChannelSpec, faults: TimelineFaults = {}): Timeline {
  const { segmentSeconds, durationSec } = spec;
  const count = Math.ceil(durationSec / segmentSeconds);

  const avails = spec.avails.map((a0) => {
    // The fault is that the schedule asks for a splice mid-segment. Shifting by
    // half a segment guarantees that, whatever times the caller configured.
    const a = faults.availOffBoundary
      ? { ...a0, startSec: a0.startSec + segmentSeconds / 2 }
      : a0;
    if (faults.availOffBoundary) {
      // The packager still has to begin the break on a segment boundary, so the
      // realised break and the signalled instant are half a segment apart.
      const startIdx = Math.floor(a.startSec / segmentSeconds);
      const segs = Math.max(1, Math.round(a.durationSec / segmentSeconds));
      return {
        ...a,
        snappedStartSec: startIdx * segmentSeconds,
        snappedDurationSec: segs * segmentSeconds,
      };
    }
    const startIdx = Math.round(a.startSec / segmentSeconds);
    const segs = Math.max(1, Math.round(a.durationSec / segmentSeconds));
    return {
      ...a,
      snappedStartSec: startIdx * segmentSeconds,
      snappedDurationSec: segs * segmentSeconds,
    };
  });

  const segments: TimelineSegment[] = [];
  for (let i = 0; i < count; i++) {
    const startSec = i * segmentSeconds;
    const durationSecs = Math.min(segmentSeconds, durationSec - startSec);
    const inAvail = avails.find(
      (a) => startSec >= a.snappedStartSec && startSec < a.snappedStartSec + a.snappedDurationSec,
    );
    const isFirstOfAvail = avails.some((a) => segmentIndexAt(a.snappedStartSec, segmentSeconds) === i);
    const isFirstAfterAvail = avails.some(
      (a) => segmentIndexAt(a.snappedStartSec + a.snappedDurationSec, segmentSeconds) === i,
    );
    segments.push({
      index: i,
      startSec,
      durationSec: durationSecs,
      availId: inAvail?.id,
      splicePoint: isFirstOfAvail || isFirstAfterAvail,
      pdtMs: spec.startEpochMs + startSec * 1000,
      // Programme content inside an avail is still programme content. Naming
      // it differently would leak the timeline's knowledge into the manifest
      // and make a pass-through look like a real substitution downstream.
      uri: `content_${String(i).padStart(5, "0")}.ts`,
    });
  }

  const signals: EncoderSignal[] = [];
  for (const a of avails) {
    const ptsAt = (sec: number) =>
      Math.round((spec.ptsBaseSeconds + sec) * TICKS_PER_SECOND) % PTS_MODULUS;

    // The encoder signals the scheduled time, not the snapped one. When the two
    // differ, that difference is the fault being modelled.
    const outSec = a.startSec;
    const inSec = a.startSec + a.durationSec;

    const out = buildOut(a, outSec, ptsAt(outSec), spec.signalStyle);
    const inn = buildIn(a, inSec, ptsAt(inSec), spec.signalStyle);

    if (faults.invalidCrc) {
      out.bytes[out.bytes.length - 1] ^= 0xff;
      out.base64 = Buffer.from(out.bytes).toString("base64");
      out.hex = "0x" + Array.from(out.bytes, (b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
      out.corrupted = true;
    }

    signals.push(stripBytes(out), stripBytes(inn));
  }

  return { spec, segments, signals, avails };
}

type SignalWithBytes = EncoderSignal & { bytes: Uint8Array };

function stripBytes(s: SignalWithBytes): EncoderSignal {
  const { bytes: _bytes, ...rest } = s;
  void _bytes;
  return rest;
}

function buildOut(a: AvailSpec, mediaSec: number, pts: number, style: SignalStyle): SignalWithBytes {
  const p =
    style === "splice_insert"
      ? buildPayload({
          spliceInsert: {
            eventId: a.id,
            outOfNetwork: true,
            spliceTime: { ptsTime: pts },
            durationSeconds: a.durationSec,
            autoReturn: false,
            uniqueProgramId: 1,
            availNum: 1,
            availsExpected: 1,
          },
        })
      : buildPayload({
          timeSignal: { ptsTime: pts },
          descriptors: [
            {
              eventId: a.id,
              typeId: 0x34, // Provider Placement Opportunity Start
              durationSeconds: a.durationSec,
              upidType: 0x0c,
              upid: `ADSP${JSON.stringify({ avail: a.id })}`,
              segmentNum: 1,
              segmentsExpected: 1,
            },
          ],
        });
  return {
    availId: a.id, kind: "out", mediaSec, pts, command: style,
    durationSec: a.durationSec, base64: p.base64, hex: p.hex, bytes: p.bytes,
  };
}

function buildIn(a: AvailSpec, mediaSec: number, pts: number, style: SignalStyle): SignalWithBytes {
  const p =
    style === "splice_insert"
      ? buildPayload({
          spliceInsert: {
            eventId: a.id + 1,
            outOfNetwork: false,
            spliceTime: { ptsTime: pts },
            uniqueProgramId: 1,
            availNum: 1,
            availsExpected: 1,
          },
        })
      : buildPayload({
          timeSignal: { ptsTime: pts },
          descriptors: [
            {
              eventId: a.id,
              typeId: 0x35, // Provider Placement Opportunity End
              upidType: 0x0c,
              upid: `ADSP${JSON.stringify({ avail: a.id })}`,
              segmentNum: 1,
              segmentsExpected: 1,
            },
          ],
        });
  return {
    availId: a.id, kind: "in", mediaSec, pts, command: style,
    base64: p.base64, hex: p.hex, bytes: p.bytes,
  };
}
