/**
 * HLS playlist parsing focused on ad-signalling tags.
 * Handles master playlists, media playlists, and the several competing
 * conventions vendors use to carry SCTE-35 in HLS.
 */

export type MarkerKind =
  | "CUE-OUT"
  | "CUE-OUT-CONT"
  | "CUE-IN"
  | "DATERANGE"
  | "SCTE35"
  | "OATCLS-SCTE35"
  | "ASSET"
  | "SPLICEPOINT"
  | "INTERSTITIAL";

export interface HlsSegment {
  index: number;
  uri: string;
  duration: number;
  /** seconds from the first segment in this playlist */
  startTime: number;
  /** epoch ms, from EXT-X-PROGRAM-DATE-TIME (interpolated where absent) */
  pdt?: number;
  pdtExplicit: boolean;
  discontinuity: boolean;
  mediaSequence: number;
  lineNumber: number;
}

export interface HlsMarker {
  kind: MarkerKind;
  raw: string;
  lineNumber: number;
  /** index of the segment this marker precedes */
  segmentIndex: number;
  startTime: number;
  pdt?: number;
  /** DURATION / PLANNED-DURATION attribute, seconds */
  durationAttr?: number;
  elapsed?: number;
  id?: string;
  /** raw SCTE-35 payload (base64 or 0x-hex) if the tag carried one */
  payload?: string;
  payloadSource?: string;
  attrs: Record<string, string>;
}

/** One EXT-X-PART: a fragment published before its parent segment is complete. */
export interface HlsPart {
  uri: string;
  duration: number;
  /** Starts with an independent frame, so a player can join on it. */
  independent: boolean;
  /** Media sequence of the segment this part belongs to. */
  segmentMsn: number;
  index: number;
  gap: boolean;
  lineNumber: number;
}

/**
 * EXT-X-SERVER-CONTROL. The contract between playlist and client about how
 * close to live a player may sit and how it should ask for updates.
 */
export interface ServerControl {
  canBlockReload: boolean;
  /** Seconds a player must stay behind the live edge when playing parts. */
  partHoldBack?: number;
  /** The same, for a player playing whole segments. */
  holdBack?: number;
  /** Playlist delta updates are offered from this far back. */
  canSkipUntil?: number;
  /** Whether a delta update keeps EXT-X-DATERANGE tags. */
  canSkipDateRanges: boolean;
}

export interface MediaPlaylist {
  type: "media";
  uri: string;
  version?: number;
  targetDuration?: number;
  mediaSequence: number;
  discontinuitySequence: number;
  endList: boolean;
  playlistType?: string;
  partTargetDuration?: number;
  lowLatency: boolean;
  parts: HlsPart[];
  serverControl?: ServerControl;
  /** EXT-X-PRELOAD-HINT for the part not yet published. */
  preloadHint?: { type: string; uri: string };
  /** EXT-X-RENDITION-REPORT, so a switching player need not start over. */
  renditionReports: { uri: string; lastMsn?: number; lastPart?: number }[];
  /** EXT-X-SKIP: this is a delta update with segments omitted. */
  skippedSegments?: number;
  segments: HlsSegment[];
  markers: HlsMarker[];
  totalDuration: number;
  lines: string[];
}

export interface Variant {
  uri: string;
  resolvedUri: string;
  bandwidth?: number;
  averageBandwidth?: number;
  resolution?: string;
  codecs?: string;
  frameRate?: string;
  audioGroup?: string;
  name?: string;
  /** set for EXT-X-MEDIA renditions */
  mediaType?: string;
  language?: string;
}

export interface MasterPlaylist {
  type: "master";
  uri: string;
  variants: Variant[];
  lines: string[];
}

export type Playlist = MediaPlaylist | MasterPlaylist;

export function parseAttributes(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([A-Za-z0-9\-_]+)\s*=\s*("[^"]*"|[^,]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    out[m[1].toUpperCase()] = m[2].trim().replace(/^"|"$/g, "");
  }
  return out;
}

export function isMaster(text: string): boolean {
  return /^#EXT-X-STREAM-INF/m.test(text);
}

export function resolveUri(base: string, ref: string): string {
  try {
    return new URL(ref, base).toString();
  } catch {
    return ref;
  }
}

