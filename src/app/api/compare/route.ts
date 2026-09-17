import { NextRequest, NextResponse } from "next/server";
import { analyzeText, analyzeUrl, type RunResult } from "@/lib/runner";
import { comparePipeline } from "@/lib/pipeline";
import { getPipelinePair, getSample, recordedFetcher, sampleEntryUrl } from "@/lib/samples";

export const maxDuration = 90;

interface Side {
  url?: string;
  text?: string;
  sampleId?: string;
}

async function resolve(side: Side, which: string): Promise<RunResult> {
  if (side.sampleId) {
    const sample = getSample(side.sampleId);
    if (!sample) throw new Error(`No such recorded sample for the ${which}`);
    return analyzeUrl(sampleEntryUrl(sample), 6, recordedFetcher(sample));
  }
  if (side.text?.trim()) return analyzeText(side.text.trim(), `pasted ${which}`);
  if (side.url?.trim()) return analyzeUrl(side.url.trim());
  throw new Error(`Provide a URL or manifest for the ${which}`);
}

export async function POST(req: NextRequest) {
  let body: {
    pairId?: string;
    source?: Side;
    stitched?: Side;
    sourceLabel?: string;
    stitchedLabel?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Expected a JSON body" }, { status: 400 });
  }

  try {
    if (body.pairId) {
      const pair = getPipelinePair(body.pairId);
      if (!pair) return NextResponse.json({ error: "No such demo pair" }, { status: 404 });
      const [source, stitched] = await Promise.all([
        resolve({ sampleId: pair.sourceId }, "source"),
        resolve({ sampleId: pair.stitchedId }, "output"),
      ]);
      return NextResponse.json({
        ...comparePipeline(source, stitched, {
          source: pair.sourceLabel,
          stitched: pair.stitchedLabel,
        }),
        pair: { id: pair.id, label: pair.label, note: pair.note },
      });
    }

    const [source, stitched] = await Promise.all([
      resolve(body.source ?? {}, "source"),
      resolve(body.stitched ?? {}, "output"),
    ]);
    return NextResponse.json(
      comparePipeline(source, stitched, {
        source: body.sourceLabel?.trim() || "source",
        stitched: body.stitchedLabel?.trim() || "output",
      }),
    );
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Comparison failed" }, { status: 400 });
  }
}
