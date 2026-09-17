import { NextRequest, NextResponse } from "next/server";
import { isMaster, parseMaster, parseMedia, type Variant } from "@/lib/hls";
import { analyzeCrossVariant, analyzeRendition, summarize, type RenditionAnalysis } from "@/lib/analyze";

export const maxDuration = 60;

const FETCH_TIMEOUT_MS = 12_000;
const MAX_BYTES = 12 * 1024 * 1024;
const DEFAULT_MAX_VARIANTS = 6;

/** Block obvious SSRF targets. Not a substitute for an egress allowlist in production. */
function assertPublicUrl(raw: string): URL {
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

async function fetchText(url: string): Promise<{ text: string; finalUrl: string; ms: number; status: number }> {
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
        "User-Agent": "SpliceCheck/0.1 (HLS ad-signalling inspector)",
        Accept: "application/vnd.apple.mpegurl, application/x-mpegurl, */*",
      },
    });
    const ms = Date.now() - t0;
    if (!res.ok) throw new Error(`Origin returned HTTP ${res.status} ${res.statusText}`);
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_BYTES) throw new Error("Playlist is unreasonably large");
    return {
      text: new TextDecoder().decode(buf),
      finalUrl: res.url || url,
      ms,
      status: res.status,
    };
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

export async function POST(req: NextRequest) {
  let body: { url?: string; text?: string; maxVariants?: number };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Expected a JSON body" }, { status: 400 });
  }

  const maxVariants = Math.min(Math.max(body.maxVariants ?? DEFAULT_MAX_VARIANTS, 1), 12);

  try {
    // ---- pasted manifest -------------------------------------------------
    if (body.text && body.text.trim()) {
      const text = body.text.trim();
      if (!text.startsWith("#EXTM3U")) {
        return NextResponse.json({ error: "That does not look like an HLS playlist (no #EXTM3U)" }, { status: 400 });
      }
      if (isMaster(text)) {
        return NextResponse.json(
          { error: "That is a master playlist. Paste a media playlist, or supply a URL so the variants can be fetched." },
          { status: 400 },
        );
      }
      const pl = parseMedia(text, "pasted-playlist.m3u8");
      const rend = analyzeRendition(pl, "pasted playlist");
      return NextResponse.json(summarize("pasted playlist", false, [rend], []));
    }

    // ---- URL -------------------------------------------------------------
    if (!body.url || !body.url.trim()) {
      return NextResponse.json({ error: "Provide a playlist URL or paste a manifest" }, { status: 400 });
    }

    const root = await fetchText(body.url.trim());
    if (!root.text.trim().startsWith("#EXTM3U")) {
      return NextResponse.json(
        { error: "The URL did not return an HLS playlist (response does not start with #EXTM3U)" },
        { status: 400 },
      );
    }

    if (!isMaster(root.text)) {
      const pl = parseMedia(root.text, root.finalUrl);
      const rend = analyzeRendition(pl, "media playlist");
      return NextResponse.json(summarize(root.finalUrl, false, [rend], []));
    }

    const master = parseMaster(root.text, root.finalUrl);
    // Prefer video variants, but keep audio renditions — desynced audio
    // signalling is a real failure mode worth catching.
    const video = master.variants.filter((v) => !v.mediaType);
    const audio = master.variants.filter((v) => v.mediaType === "AUDIO");
    const picked = [...video, ...audio].slice(0, maxVariants);

    if (picked.length === 0) {
      return NextResponse.json({ error: "Master playlist contains no playable variants" }, { status: 400 });
    }

    const settled = await Promise.allSettled(
      picked.map(async (v, i) => {
        const r = await fetchText(v.resolvedUri);
        const pl = parseMedia(r.text, r.finalUrl);
        return analyzeRendition(pl, labelFor(v, i), v);
      }),
    );

    const renditions: RenditionAnalysis[] = [];
    const fetchErrors: string[] = [];
    settled.forEach((s, i) => {
      if (s.status === "fulfilled") renditions.push(s.value);
      else fetchErrors.push(`${labelFor(picked[i], i)}: ${s.reason?.message ?? s.reason}`);
    });

    if (renditions.length === 0) {
      return NextResponse.json(
        { error: `Could not fetch any variant playlist. ${fetchErrors.join("; ")}` },
        { status: 502 },
      );
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

    const result = summarize(root.finalUrl, true, renditions, cross);
    return NextResponse.json({
      ...result,
      master: {
        variantCount: master.variants.length,
        analysedCount: renditions.length,
        fetchMs: root.ms,
      },
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Analysis failed" },
      { status: 400 },
    );
  }
}
