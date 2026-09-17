/**
 * Ad-break reconstruction and validation.
 *
 * Takes parsed HLS playlists, pairs up the ad signalling into breaks,
 * decodes the SCTE-35 that rides along with them, and reports the
 * conditions that actually cause SSAI to mis-fire in the field.
 */

import type { HlsMarker, MediaPlaylist, Variant } from "./hls";
import {
  parseSpliceInfoSection,
  START_TYPES,
  END_TYPES,
  TYPE_PAIRS,
  type SegmentationDescriptor,
  type SpliceInfoSection,
} from "./scte35";

export type Severity = "error" | "warning" | "info";

export interface Finding {
  severity: Severity;
  code: string;
  title: string;
  detail: string;
  /** label of the rendition this applies to, omitted for cross-variant findings */
  rendition?: string;
  lineNumber?: number;
  breakIndex?: number;
  atTime?: number;
}

export interface DecodedSignal {
  payload: string;
  source: string;
  ok: boolean;
  error?: string;
  section?: SpliceInfoSection;
}

export interface AdBreak {
  index: number;
  /** DASH: the Period this break begins in */
  periodId?: string;
  /** media inside the avail — HLS segment URIs, or DASH media templates */
  mediaUris?: string[];
  /** seconds into the playlist window */
  startTime: number;
  pdt?: number;
  /** what the manifest/SCTE-35 says the break should be */
  signalledDuration?: number;
  signalledDurationSource?: string;
  /** what the segments actually add up to */
  actualDuration?: number;
  segmentCount: number;
  closed: boolean;
  inProgress: boolean;
  outLine: number;
  inLine?: number;
  outTag: string;
  discontinuityAtStart: boolean;
  discontinuityAtEnd: boolean;
  signal?: DecodedSignal;
  eventId?: number;
  upid?: string;
  upidType?: string;
  segmentationTypeId?: number;
  segmentationType?: string;
  spliceImmediate?: boolean;
  autoReturn?: boolean;
  outOfNetwork?: boolean;
  /** seconds between this break's start and the live edge at observation time */
  edgeDistance?: number;
  /** the playlist window begins inside this break, so its extent is unknown */
  windowClipped?: boolean;
  /** what establishes the end of this avail: an end event, or a declared duration */
  boundedBy?: string;
}

export interface PeriodSummary {
  id?: string;
  index: number;
  start: number;
  mediaStart: number;
  duration: number;
  isAd: boolean;
  segmentationType?: string;
  eventCount: number;
  adaptationSetCount: number;
  representationCount: number;
  /** spread between this period's adaptation-set durations, seconds */
  avSkew: number;
  /** gap (positive) or overlap (negative) to the next period, seconds */
  gapToNext?: number;
}

export interface RenditionAnalysis {
  label: string;
  uri: string;
  protocol: "hls" | "dash";
  /** media outside any avail, for comparison against what sits inside one */
  contentMediaUris?: string[];
  variant?: Variant;
  /** HLS only */
  playlist?: MediaPlaylist;
  /** DASH only */
  periods?: PeriodSummary[];
  breaks: AdBreak[];
  findings: Finding[];
  stats: {
    segmentCount: number;
    windowDuration: number;
    markerCount: number;
    breakCount: number;
    adSeconds: number;
    adPercent: number;
    hasPdt: boolean;
    live: boolean;
    lowLatency: boolean;
    /** wall-clock extent of the media in this window, epoch ms */
    windowStartPdt?: number;
    windowEndPdt?: number;
  };
}

export interface AnalysisResult {
  sourceUri: string;
  /** set when the analysis ran against a recorded bundle rather than the network */
  recorded?: { id: string; label: string; capturedAt: string; liveUrl?: string };
  fetchedAt: string;
  isMaster: boolean;
  renditions: RenditionAnalysis[];
  crossFindings: Finding[];
  summary: {
    errors: number;
    warnings: number;
    infos: number;
    breakCount: number;
    verdict: "pass" | "warn" | "fail";
  };
}

const EPS = 0.5; // seconds of slack before a timing difference is worth reporting

function fmt(n: number | undefined, digits = 3): string {
  return n === undefined ? "—" : n.toFixed(digits).replace(/\.?0+$/, "");
}

