import { NextRequest, NextResponse } from "next/server";
import { analyzeText, analyzeUrl, DEFAULT_MAX_VARIANTS } from "@/lib/runner";
import { getSample, recordedFetcher, sampleEntryUrl } from "@/lib/samples";
import { probeRendition } from "@/lib/segments";

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  let body: {
    url?: string;
    text?: string;
    sampleId?: string;
    maxVariants?: number;
    /** open this many segments and read the SCTE-35 inside them */
    probeSegments?: number;
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
        recorded: { id: sample.id, label: sample.label, capturedAt: sample.capturedAt, liveUrl: sample.liveUrl },
      });
    }
    if (body.text && body.text.trim()) {
      return NextResponse.json(analyzeText(body.text.trim(), "pasted manifest"));
    }
    if (!body.url || !body.url.trim()) {
      return NextResponse.json({ error: "Provide a manifest URL or paste a manifest" }, { status: 400 });
    }
    const result = await analyzeUrl(body.url.trim(), maxVariants);

    // Reading segments costs megabytes and seconds, so it is opt-in.
    const wanted = Math.min(Math.max(body.probeSegments ?? 0, 0), 12);
    if (wanted > 0 && result.renditions[0]?.protocol === "hls") {
      try {
        const probe = await probeRendition(result.renditions[0], { maxSegments: wanted });
        return NextResponse.json({ ...result, probe });
      } catch (e) {
        return NextResponse.json({
          ...result,
          probeError: e instanceof Error ? e.message : "could not read segments",
        });
      }
    }
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Analysis failed" }, { status: 400 });
  }
}