export function parseMaster(text: string, uri: string): MasterPlaylist {
  const lines = text.split(/\r?\n/);
  const variants: Variant[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith("#EXT-X-STREAM-INF:")) {
      const attrs = parseAttributes(line.slice("#EXT-X-STREAM-INF:".length));
      // The URI is the next non-comment, non-empty line.
      let j = i + 1;
      while (j < lines.length && (lines[j].trim() === "" || lines[j].trim().startsWith("#"))) j++;
      const vUri = lines[j]?.trim() ?? "";
      variants.push({
        uri: vUri,
        resolvedUri: resolveUri(uri, vUri),
        bandwidth: attrs.BANDWIDTH ? Number(attrs.BANDWIDTH) : undefined,
        averageBandwidth: attrs["AVERAGE-BANDWIDTH"] ? Number(attrs["AVERAGE-BANDWIDTH"]) : undefined,
        resolution: attrs.RESOLUTION,
        codecs: attrs.CODECS,
        frameRate: attrs["FRAME-RATE"],
        audioGroup: attrs.AUDIO,
      });
    } else if (line.startsWith("#EXT-X-MEDIA:")) {
      const attrs = parseAttributes(line.slice("#EXT-X-MEDIA:".length));
      if (attrs.URI) {
        variants.push({
          uri: attrs.URI,
          resolvedUri: resolveUri(uri, attrs.URI),
          mediaType: attrs.TYPE,
          name: attrs.NAME,
          language: attrs.LANGUAGE,
        });
      }
    }
  }
  return { type: "master", uri, variants, lines };
}

