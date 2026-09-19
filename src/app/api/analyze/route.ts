import { NextRequest, NextResponse } from "next/server";
import { analyzeText, analyzeUrl, DEFAULT_MAX_VARIANTS } from "@/lib/runner";
import { getSample, recordedFetcher, sampleEntryUrl } from "@/lib/samples";
import { probeMpd, probeRendition } from "@/lib/segments";
import { resolveRemotePeriods } from "@/lib/xlink";
import { parseMpd } from "@/lib/dash";

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  let body: {
    url?: string;
    text?: string;
    sampleId?: string;
    maxVariants?: number;
    /** open this many segments and read the SCTE-35 inside them */
    probeSegments?: number;
    /** call the ad decision service each remote Period names */
    resolveXlink?: boolean;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Expected a JSON body" }, { status: 400 });
  }

  const maxVariants = Math.min(Math.max(body.maxVariants ?? DEFAULT_MAX_VARIANTS, 1), 12);

  try {
    if (body.sampleId) {
      const sample = getSample(body.sampleId);
      if (!sample) return NextResponse.json({ error: "No such recorded sample" }, { status: 404 });
      const result = await analyzeUrl(sampleEntryUrl(sample), maxVariants, recordedFetcher(sample));
      return NextResponse.json({
        ...result,
        sourceUri: `recorded: ${sample.label}`,
        recorded: {
          id: sample.id,
          label: sample.label,
          capturedAt: sample.capturedAt,
          liveUrl: sample.liveUrl,
          synthetic: !!sample.synthetic,
        },
      });
    }
    if (body.text && body.text.trim()) {
      return NextResponse.json(analyzeText(body.text.trim(), "pasted manifest"));
    }
    if (!body.url || !body.url.trim()) {
      return NextResponse.json({ error: "Provide a manifest URL or paste a manifest" }, { status: 400 });
    }
    const result = await analyzeUrl(body.url.trim(), maxVariants);

    // Resolving remote Periods makes real requests to an ad decision service,
    // so it is opt-in for the same reason reading segments is.
    let xlink;
    if (body.resolveXlink && result.raw && result.meta.protocol === "dash") {
      try {
        const mpd = parseMpd(result.raw.text, result.raw.uri);
        const report = await resolveRemotePeriods(mpd);
        if (report.attempted > 0) xlink = report;
      } catch (e) {
        xlink = { error: e instanceof Error ? e.message : "could not resolve remote Periods" };
      }
    }

    // Reading segments costs megabytes and seconds, so it is opt-in.
    const wanted = Math.min(Math.max(body.probeSegments ?? 0, 0), 12);
    const first = result.renditions[0];
    // The manifest text is only needed server-side, to build DASH segment URLs.
    const { raw, ...response } = result;
    if (wanted > 0 && first) {
      try {
        const probe =
          first.protocol === "hls"
            ? await probeRendition(first, { maxSegments: wanted })
            : raw
              ? await probeMpd(raw.text, raw.uri, first, { maxSegments: wanted })
              : undefined;
        if (probe) return NextResponse.json({ ...response, probe, xlink });
      } catch (e) {
        return NextResponse.json({
          ...response,
          xlink,
          probeError: e instanceof Error ? e.message : "could not read segments",
        });
      }
    }
    return NextResponse.json(xlink ? { ...response, xlink } : response);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Analysis failed" }, { status: 400 });
  }
}
