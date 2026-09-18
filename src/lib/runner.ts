/**
 * One analysis path shared by the on-demand inspector and the monitor,
 * so what the monitor alerts on is exactly what the UI shows.
 */

import { isMaster, parseMaster, parseMedia, type Variant } from "./hls";
import { isMpd, parseMpd } from "./dash";
import { analyzeMpd } from "./analyzeDash";
import { analyzeCrossVariant, analyzeRendition, summarize, type AnalysisResult, type RenditionAnalysis } from "./analyze";

export const FETCH_TIMEOUT_MS = 12_000;
const MAX_BYTES = 24 * 1024 * 1024;
export const DEFAULT_MAX_VARIANTS = 6;

export interface SourceMeta {
  protocol: "hls" | "dash";
  fetchMs: number;
  /** HLS master */
  variantCount?: number;
  analysedCount?: number;
  /** DASH */
  mpd?: {
    type: string;
    periodCount: number;
    minimumUpdatePeriod?: number;
    timeShiftBufferDepth?: number;
    suggestedPresentationDelay?: number;
    availabilityStartTime?: number;
    publishTime?: number;
    profiles?: string;
  };
}

export type RunResult = AnalysisResult & {
  meta: SourceMeta;
  /**
   * The manifest as fetched. Segment reading for DASH has to build URLs from
   * the SegmentTemplate, and re-fetching a live manifest would give a slightly
   * different window than the one just analysed.
   */
  raw?: { text: string; uri: string };
};

/**
 * How a manifest is retrieved. Injected so the same analysis can run against
 * the network, against a recorded bundle, or against a test fixture.
 */
export type Fetcher = (url: string) => Promise<{ text: string; finalUrl: string; ms: number }>;

/** Block obvious SSRF targets. Not a substitute for an egress allowlist in production. */
export function assertPublicUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("Not a valid URL");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error("Only http and https URLs are supported");
  }
  const h = u.hostname.toLowerCase();
  const blocked =
    h === "localhost" ||
    h === "0.0.0.0" ||
    h.endsWith(".local") ||
    h.endsWith(".internal") ||
    /^127\./.test(h) ||
    /^10\./.test(h) ||
    /^192\.168\./.test(h) ||
    /^169\.254\./.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h) ||
    h === "[::1]" ||
    h === "::1";
  if (blocked) throw new Error("Refusing to fetch a private or loopback address");
  return u;
}

export async function fetchText(url: string): Promise<{ text: string; finalUrl: string; ms: number }> {
  assertPublicUrl(url);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: "follow",
      cache: "no-store",
      headers: {
        "User-Agent": "SpliceCheck/0.1 (ad-signalling inspector)",
        Accept: "application/dash+xml, application/vnd.apple.mpegurl, application/x-mpegurl, */*",
      },
    });
    const ms = Date.now() - t0;
    if (!res.ok) throw new Error(`Origin returned HTTP ${res.status} ${res.statusText}`);
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_BYTES) throw new Error("Manifest is unreasonably large");
    return { text: new TextDecoder().decode(buf), finalUrl: res.url || url, ms };
  } finally {
    clearTimeout(timer);
  }
}

function labelFor(v: Variant, i: number): string {
  if (v.mediaType) {
    return `${v.mediaType.toLowerCase()}${v.language ? ` ${v.language}` : ""}${v.name ? ` (${v.name})` : ""}`;
  }
  if (v.resolution) return `${v.resolution}${v.bandwidth ? ` @ ${Math.round(v.bandwidth / 1000)}kbps` : ""}`;
  if (v.bandwidth) return `${Math.round(v.bandwidth / 1000)}kbps`;
  return `variant ${i + 1}`;
}

/** A readable rendition label from a path or URL. */
function labelFromUri(uri: string): string {
  try {
    if (/^https?:\/\//i.test(uri)) {
      const u = new URL(uri);
      // Manifest filenames are often bare extensions (".mpd", ".m3u8"), so fall
      // back to the directory that identifies the stream.
      const parts = u.pathname.split("/").filter(Boolean);
      const last = parts[parts.length - 1] ?? "";
      const named = /^[^.]/.test(last) ? last : (parts[parts.length - 2] ?? u.hostname);
      return named || u.hostname;
    }
  } catch {
    /* fall through */
  }
  const base = uri.split(/[/\\]/).pop();
  return base && base.length > 0 ? base : uri;
}