export function parseMedia(text: string, uri: string): MediaPlaylist {
  const lines = text.split(/\r?\n/);
  const segments: HlsSegment[] = [];
  const markers: HlsMarker[] = [];

  let mediaSequence = 0;
  let discontinuitySequence = 0;
  let targetDuration: number | undefined;
  let partTargetDuration: number | undefined;
  const parts: HlsPart[] = [];
  const renditionReports: { uri: string; lastMsn?: number; lastPart?: number }[] = [];
  let serverControl: ServerControl | undefined;
  let preloadHint: { type: string; uri: string } | undefined;
  let skippedSegments: number | undefined;
  let partIndex = 0;
  let version: number | undefined;
  let playlistType: string | undefined;
  let endList = false;
  let lowLatency = false;

  let pendingDuration: number | undefined;
  let pendingDiscontinuity = false;
  let pendingPdt: number | undefined;
  let pendingMarkers: HlsMarker[] = [];
  let cumulative = 0;
  let nextPdt: number | undefined;
  let segIndex = 0;

  const pushMarker = (
    kind: MarkerKind,
    raw: string,
    lineNumber: number,
    attrs: Record<string, string>,
    extra: Partial<HlsMarker> = {},
  ) => {
    pendingMarkers.push({
      kind,
      raw,
      lineNumber,
      segmentIndex: segIndex,
      startTime: cumulative,
      attrs,
      ...extra,
    });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === "") continue;
    const ln = i + 1;

    if (!line.startsWith("#")) {
      // Segment URI: closes the pending segment.
      const pdt = pendingPdt ?? nextPdt;
      const seg: HlsSegment = {
        index: segIndex,
        uri: line,
        duration: pendingDuration ?? 0,
        startTime: cumulative,
        pdt,
        pdtExplicit: pendingPdt !== undefined,
        discontinuity: pendingDiscontinuity,
        mediaSequence: mediaSequence + segIndex,
        lineNumber: ln,
      };
      segments.push(seg);
      for (const m of pendingMarkers) {
        m.segmentIndex = segIndex;
        m.startTime = cumulative;
        m.pdt = pdt;
        markers.push(m);
      }
      pendingMarkers = [];
      cumulative += seg.duration;
      nextPdt = pdt !== undefined ? pdt + seg.duration * 1000 : undefined;
      pendingDuration = undefined;
      pendingDiscontinuity = false;
      pendingPdt = undefined;
      segIndex++;
      continue;
    }

    if (line.startsWith("#EXTINF:")) {
      pendingDuration = parseFloat(line.slice(8).split(",")[0]);
    } else if (line.startsWith("#EXT-X-MEDIA-SEQUENCE:")) {
      mediaSequence = Number(line.split(":")[1]);
    } else if (line.startsWith("#EXT-X-DISCONTINUITY-SEQUENCE:")) {
      discontinuitySequence = Number(line.split(":")[1]);
    } else if (line.startsWith("#EXT-X-TARGETDURATION:")) {
      targetDuration = Number(line.split(":")[1]);
    } else if (line.startsWith("#EXT-X-VERSION:")) {
      version = Number(line.split(":")[1]);
    } else if (line.startsWith("#EXT-X-PLAYLIST-TYPE:")) {
      playlistType = line.split(":")[1];
    } else if (line === "#EXT-X-ENDLIST") {
      endList = true;
    } else if (line === "#EXT-X-DISCONTINUITY") {
      pendingDiscontinuity = true;
    } else if (line.startsWith("#EXT-X-PROGRAM-DATE-TIME:")) {
      const t = Date.parse(line.slice("#EXT-X-PROGRAM-DATE-TIME:".length).trim());
      if (!Number.isNaN(t)) pendingPdt = t;
    } else if (line.startsWith("#EXT-X-PART-INF:")) {
      const a = parseAttributes(line.slice("#EXT-X-PART-INF:".length));
      partTargetDuration = a["PART-TARGET"] ? Number(a["PART-TARGET"]) : undefined;
      lowLatency = true;
    } else if (line.startsWith("#EXT-X-PART:")) {
      const a = parseAttributes(line.slice("#EXT-X-PART:".length));
      lowLatency = true;
      parts.push({
        uri: a.URI ?? "",
        duration: a.DURATION ? Number(a.DURATION) : 0,
        independent: a.INDEPENDENT === "YES",
        // Parts appear before the EXTINF of the segment they belong to.
        segmentMsn: mediaSequence + segments.length,
        index: partIndex++,
        gap: a.GAP === "YES",
        lineNumber: ln,
      });
    } else if (line.startsWith("#EXT-X-PRELOAD-HINT:")) {
      const a = parseAttributes(line.slice("#EXT-X-PRELOAD-HINT:".length));
      lowLatency = true;
      preloadHint = { type: a.TYPE ?? "PART", uri: a.URI ?? "" };
    } else if (line.startsWith("#EXT-X-SERVER-CONTROL:")) {
      const a = parseAttributes(line.slice("#EXT-X-SERVER-CONTROL:".length));
      lowLatency = true;
      serverControl = {
        canBlockReload: a["CAN-BLOCK-RELOAD"] === "YES",
        partHoldBack: a["PART-HOLD-BACK"] ? Number(a["PART-HOLD-BACK"]) : undefined,
        holdBack: a["HOLD-BACK"] ? Number(a["HOLD-BACK"]) : undefined,
        canSkipUntil: a["CAN-SKIP-UNTIL"] ? Number(a["CAN-SKIP-UNTIL"]) : undefined,
        canSkipDateRanges: a["CAN-SKIP-DATERANGES"] === "YES",
      };
    } else if (line.startsWith("#EXT-X-RENDITION-REPORT:")) {
      const a = parseAttributes(line.slice("#EXT-X-RENDITION-REPORT:".length));
      renditionReports.push({
        uri: a.URI ?? "",
        lastMsn: a["LAST-MSN"] ? Number(a["LAST-MSN"]) : undefined,
        lastPart: a["LAST-PART"] ? Number(a["LAST-PART"]) : undefined,
      });
    } else if (line.startsWith("#EXT-X-SKIP:")) {
      const a = parseAttributes(line.slice("#EXT-X-SKIP:".length));
      skippedSegments = a["SKIPPED-SEGMENTS"] ? Number(a["SKIPPED-SEGMENTS"]) : undefined;
    } else if (line.startsWith("#EXT-X-CUE-OUT-CONT")) {
      const body = line.includes(":") ? line.slice(line.indexOf(":") + 1) : "";
      const attrs = parseAttributes(body);
      // Also supports the positional form ElapsedTime/Duration without '='.
      const dur = attrs.DURATION ?? attrs["CUE-OUT-CONT"];
      pushMarker("CUE-OUT-CONT", line, ln, attrs, {
        durationAttr: dur ? Number(dur) : undefined,
        elapsed: attrs.ELAPSEDTIME ? Number(attrs.ELAPSEDTIME) : undefined,
        payload: attrs.SCTE35 || attrs.CUE || undefined,
        payloadSource: attrs.SCTE35 ? "EXT-X-CUE-OUT-CONT SCTE35" : undefined,
      });
    } else if (line.startsWith("#EXT-X-CUE-OUT")) {
      const body = line.includes(":") ? line.slice(line.indexOf(":") + 1) : "";
      const attrs = parseAttributes(body);
      let dur: number | undefined;
      if (attrs.DURATION) dur = Number(attrs.DURATION);
      else if (body && /^[\d.]+$/.test(body.trim())) dur = Number(body.trim());
      pushMarker("CUE-OUT", line, ln, attrs, {
        durationAttr: dur,
        payload: attrs.SCTE35 || attrs.CUE || undefined,
        payloadSource: attrs.SCTE35 || attrs.CUE ? "EXT-X-CUE-OUT attribute" : undefined,
      });
    } else if (line.startsWith("#EXT-X-CUE-IN")) {
      pushMarker("CUE-IN", line, ln, {});
    } else if (line.startsWith("#EXT-X-DATERANGE:")) {
      const attrs = parseAttributes(line.slice("#EXT-X-DATERANGE:".length));
      // An interstitial is a different ad model: rather than splicing content
      // into this playlist, it names a separate asset for the player to load.
      if (attrs.CLASS === "com.apple.hls.interstitial") {
        pushMarker("INTERSTITIAL", line, ln, attrs, {
          id: attrs.ID,
          durationAttr: attrs.DURATION
            ? Number(attrs.DURATION)
            : attrs["PLANNED-DURATION"]
              ? Number(attrs["PLANNED-DURATION"])
              : undefined,
        });
        continue;
      }
      const payload = attrs["SCTE35-OUT"] || attrs["SCTE35-IN"] || attrs["SCTE35-CMD"];
      const source = attrs["SCTE35-OUT"]
        ? "SCTE35-OUT"
        : attrs["SCTE35-IN"]
          ? "SCTE35-IN"
          : attrs["SCTE35-CMD"]
            ? "SCTE35-CMD"
            : undefined;
      const planned = attrs["PLANNED-DURATION"] ?? attrs.DURATION;
      pushMarker("DATERANGE", line, ln, attrs, {
        id: attrs.ID,
        durationAttr: planned ? Number(planned) : undefined,
        payload,
        payloadSource: source ? `EXT-X-DATERANGE ${source}` : undefined,
      });
    } else if (line.startsWith("#EXT-OATCLS-SCTE35:")) {
      const payload = line.slice("#EXT-OATCLS-SCTE35:".length).trim();
      pushMarker("OATCLS-SCTE35", line, ln, {}, { payload, payloadSource: "EXT-OATCLS-SCTE35" });
    } else if (line.startsWith("#EXT-X-SCTE35:")) {
      const attrs = parseAttributes(line.slice("#EXT-X-SCTE35:".length));
      pushMarker("SCTE35", line, ln, attrs, {
        payload: attrs.CUE,
        payloadSource: "EXT-X-SCTE35 CUE",
        id: attrs.ID,
      });
    } else if (line.startsWith("#EXT-X-ASSET:")) {
      pushMarker("ASSET", line, ln, parseAttributes(line.slice("#EXT-X-ASSET:".length)));
    } else if (line.startsWith("#EXT-X-SPLICEPOINT-SCTE35:")) {
      const payload = line.slice("#EXT-X-SPLICEPOINT-SCTE35:".length).trim();
      pushMarker("SPLICEPOINT", line, ln, {}, { payload, payloadSource: "EXT-X-SPLICEPOINT-SCTE35" });
    }
  }

  // Markers after the last segment still matter (e.g. a trailing CUE-IN).
  for (const m of pendingMarkers) {
    m.segmentIndex = segIndex;
    m.startTime = cumulative;
    m.pdt = nextPdt;
    markers.push(m);
  }

  return {
    type: "media",
    uri,
    version,
    targetDuration,
    mediaSequence,
    discontinuitySequence,
    endList,
    playlistType,
    partTargetDuration,
    lowLatency,
    parts,
    serverControl,
    preloadHint,
    renditionReports,
    skippedSegments,
    segments,
    markers,
    totalDuration: cumulative,
    lines,
  };
}

export function parsePlaylist(text: string, uri: string): Playlist {
  return isMaster(text) ? parseMaster(text, uri) : parseMedia(text, uri);
}
