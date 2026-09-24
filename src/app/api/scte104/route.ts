import { NextRequest, NextResponse } from "next/server";
import { analyzeScte104, compareScte104ToScte35, parseScte104 } from "@/lib/scte104";
import { parseSpliceInfoSection } from "@/lib/scte35";
import { analyzeUrl } from "@/lib/runner";

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  let body: { message?: string; scte35?: string; streamUrl?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Expected a JSON body" }, { status: 400 });
  }

  if (!body.message?.trim()) {
    return NextResponse.json({ error: "Provide an SCTE-104 message" }, { status: 400 });
  }

  try {
    const msg = parseScte104(body.message.trim());
    const findings = analyzeScte104(msg);

    // The comparison needs the section the encoder emitted. It can be pasted,
    // or taken from the first decodable break in a stream.
    let section;
    let emittedFrom: string | undefined;
    if (body.scte35?.trim()) {
      section = parseSpliceInfoSection(body.scte35.trim());
      emittedFrom = "the pasted section";
    } else if (body.streamUrl?.trim()) {
      const r = await analyzeUrl(body.streamUrl.trim(), 4);
      const found = r.renditions[0]?.breaks.find((b) => b.signal?.section);
      if (!found) {
        return NextResponse.json({
          message: msg,
          findings,
          warning: "That stream carries no decodable SCTE-35 to compare the message against.",
        });
      }
      section = found.signal!.section;
      emittedFrom = r.sourceUri;
    }

    if (!section) return NextResponse.json({ message: msg, findings });

    const cmp = compareScte104ToScte35(msg, section);
    return NextResponse.json({
      message: msg,
      findings: [...findings, ...cmp.findings],
      checked: cmp.checked,
      emitted: { commandName: section.spliceCommandName, crcValid: section.crcValid, from: emittedFrom },
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Could not read that message" },
      { status: 400 },
    );
  }
}
