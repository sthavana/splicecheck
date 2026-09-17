import { NextRequest, NextResponse } from "next/server";
import { analyzeText, analyzeUrl, DEFAULT_MAX_VARIANTS } from "@/lib/runner";

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  let body: { url?: string; text?: string; maxVariants?: number };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Expected a JSON body" }, { status: 400 });
  }

  const maxVariants = Math.min(Math.max(body.maxVariants ?? DEFAULT_MAX_VARIANTS, 1), 12);

  try {
    if (body.text && body.text.trim()) {
      return NextResponse.json(analyzeText(body.text.trim(), "pasted manifest"));
    }
    if (!body.url || !body.url.trim()) {
      return NextResponse.json({ error: "Provide a manifest URL or paste a manifest" }, { status: 400 });
    }
    return NextResponse.json(await analyzeUrl(body.url.trim(), maxVariants));
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Analysis failed" }, { status: 400 });
  }
}