export function analyzeText(text: string, uri: string): RunResult {
  if (isMpd(text)) {
    const mpd = parseMpd(text, uri);
    const rend = analyzeMpd(mpd, labelFromUri(uri));
    return {
      raw: { text, uri },
      ...summarize(uri, false, [rend], []),
      meta: {
        protocol: "dash",
        fetchMs: 0,
        mpd: {
          type: mpd.type,
          periodCount: mpd.periods.length,
          minimumUpdatePeriod: mpd.minimumUpdatePeriod,
          timeShiftBufferDepth: mpd.timeShiftBufferDepth,
          suggestedPresentationDelay: mpd.suggestedPresentationDelay,
          availabilityStartTime: mpd.availabilityStartTime,
          publishTime: mpd.publishTime,
          profiles: mpd.profiles,
        },
      },
    };
  }
  if (!text.trim().startsWith("#EXTM3U")) {
    throw new Error("Not an HLS playlist (no #EXTM3U) or a DASH MPD (no <MPD>)");
  }
  if (isMaster(text)) {
    throw new Error("That is a master playlist. Paste a media playlist, or supply a URL so the variants can be fetched.");
  }
  const pl = parseMedia(text, uri);
  const rend = analyzeRendition(pl, labelFromUri(uri));
  return { ...summarize(uri, false, [rend], []), meta: { protocol: "hls", fetchMs: 0 } };
}

export async function analyzeUrl(
  url: string,
  maxVariants = DEFAULT_MAX_VARIANTS,
  get: Fetcher = fetchText,
): Promise<RunResult> {
  const root = await get(url);

  if (isMpd(root.text)) {
    const r = analyzeText(root.text, root.finalUrl);
    r.meta.fetchMs = root.ms;
    r.raw = { text: root.text, uri: root.finalUrl };
    return r;
  }

  if (!root.text.trim().startsWith("#EXTM3U")) {
    throw new Error("The URL returned neither an HLS playlist nor a DASH MPD");
  }

  if (!isMaster(root.text)) {
    const pl = parseMedia(root.text, root.finalUrl);
    const rend = analyzeRendition(pl, "media playlist");
    return {
      ...summarize(root.finalUrl, false, [rend], []),
      meta: { protocol: "hls", fetchMs: root.ms },
    };
  }

  const master = parseMaster(root.text, root.finalUrl);
  const video = master.variants.filter((v) => !v.mediaType);
  const audio = master.variants.filter((v) => v.mediaType === "AUDIO");
  const picked = [...video, ...audio].slice(0, maxVariants);
  if (picked.length === 0) throw new Error("Master playlist contains no playable variants");

  const settled = await Promise.allSettled(
    picked.map(async (v, i) => {
      const r = await get(v.resolvedUri);
      return analyzeRendition(parseMedia(r.text, r.finalUrl), labelFor(v, i), v);
    }),
  );

  const renditions: RenditionAnalysis[] = [];
  const fetchErrors: string[] = [];
  settled.forEach((sr, i) => {
    if (sr.status === "fulfilled") renditions.push(sr.value);
    else fetchErrors.push(`${labelFor(picked[i], i)}: ${sr.reason?.message ?? sr.reason}`);
  });
  if (renditions.length === 0) {
    throw new Error(`Could not fetch any variant playlist. ${fetchErrors.join("; ")}`);
  }

  const cross = analyzeCrossVariant(renditions);
  for (const e of fetchErrors) {
    cross.push({
      severity: "warning",
      code: "VARIANT_FETCH_FAILED",
      title: "A variant playlist could not be fetched",
      detail: `${e}. It was excluded from cross-rendition comparison, so alignment problems in that rendition would not be caught here.`,
    });
  }

  return {
    ...summarize(root.finalUrl, true, renditions, cross),
    meta: {
      protocol: "hls",
      fetchMs: root.ms,
      variantCount: master.variants.length,
      analysedCount: renditions.length,
    },
  };
}