function decode(payload: string, source: string): DecodedSignal {
  try {
    return { payload, source, ok: true, section: parseSpliceInfoSection(payload) };
  } catch (e) {
    return { payload, source, ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

function segDescriptors(s: SpliceInfoSection): SegmentationDescriptor[] {
  return s.descriptors.filter((d): d is SegmentationDescriptor => d.tag === 0x02 && "typeId" in d);
}

type Polarity = "out" | "in" | "cont" | "unknown";

function polarityOf(m: HlsMarker, sig?: DecodedSignal): Polarity {
  if (m.kind === "CUE-OUT") return "out";
  if (m.kind === "CUE-IN") return "in";
  if (m.kind === "CUE-OUT-CONT") return "cont";
  if (m.kind === "DATERANGE") {
    if (m.attrs["SCTE35-OUT"]) return "out";
    if (m.attrs["SCTE35-IN"]) return "in";
  }
  const sec = sig?.section;
  if (sec) {
    const descs = segDescriptors(sec);
    if (descs.length) {
      if (descs.some((d) => START_TYPES.has(d.typeId))) return "out";
      if (descs.some((d) => END_TYPES.has(d.typeId))) return "in";
    }
    if (sec.spliceInsert && !sec.spliceInsert.cancel) {
      return sec.spliceInsert.outOfNetwork ? "out" : "in";
    }
  }
  return "unknown";
}

export function analyzeRendition(
  playlist: MediaPlaylist,
  label: string,
  variant?: Variant,
): RenditionAnalysis {
  const findings: Finding[] = [];
  const breaks: AdBreak[] = [];
  const add = (
    severity: Severity,
    code: string,
    title: string,
    detail: string,
    extra: Partial<Finding> = {},
  ) => findings.push({ severity, code, title, detail, rendition: label, ...extra });

  const live = !playlist.endList;
  const segs = playlist.segments;
  const hasPdt = segs.some((s) => s.pdtExplicit);
  // A stream carrying signalling but no discontinuities has not been stitched
  // yet: the SSAI service inserts those when it substitutes creatives.
  const hasAnyDiscontinuity = segs.some((s) => s.discontinuity);
  const liveEdgePdt = segs.length
    ? (segs[segs.length - 1].pdt ?? 0) + segs[segs.length - 1].duration * 1000
    : undefined;

  // ---- structural checks -------------------------------------------------
  if (playlist.targetDuration) {
    for (const s of segs) {
      if (s.duration > playlist.targetDuration + 0.001) {
        add(
          "error",
          "TARGETDURATION_EXCEEDED",
          "Segment longer than EXT-X-TARGETDURATION",
          `Segment ${s.index} (${s.uri}) is ${fmt(s.duration)}s but EXT-X-TARGETDURATION is ${playlist.targetDuration}s. RFC 8216 requires every EXTINF to round to no more than TARGETDURATION; players and CDNs use this value to size their buffers, and ad-inserted segments are a common source of this violation.`,
          { lineNumber: s.lineNumber, atTime: s.startTime },
        );
      }
    }
  }

  if (!hasPdt) {
    add(
      "warning",
      "NO_PROGRAM_DATE_TIME",
      "No EXT-X-PROGRAM-DATE-TIME in the playlist",
      "Without PDT there is no wall-clock reference, so ad decisioning, SCTE-35 correlation, and cross-rendition alignment all have to fall back to segment counting. Most SSAI vendors require PDT on every discontinuity at minimum.",
    );
  } else {
    // PDT continuity: compare explicit PDTs against the interpolated timeline.
    for (let i = 1; i < segs.length; i++) {
      const s = segs[i];
      const prev = segs[i - 1];
      if (!s.pdtExplicit || prev.pdt === undefined || s.pdt === undefined) continue;
      const expected = prev.pdt + prev.duration * 1000;
      const drift = (s.pdt - expected) / 1000;
      if (Math.abs(drift) > EPS) {
        add(
          s.discontinuity ? "info" : "warning",
          "PDT_DISCONTINUITY",
          `Program date-time jumps ${drift > 0 ? "forward" : "backward"} ${fmt(Math.abs(drift))}s`,
          `Segment ${s.index} declares a PDT that is ${fmt(Math.abs(drift))}s ${drift > 0 ? "ahead of" : "behind"} the value implied by the preceding segment durations.${s.discontinuity ? " This segment carries EXT-X-DISCONTINUITY, so a jump is expected here." : " There is no EXT-X-DISCONTINUITY at this point, so the timeline is internally inconsistent."}`,
          { lineNumber: s.lineNumber, atTime: s.startTime },
        );
      }
    }
  }

  // ---- decode every signal ----------------------------------------------
  const decoded = new Map<HlsMarker, DecodedSignal>();
  for (const m of playlist.markers) {
    if (!m.payload) continue;
    const sig = decode(m.payload, m.payloadSource ?? m.kind);
    decoded.set(m, sig);
    if (!sig.ok) {
      add(
        "error",
        "SCTE35_DECODE_FAILED",
        "SCTE-35 payload could not be decoded",
        `${m.payloadSource ?? m.kind} carries a payload that does not parse as a splice_info_section: ${sig.error}. Downstream ad servers will drop this signal entirely. Payload: ${m.payload.slice(0, 80)}${m.payload.length > 80 ? "…" : ""}`,
        { lineNumber: m.lineNumber, atTime: m.startTime },
      );
    } else if (!sig.section!.crcValid) {
      add(
        "warning",
        "SCTE35_CRC_INVALID",
        "SCTE-35 CRC-32 does not validate",
        `The section decodes, but its CRC-32 is wrong (0x${sig.section!.crc32.toString(16)}). Strict ad servers and SCTE-35 conformance checkers reject sections with a bad CRC, so this break may be silently ignored even though it looks correct in the manifest.`,
        { lineNumber: m.lineNumber, atTime: m.startTime },
      );
    } else if (sig.section!.encrypted) {
      add(
        "info",
        "SCTE35_ENCRYPTED",
        "SCTE-35 section is marked encrypted",
        `encrypted_packet is set with algorithm ${sig.section!.encryptionAlgorithm}. The command and descriptors cannot be validated without the key.`,
        { lineNumber: m.lineNumber, atTime: m.startTime },
      );
    }
  }

  // ---- DATERANGE hygiene -------------------------------------------------
  const drIds = new Map<string, HlsMarker[]>();
  for (const m of playlist.markers) {
    if (m.kind !== "DATERANGE" || !m.id) continue;
    const list = drIds.get(m.id) ?? [];
    list.push(m);
    drIds.set(m.id, list);
  }
  for (const [id, list] of drIds) {
    // One ID legitimately appears twice: once with SCTE35-OUT, once with SCTE35-IN.
    const outs = list.filter((m) => m.attrs["SCTE35-OUT"]).length;
    const ins = list.filter((m) => m.attrs["SCTE35-IN"]).length;
    if (outs > 1 || ins > 1 || (outs === 0 && ins === 0 && list.length > 1)) {
      add(
        "error",
        "DATERANGE_DUPLICATE_ID",
        `EXT-X-DATERANGE ID "${id}" is reused`,
        `This ID appears ${list.length} times (${outs} SCTE35-OUT, ${ins} SCTE35-IN). RFC 8216 requires DATERANGE IDs to be unique within a playlist; players deduplicate on ID and will drop the later occurrences, losing the break.`,
        { lineNumber: list[1].lineNumber },
      );
    }
  }

  // A DATERANGE announces its own start time. When that disagrees with the
  // position the tag actually occupies, downstream systems that schedule from
  // the attribute and players that schedule from the playlist position act on
  // different instants.
  for (const m of playlist.markers) {
    if (m.kind !== "DATERANGE" || m.pdt === undefined) continue;
    const declared = Date.parse(m.attrs["START-DATE"] ?? "");
    if (Number.isNaN(declared)) continue;
    const drift = (declared - m.pdt) / 1000;
    // A DATERANGE stays in the playlist until its whole range has rolled out,
    // so the oldest one ends up sitting in front of a later segment than the
    // one it originally preceded. Its START-DATE then reads as earlier than
    // its position by a margin that grows with every refresh. That is the
    // window sliding; only a tag that claims a time it does not occupy, or one
    // that is not at the window edge, is actually inconsistent.
    const trimmedByWindow = live && drift < 0 && m.segmentIndex === 0;
    if (Math.abs(drift) > EPS && !trimmedByWindow) {
      add(
        "warning",
        "DATERANGE_START_DATE_MISMATCH",
        `EXT-X-DATERANGE "${m.id ?? "?"}" declares a start ${fmt(Math.abs(drift))}s ${drift > 0 ? "after" : "before"} where it sits`,
        `START-DATE is ${m.attrs["START-DATE"]} but the tag precedes a segment whose program date-time is ${new Date(m.pdt).toISOString()}. Ad decisioning that schedules from START-DATE and players that schedule from the playlist position will disagree by ${fmt(Math.abs(drift))}s, so the break fires at two different instants depending on which system you ask.`,
        { lineNumber: m.lineNumber, atTime: m.startTime },
      );
    }
  }

  // ---- pair markers into breaks -----------------------------------------
  const ordered = [...playlist.markers].sort((a, b) => a.lineNumber - b.lineNumber);
  let open: { marker: HlsMarker; sig?: DecodedSignal } | null = null;
  let breakIndex = 0;

  const closeBreak = (inMarker: HlsMarker | null) => {
    if (!open) return;
    const outM = open.marker;
    const sig = open.sig;
    const sec = sig?.section;
    const startIdx = outM.segmentIndex;
    const endIdx = inMarker ? inMarker.segmentIndex : segs.length;
    const inside = segs.slice(startIdx, endIdx);
    const actual = inside.reduce((a, s) => a + s.duration, 0);
    // If the playlist window opens part-way through a break, its real extent
    // is off the front of the window and nothing about it can be measured.
    const clipped = live && startIdx === 0 && outM.startTime <= 0.001;

    // Signalled duration: prefer SCTE-35, fall back to the manifest attribute.
    let signalled: number | undefined;
    let signalledSource: string | undefined;
    const descs = sec ? segDescriptors(sec) : [];
    const startDesc = descs.find((d) => START_TYPES.has(d.typeId)) ?? descs[0];
    if (startDesc?.segmentationDurationSeconds !== undefined) {
      signalled = startDesc.segmentationDurationSeconds;
      signalledSource = "SCTE-35 segmentation_duration";
    } else if (sec?.spliceInsert?.breakDuration) {
      signalled = sec.spliceInsert.breakDuration.seconds;
      signalledSource = "SCTE-35 break_duration";
    } else if (outM.durationAttr !== undefined) {
      signalled = outM.durationAttr;
      signalledSource = outM.kind === "DATERANGE" ? "PLANNED-DURATION" : "EXT-X-CUE-OUT DURATION";
    }
    // If both exist and disagree, that is itself a finding.
    if (
      outM.durationAttr !== undefined &&
      signalledSource?.startsWith("SCTE-35") &&
      Math.abs(outM.durationAttr - signalled!) > EPS
    ) {
      add(
        "warning",
        "SIGNAL_DURATION_DISAGREEMENT",
        "Manifest duration disagrees with SCTE-35 duration",
        `The manifest advertises ${fmt(outM.durationAttr)}s but the SCTE-35 ${signalledSource.replace("SCTE-35 ", "")} says ${fmt(signalled)}s — a ${fmt(Math.abs(outM.durationAttr - signalled!))}s difference. Players honour the manifest value while server-side ad decisioning honours the SCTE-35 value, so the avail gets filled to one length and cut at another.`,
        { lineNumber: outM.lineNumber, breakIndex, atTime: outM.startTime },
      );
    }

    const inProgress = !inMarker && live;
    const b: AdBreak = {
      index: breakIndex,
      startTime: outM.startTime,
      pdt: outM.pdt,
      signalledDuration: signalled,
      signalledDurationSource: signalledSource,
      actualDuration: inMarker || !live ? actual : undefined,
      segmentCount: inside.length,
      closed: !!inMarker,
      inProgress,
      windowClipped: clipped,
      mediaUris: inside.map((x) => x.uri),
      outLine: outM.lineNumber,
      inLine: inMarker?.lineNumber,
      outTag: outM.raw,
      discontinuityAtStart: segs[startIdx]?.discontinuity ?? false,
      discontinuityAtEnd: inMarker ? (segs[endIdx]?.discontinuity ?? false) : false,
      signal: sig,
      spliceImmediate: sec?.spliceInsert?.spliceImmediate,
      autoReturn: sec?.spliceInsert?.breakDuration?.autoReturn,
      outOfNetwork: sec?.spliceInsert?.outOfNetwork,
      eventId: startDesc?.segmentationEventId ?? sec?.spliceInsert?.spliceEventId,
      upid: startDesc ? startDesc.upidText || startDesc.upidHex : undefined,
      upidType: startDesc?.upidTypeName,
      segmentationTypeId: startDesc?.typeId,
      segmentationType: startDesc?.typeName,
    };

    if (liveEdgePdt !== undefined && outM.pdt !== undefined && live) {
      b.edgeDistance = (liveEdgePdt - outM.pdt) / 1000;
    }

    // --- per-break rules -------------------------------------------------
    if (!inMarker) {
      if (live) {
        add(
          "info",
          "BREAK_IN_PROGRESS",
          `Break ${breakIndex} is still open at the live edge`,
          `The CUE-OUT at line ${outM.lineNumber} has no matching CUE-IN yet. On a live playlist this is normal if the break is currently on air; re-run in a few seconds and confirm it closes.`,
          { lineNumber: outM.lineNumber, breakIndex, atTime: outM.startTime },
        );
      } else {
        add(
          "error",
          "UNCLOSED_BREAK",
          `Break ${breakIndex} is never closed`,
          `The CUE-OUT at line ${outM.lineNumber} has no matching CUE-IN and the playlist has EXT-X-ENDLIST. Players that entered the avail will stay in ad mode to the end of the asset, and SSAI will keep substituting content past the intended return point.`,
          { lineNumber: outM.lineNumber, breakIndex, atTime: outM.startTime },
        );
      }
    } else if (signalled !== undefined && !clipped) {
      const delta = actual - signalled;
      const tolerance = Math.max(EPS, (playlist.targetDuration ?? 6) * 0.5);
      if (Math.abs(delta) > tolerance) {
        add(
          "warning",
          delta > 0 ? "BREAK_OVERRUN" : "BREAK_UNDERRUN",
          `Break ${breakIndex} ${delta > 0 ? "overruns" : "underruns"} its signalled duration by ${fmt(Math.abs(delta))}s`,
          `The break signals ${fmt(signalled)}s (${signalledSource}) but the segments between CUE-OUT and CUE-IN total ${fmt(actual)}s. ${
            delta > 0
              ? "The avail is longer than advertised, so the ad decision server under-fills it and the tail shows slate, black, or a frozen frame."
              : "The avail is shorter than advertised, so the last ad in the pod gets truncated and the return to content lands early."
          }`,
          { lineNumber: outM.lineNumber, breakIndex, atTime: outM.startTime },
        );
      }
    }

    if (hasAnyDiscontinuity && inMarker && !clipped && !b.discontinuityAtStart) {
      add(
        "warning",
        "NO_DISCONTINUITY_AT_BREAK_START",
        `Break ${breakIndex} starts without EXT-X-DISCONTINUITY`,
        `The first segment of the avail (segment ${startIdx}) has no EXT-X-DISCONTINUITY tag. Once an SSAI service swaps in ad segments with a different encode, timestamp base, or codec configuration, players without a discontinuity will glitch, stall, or drop audio at the splice.`,
        { lineNumber: outM.lineNumber, breakIndex, atTime: outM.startTime },
      );
    }
    if (hasAnyDiscontinuity && inMarker && endIdx < segs.length && !b.discontinuityAtEnd) {
      add(
        "warning",
        "NO_DISCONTINUITY_AT_BREAK_END",
        `Break ${breakIndex} returns to content without EXT-X-DISCONTINUITY`,
        `The segment following the CUE-IN (segment ${endIdx}) has no EXT-X-DISCONTINUITY tag, so the return from ads to programme is not marked. This is the more common of the two and shows up as a freeze on the first frame back from break.`,
        { lineNumber: inMarker.lineNumber, breakIndex, atTime: inMarker.startTime },
      );
    }

    if (sec?.spliceInsert?.spliceImmediate) {
      add(
        "info",
        "SPLICE_IMMEDIATE",
        `Break ${breakIndex} uses splice_immediate_flag`,
        "The splice_insert has no pre-roll time, so the ad decision server is told to switch now rather than at a known PTS. Fixed-latency ad systems cannot pre-fetch creatives against an immediate splice and will commonly return slate for the first few seconds.",
        { lineNumber: outM.lineNumber, breakIndex, atTime: outM.startTime },
      );
    }
    if (sec?.spliceInsert?.breakDuration && !sec.spliceInsert.breakDuration.autoReturn && !inMarker) {
      add(
        "warning",
        "NO_AUTO_RETURN_NO_CUE_IN",
        `Break ${breakIndex} relies on an explicit return that never arrives`,
        "break_duration has auto_return = 0, meaning the encoder promises an explicit return signal, but no CUE-IN or SCTE35-IN follows. Receivers that honour auto_return semantics will not come back from the avail on their own.",
        { lineNumber: outM.lineNumber, breakIndex, atTime: outM.startTime },
      );
    }
    if (sec) {
      const starts = descs.filter((d) => START_TYPES.has(d.typeId));
      for (const d of starts) {
        const want = TYPE_PAIRS[d.typeId];
        if (want === undefined) continue;
        const closed = ordered.some((m2) => {
          const s2 = decoded.get(m2)?.section;
          if (!s2 || m2.lineNumber <= outM.lineNumber) return false;
          return segDescriptors(s2).some(
            (d2) => d2.typeId === want && d2.segmentationEventId === d.segmentationEventId,
          );
        });
        if (!closed && !live) {
          add(
            "warning",
            "UNPAIRED_SEGMENTATION_TYPE",
            `"${d.typeName}" has no matching end descriptor`,
            `Segmentation event ${d.segmentationEventId} opens with type 0x${d.typeId.toString(16)} (${d.typeName}) but no 0x${want.toString(16)} descriptor closes it. Systems that track avails by segmentation event — most national ad platforms do — will leave this avail open.`,
            { lineNumber: outM.lineNumber, breakIndex, atTime: outM.startTime },
          );
        }
      }
    }

    breaks.push(b);
    breakIndex++;
    open = null;
  };

  // Vendors routinely emit more than one tag for the same splice point — an
  // EXT-X-DATERANGE carrying the SCTE-35 alongside an EXT-X-CUE-OUT carrying
  // the duration is the most common pairing. Group markers by the segment they
  // precede so that one splice point yields one break.
  const points: { segmentIndex: number; markers: HlsMarker[] }[] = [];
  for (const m of ordered) {
    const last = points[points.length - 1];
    if (last && last.segmentIndex === m.segmentIndex) last.markers.push(m);
    else points.push({ segmentIndex: m.segmentIndex, markers: [m] });
  }

  let dualSignalled = false;
  let sawOut = false;

  for (const p of points) {
    const outs = p.markers.filter((m) => polarityOf(m, decoded.get(m)) === "out");
    const ins = p.markers.filter((m) => polarityOf(m, decoded.get(m)) === "in");

    // Close before opening: a return and an immediately following departure
    // legitimately share one splice point.
    if (ins.length) {
      const inM = ins[0];
      if (!open) {
        // A live window that happens to begin part-way through a break starts
        // with a return whose departure has already aged out. That is the
        // window sliding, not a lost signal — and reporting it as an error
        // makes a healthy stream alternate between pass and fail forever.
        const leading = !sawOut;
        add(
          live && leading ? "info" : "error",
          "ORPHAN_CUE_IN",
          live && leading
            ? "Window opens part-way through a break"
            : "Return-from-break with no matching break start",
          live && leading
            ? `The playlist begins inside an avail: the return at line ${inM.lineNumber} closes a break whose CUE-OUT has already rolled out of the DVR window. Expected on a sliding live window.`
            : `The signal at line ${inM.lineNumber} closes an avail that was never opened, and it follows a break that did pair correctly — so this is not the window boundary. The break start was lost somewhere between the encoder and the packager.`,
          { lineNumber: inM.lineNumber, atTime: inM.startTime },
        );
      } else {
        closeBreak(inM);
      }
    }

    if (outs.length) {
      if (outs.length > 1) dualSignalled = true;
      // Decode from whichever tag actually carries SCTE-35, but take the
      // duration from whichever tag states one.
      const primary =
        outs.find((m) => decoded.get(m)?.ok) ?? outs.find((m) => m.payload) ?? outs[0];
      const durM = outs.find((m) => m.durationAttr !== undefined);
      const merged: HlsMarker = {
        ...primary,
        durationAttr: primary.durationAttr ?? durM?.durationAttr,
        raw: outs.map((m) => m.raw).join("\n"),
      };
      if (open) {
        // If the still-open break is one the window opened inside of, its
        // return simply is not in this playlist yet — the next departure is
        // not nested, it is the next break.
        const previousWasClipped =
          live && open.marker.segmentIndex === 0 && open.marker.startTime <= 0.001;
        add(
          previousWasClipped ? "info" : "error",
          "NESTED_CUE_OUT",
          previousWasClipped
            ? "A break was already in progress when the window opened"
            : "A new break starts before the previous one ended",
          previousWasClipped
            ? `The avail at line ${merged.lineNumber} follows one that was already running when this window began, so no return for it appears here. Expected on a sliding live window.`
            : `The signal at line ${merged.lineNumber} opens an avail while the break opened at line ${open.marker.lineNumber} is still open. Nested avails are not valid; most players take the first and ignore the second, and SSAI state machines commonly wedge here.`,
          { lineNumber: merged.lineNumber, atTime: merged.startTime },
        );
        closeBreak(null);
      }
      sawOut = true;
      open = { marker: merged, sig: decoded.get(primary) };
    }
  }
  if (open) closeBreak(null);

  if (!hasAnyDiscontinuity && breaks.length > 0) {
    add(
      "info",
      "SIGNALLING_ONLY_STREAM",
      "Ad signalling is present but nothing has been stitched yet",
      "No EXT-X-DISCONTINUITY appears anywhere in this playlist, so no content has been substituted — this is a signalling-only feed upstream of ad insertion. Inserting a discontinuity at each splice point is the downstream SSAI service's job; run this same check against the stitched output to confirm it actually does, because a missing discontinuity there is what produces freezes at the return from break.",
    );
  }

  if (dualSignalled) {
    const kinds = [...new Set(playlist.markers.map((m) => m.kind))].join(", ");
    add(
      "info",
      "DUAL_SIGNALLING",
      "Breaks are signalled with more than one tag at the same point",
      `This playlist carries ${kinds}. Emitting both a DATERANGE and a CUE-OUT for the same splice point is normal and gives the widest player compatibility — it is noted here so the break count is not misread, and because the two tags must agree on duration.`,
    );
  }

  // ---- reused event IDs --------------------------------------------------
  const byEvent = new Map<number, AdBreak[]>();
  for (const b of breaks) {
    if (b.eventId === undefined) continue;
    const l = byEvent.get(b.eventId) ?? [];
    l.push(b);
    byEvent.set(b.eventId, l);
  }
  for (const [id, list] of byEvent) {
    if (list.length > 1) {
      add(
        "warning",
        "EVENT_ID_REUSED",
        `Splice event ID ${id} is used by ${list.length} different breaks`,
        "Ad platforms deduplicate avails on segmentation_event_id / splice_event_id. Reusing an ID across separate breaks in the same window causes the later breaks to be discarded as duplicates, or the reporting for them to be merged.",
        { breakIndex: list[1].index, atTime: list[1].startTime },
      );
    }
  }

  const adSeconds = breaks.reduce((a, b) => a + (b.actualDuration ?? b.signalledDuration ?? 0), 0);

  const inAvail = new Set(breaks.flatMap((b) => b.mediaUris ?? []));
  return {
    label,
    uri: playlist.uri,
    protocol: "hls",
    contentMediaUris: segs.map((x) => x.uri).filter((u) => !inAvail.has(u)),
    variant,
    playlist,
    breaks,
    findings,
    stats: {
      segmentCount: segs.length,
      windowDuration: playlist.totalDuration,
      markerCount: playlist.markers.length,
      breakCount: breaks.length,
      adSeconds,
      adPercent: playlist.totalDuration > 0 ? (adSeconds / playlist.totalDuration) * 100 : 0,
      hasPdt,
      live,
      lowLatency: playlist.lowLatency,
      windowStartPdt: segs[0]?.pdt,
      windowEndPdt:
        segs.length && segs[segs.length - 1].pdt !== undefined
          ? segs[segs.length - 1].pdt! + segs[segs.length - 1].duration * 1000
          : undefined,
    },
  };
}

/**
 * Compare breaks across renditions. Markers that are present in the video
 * variants but missing (or shifted) in one rendition are the single most
 * common cause of "the ad played on some devices but not others".
 */
export function analyzeCrossVariant(rends: RenditionAnalysis[]): Finding[] {
  const findings: Finding[] = [];
  if (rends.length < 2) return findings;

  // Renditions rarely expose exactly the same DVR window, and a live window
  // shifts between the requests. Compare only the wall-clock range every
  // rendition actually covers — otherwise a break that has simply rolled out
  // of one window reads as a missing break.
  const windows = rends.map((r) => {
    const segs = r.playlist?.segments ?? [];
    const last = segs[segs.length - 1];
    return {
      start: segs[0]?.pdt,
      end: last?.pdt !== undefined ? last.pdt + last.duration * 1000 : undefined,
    };
  });
  const haveWindows = windows.every((w) => w.start !== undefined && w.end !== undefined);
  const overlapStart = haveWindows ? Math.max(...windows.map((w) => w.start!)) : 0;
  const overlapEnd = haveWindows ? Math.min(...windows.map((w) => w.end!)) : 0;

  if (haveWindows && overlapEnd <= overlapStart) {
    findings.push({
      severity: "warning",
      code: "NO_COMMON_WINDOW",
      title: "Renditions do not share a common time window",
      detail:
        "The playlists returned for each rendition cover non-overlapping wall-clock ranges, so their ad signalling cannot be compared. This usually means the renditions are served from different origins or caches that are badly out of sync.",
    });
    return findings;
  }

  // Renditions roll independently, so near the start of the shared window one
  // rendition may already have trimmed a break's CUE-OUT while another still
  // carries it. That break then exists in one and not the other for reasons
  // that are not a signalling fault. Hold back from the boundary by a couple of
  // target durations; a genuinely missing break is still caught on the next
  // poll, once it has moved away from the edge.
  const targetDurations = rends
    .map((r) => r.playlist?.targetDuration)
    .filter((t): t is number => t !== undefined);
  const grace = Math.max(10_000, (targetDurations.length ? Math.max(...targetDurations) : 6) * 2000);
  const inOverlap = (b: AdBreak) => {
    if (!haveWindows || b.pdt === undefined) return true;
    // The same reasoning applies at the live edge. Audio segments are shorter
    // than video ones and reach a return sooner, so the newest break is
    // routinely closed in an audio rendition while still open in the video
    // ones — which changes the comparable count without any signalling being
    // wrong. Hold back from both boundaries.
    const extent = (b.actualDuration ?? b.signalledDuration ?? 0) * 1000;
    return b.pdt >= overlapStart + grace && b.pdt + extent <= overlapEnd - grace;
  };

  // Only breaks that are wholly inside the shared window can be compared: one
  // clipped by the start of a rendition's DVR window, or still open at the live
  // edge, differs between renditions for reasons that are not defects.
  const comparable = (b: AdBreak) => inOverlap(b) && b.closed && !b.windowClipped;
  const view = rends.map((r) => ({ label: r.label, breaks: r.breaks.filter(comparable) }));
  const ref = view[0];

  const counts = new Set(view.map((r) => r.breaks.length));
  if (counts.size > 1) {
    findings.push({
      severity: "error",
      code: "VARIANT_BREAK_COUNT_MISMATCH",
      title: "Renditions do not carry the same number of ad breaks",
      detail: `Over the ${Math.round((overlapEnd - overlapStart) / 1000)}s window common to every rendition, the break counts are — ${view
        .map((r) => `${r.label}: ${r.breaks.length}`)
        .join(", ")}. Every rendition of a stream must carry identical ad signalling; when they differ, playback depends on which variant the player happened to select, which is why these present as "it only fails on some devices" or "only on cellular".`,
    });
  }

  const key = (b: AdBreak) => (b.pdt !== undefined ? b.pdt / 1000 : b.startTime);
  const useWallClock = ref.breaks.every((b) => b.pdt !== undefined);

  for (const b of ref.breaks) {
    const t = key(b);
    for (const other of view.slice(1)) {
      const candidates = other.breaks
        .map((ob) => ({ ob, d: Math.abs(key(ob) - t) }))
        .sort((x, y) => x.d - y.d);
      const best = candidates[0];
      if (!best || best.d > 3) {
        findings.push({
          severity: "error",
          code: "VARIANT_MISSING_BREAK",
          title: `Break ${b.index} is missing from ${other.label}`,
          detail: `${ref.label} signals a break at ${
            useWallClock && b.pdt ? new Date(b.pdt).toISOString() : fmt(b.startTime) + "s"
          } but ${other.label} has no break within 3s of that point, inside the window both renditions cover. A player on this rendition plays straight through the avail — the ad is not delivered, and it will not appear in impression reporting either.`,
          breakIndex: b.index,
          atTime: b.startTime,
        });
        continue;
      }
      if (best.d > EPS) {
        findings.push({
          severity: "error",
          code: "VARIANT_BREAK_MISALIGNED",
          title: `Break ${b.index} is ${fmt(best.d)}s out of alignment in ${other.label}`,
          detail: `The break starts at a different point in ${other.label} than in ${ref.label} (${fmt(
            best.d,
          )}s apart). Renditions must splice at identical points or players cut mid-ad when they switch bitrate — which is exactly when this surfaces, during the bandwidth changes that happen at the start of a break.`,
          breakIndex: b.index,
          atTime: b.startTime,
        });
      }
      const rd = b.actualDuration ?? b.signalledDuration;
      const od = best.ob.actualDuration ?? best.ob.signalledDuration;
      if (rd !== undefined && od !== undefined && Math.abs(rd - od) > EPS) {
        findings.push({
          severity: "warning",
          code: "VARIANT_DURATION_MISMATCH",
          title: `Break ${b.index} has a different duration in ${other.label}`,
          detail: `${ref.label} runs ${fmt(rd)}s, ${other.label} runs ${fmt(
            od,
          )}s. Differing avail lengths across renditions desynchronise audio and video at the return from break and corrupt ad-completion reporting.`,
          breakIndex: b.index,
          atTime: b.startTime,
        });
      }
    }
  }

  // Signalling style should be consistent across renditions too.
  const styles = new Map<string, string[]>();
  for (const r of rends) {
    const kinds = [...new Set((r.playlist?.markers ?? []).map((m) => m.kind))].sort().join("+") || "none";
    const l = styles.get(kinds) ?? [];
    l.push(r.label);
    styles.set(kinds, l);
  }
  if (styles.size > 1) {
    findings.push({
      severity: "warning",
      code: "VARIANT_SIGNALLING_STYLE_MISMATCH",
      title: "Renditions use different ad-signalling tags",
      detail:
        [...styles.entries()].map(([k, v]) => `${v.join(", ")} use ${k}`).join("; ") +
        ". Mixed conventions across renditions usually mean two different packaging paths or versions are feeding the same stream, and downstream systems will interpret them inconsistently.",
    });
  }

  return findings;
}

export function summarize(
  sourceUri: string,
  isMasterPlaylist: boolean,
  renditions: RenditionAnalysis[],
  crossFindings: Finding[],
): AnalysisResult {
  const all = [...renditions.flatMap((r) => r.findings), ...crossFindings];
  const errors = all.filter((f) => f.severity === "error").length;
  const warnings = all.filter((f) => f.severity === "warning").length;
  const infos = all.filter((f) => f.severity === "info").length;
  return {
    sourceUri,
    fetchedAt: new Date().toISOString(),
    isMaster: isMasterPlaylist,
    renditions,
    crossFindings,
    summary: {
      errors,
      warnings,
      infos,
      breakCount: renditions[0]?.breaks.length ?? 0,
      verdict: errors > 0 ? "fail" : warnings > 0 ? "warn" : "pass",
    },
  };
}
