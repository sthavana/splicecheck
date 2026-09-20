import { NextRequest, NextResponse } from "next/server";
import { analyzeVast, analyzeVmap, followWrappers, parseVast, parseVmap, type StreamProfile, type VastFetcher } from "@/lib/vast";
import { analyzeUrl, assertPublicUrl, FETCH_TIMEOUT_MS } from "@/lib/runner";
import { parseMpd } from "@/lib/dash";

export const maxDuration = 90;

/** The same guard the rest of the tool fetches behind. */
const fetcher: VastFetcher = async (url, timeoutMs) => {
  assertPublicUrl(url);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const started = Date.now();
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      cache: "no-store",
      headers: { "User-Agent": "SpliceCheck/0.1 (ad-signalling inspector)", accept: "application/xml,text/xml,*/*" },
    });
    return { ok: res.ok, status: res.status, text: await res.text(), ms: Date.now() - started };
  } catch (e) {
    return {
      ok: false,
      ms: Date.now() - started,
      error: e instanceof Error ? (e.name === "AbortError" ? `no response within ${timeoutMs}ms` : e.message) : String(e),
    };
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Derives the ladder an ad has to be spliced into, so the conformance checks
 * have something to compare against. Optional: without it the response is still
 * checked, just not against a particular stream.
 */
async function profileFromStream(url: string, availSeconds?: number): Promise<StreamProfile> {
  const r = await analyzeUrl(url, 8);
  const codecs = new Set<string>();
  const resolutions = new Set<string>();
  const bandwidths: number[] = [];
  for (const rend of r.renditions) {
    // HLS: each analysed rendition carries the variant it came from.
    const v = rend.variant;
    if (v?.codecs) for (const c of v.codecs.split(",")) codecs.add(c.trim());
    if (v?.resolution) resolutions.add(v.resolution);
    if (v?.bandwidth) bandwidths.push(v.bandwidth);

  }

  // DASH: the analysis summarises Periods rather than carrying the ladder, so
  // the MPD is read again for the Representations themselves.
  if (r.meta.protocol === "dash" && r.raw) {
    for (const period of parseMpd(r.raw.text, r.raw.uri).periods) {
      for (const set of period.adaptationSets) {
        for (const rep of set.representations) {
          if (rep.codecs) codecs.add(rep.codecs);
          if (rep.width && rep.height) resolutions.add(`${rep.width}x${rep.height}`);
          if (rep.bandwidth) bandwidths.push(rep.bandwidth);
        }
      }
    }
  }
  return {
    codecs: [...codecs],
    resolutions: [...resolutions],
    bandwidths,
    availSeconds,
    serverSide: true,
  };
}

export async function POST(req: NextRequest) {
  let body: {
    xml?: string;
    url?: string;
    /** Follow the wrapper chain, which makes real requests to an ad server. */
    follow?: boolean;
    /** Compare the creatives against the ladder of this stream. */
    streamUrl?: string;
    availSeconds?: number;
    serverSide?: boolean;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Expected a JSON body" }, { status: 400 });
  }

  try {
    let xml = body.xml?.trim();
    let uri = "pasted response";

    if (!xml) {
      if (!body.url?.trim()) {
        return NextResponse.json({ error: "Provide a VAST or VMAP document, or a URL to fetch one from" }, { status: 400 });
      }
      uri = body.url.trim();
      const res = await fetcher(uri, FETCH_TIMEOUT_MS);
      if (!res.ok || !res.text) {
        return NextResponse.json(
          { error: `Could not fetch the ad tag: ${res.error ?? `HTTP ${res.status}`}` },
          { status: 400 },
        );
      }
      xml = res.text;
    }

    // A VMAP is a schedule of breaks; a VAST is one response.
    if (/<VMAP[\s>]/i.test(xml)) {
      const doc = parseVmap(xml, uri);
      return NextResponse.json({ kind: "vmap", uri, vmap: doc, findings: analyzeVmap(doc) });
    }

    const doc = parseVast(xml, uri);
    const profile: StreamProfile = body.streamUrl?.trim()
      ? await profileFromStream(body.streamUrl.trim(), body.availSeconds)
      : { availSeconds: body.availSeconds, serverSide: body.serverSide !== false };

    const analysis = analyzeVast(doc, profile);
    let chain;
    if (body.follow && doc.ads.some((a) => a.wrapper)) {
      chain = await followWrappers(doc, uri, { fetcher });
      // The chain's own findings belong with the response's.
      analysis.findings.push(...chain.findings);
      if (chain.resolved) {
        const resolved = analyzeVast(chain.resolved, profile);
        analysis.findings.push(...resolved.findings);
        analysis.totalDurationSec += resolved.totalDurationSec;
      }
    }

    return NextResponse.json({ kind: "vast", uri, profile, ...analysis, chain });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Could not read that document" }, { status: 400 });
  }
}
