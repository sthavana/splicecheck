/**
 * The ad decision: a VAST response, and what a stitcher can actually take
 * from it.
 *
 * Until this stage existed the simulator's SSAI picked creatives from a list,
 * which meant the two halves of ad insertion never met. The whole argument of
 * this project is that they fail into each other — a fault in the response
 * surfaces a layer downstream as an avail that did not fill, which in a
 * manifest looks exactly like a signalling fault.
 *
 * So the decision is modelled properly: the service returns a document, and the
 * stitcher then accepts or rejects each creative for reasons a real one would.
 * What reaches the manifest is only what survived that.
 */

import { analyzeVast, parseVast, type VastDocument } from "../vast";
import type { Finding } from "../analyze";

export interface DecisionCreative {
  id: string;
  advertiser: string;
  durationSec: number;
  codec: string;
  bitrateKbps: number;
  /** Executable creatives are code, not media. */
  apiFramework?: string;
}

export interface DecisionFaults {
  /** The service answers with no ads: the break collapses. */
  noFill?: boolean;
  /** Every creative is VPAID, which a stitcher has no way to run. */
  vpaidOnly?: boolean;
  /** The creatives come back in a codec the content ladder does not use. */
  codecMismatch?: boolean;
  /** The chain of redirects takes longer than the decision had. */
  slowChain?: boolean;
  /** The pod returned is longer than the avail asked for. */
  podTooLong?: boolean;
  /** The pod returned is shorter than the avail asked for. */
  podTooShort?: boolean;
}

export interface DecisionSpec {
  /** The ladder the creatives have to be spliced into. */
  contentCodec?: string;
  contentPeakKbps?: number;
  /** How long the decision is allowed to take before the splice point. */
  budgetMs?: number;
  faults?: DecisionFaults;
  sessionId?: string;
}

export interface RejectedCreative {
  creative: DecisionCreative;
  reason: string;
  code: string;
}

export interface AdDecision {
  availId: number;
  availSeconds: number;
  /** The document the service returned, as XML. */
  vast: string;
  parsed: VastDocument;
  /** How long the decision took, including any redirects. */
  elapsedMs: number;
  budgetMs: number;
  /** What the stitcher could use. */
  accepted: DecisionCreative[];
  /** What it could not, and why. */
  rejected: RejectedCreative[];
  /** The analyser's own verdict on the response, before any stitching. */
  findings: Finding[];
}

const POOL: DecisionCreative[] = [
  { id: "creative-4417", advertiser: "Northbridge Motors", durationSec: 30, codec: "avc1.64001f", bitrateKbps: 2500 },
  { id: "creative-8820", advertiser: "Caldera Coffee", durationSec: 30, codec: "avc1.64001f", bitrateKbps: 2500 },
  { id: "creative-1163", advertiser: "Meridian Bank", durationSec: 30, codec: "avc1.64001f", bitrateKbps: 2500 },
];

const QUARTILES = ["start", "firstQuartile", "midpoint", "thirdQuartile", "complete"];

function creativeXml(c: DecisionCreative, i: number): string {
  const dur = new Date(c.durationSec * 1000).toISOString().slice(11, 19);
  const media = c.apiFramework
    ? `<MediaFile type="application/javascript" apiFramework="${c.apiFramework}"><![CDATA[https://ads.example/${c.id}.js]]></MediaFile>`
    : `<MediaFile type="video/mp4" codec="${c.codec}" width="1280" height="720" bitrate="${c.bitrateKbps}" delivery="progressive"><![CDATA[https://cdn.ads.example/${c.id}/720p.mp4]]></MediaFile>`;
  return `    <Ad id="${c.id}" sequence="${i + 1}">
      <InLine>
        <AdSystem>Simulated Decision Service</AdSystem>
        <AdTitle>${c.advertiser}</AdTitle>
        <Impression><![CDATA[https://ads.example/imp?c=${c.id}]]></Impression>
        <Error><![CDATA[https://ads.example/err?c=${c.id}&code=[ERRORCODE]]]></Error>
        <Creatives>
          <Creative id="${c.id}">
            <UniversalAdId idRegistry="Ad-ID">${c.id.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12)}</UniversalAdId>
            <Linear>
              <Duration>${dur}</Duration>
              <TrackingEvents>
${QUARTILES.map((e) => `                <Tracking event="${e}"><![CDATA[https://ads.example/t?c=${c.id}&e=${e}]]></Tracking>`).join("\n")}
              </TrackingEvents>
              <MediaFiles>
                ${media}
              </MediaFiles>
            </Linear>
          </Creative>
        </Creatives>
      </InLine>
    </Ad>`;
}

/** Picks a pod for the avail, then expresses it as the document a service returns. */
export function requestAds(availId: number, availSeconds: number, spec: DecisionSpec = {}): AdDecision {
  const f = spec.faults ?? {};
  const contentCodec = spec.contentCodec ?? "avc1.64001f";
  const budgetMs = spec.budgetMs ?? 1000;

  // How much the service decides to return.
  const target = f.podTooLong
    ? availSeconds + 15
    : f.podTooShort
      ? Math.max(0, availSeconds - 30)
      : availSeconds;

  const pod: DecisionCreative[] = [];
  if (!f.noFill) {
    let total = 0;
    for (let i = 0; total + 0.001 < target && i < 32; i++) {
      const base = POOL[i % POOL.length];
      pod.push({
        ...base,
        codec: f.codecMismatch ? "hvc1.1.6.L93.B0" : base.codec,
        apiFramework: f.vpaidOnly ? "VPAID" : undefined,
      });
      total += base.durationSec;
    }
  }

  const vast = `<?xml version="1.0" encoding="UTF-8"?>
<VAST version="4.2">
${pod.length ? pod.map(creativeXml).join("\n") : "    <!-- no ads returned -->"}
</VAST>
`;

  const parsed = parseVast(vast, `sim://decision/avail-${availId}`);
  const findings = analyzeVast(parsed, {
    codecs: [contentCodec],
    bandwidths: spec.contentPeakKbps ? [spec.contentPeakKbps * 1000] : undefined,
    availSeconds,
    serverSide: true,
  }).findings;

  // Each redirect is a serial round trip; a slow chain spends the budget.
  const elapsedMs = f.slowChain ? budgetMs + 900 : 180;

  // Now the stitcher's turn. It takes what it can splice and drops the rest.
  const accepted: DecisionCreative[] = [];
  const rejected: RejectedCreative[] = [];

  if (elapsedMs > budgetMs) {
    for (const c of pod) {
      rejected.push({
        creative: c,
        code: "DECISION_TOO_SLOW",
        reason: `the decision took ${elapsedMs}ms against a ${budgetMs}ms budget, so the splice point passed before an answer arrived`,
      });
    }
  } else {
    for (const c of pod) {
      if (c.apiFramework) {
        rejected.push({
          creative: c,
          code: "EXECUTABLE_CREATIVE",
          reason: `${c.apiFramework} is code the player executes, and a stitcher has no engine to run it`,
        });
        continue;
      }
      accepted.push(c);
    }
  }

  return { availId, availSeconds, vast, parsed, elapsedMs, budgetMs, accepted, rejected, findings };
}

/** One line on what the decision produced, for the stage strip. */
export function describeDecision(d: AdDecision): string {
  if (d.parsed.empty) return "The service returned no ads; the break will collapse to content.";
  if (d.accepted.length === 0) {
    return `${d.rejected.length} creative(s) returned, none usable — ${d.rejected[0]?.reason ?? "rejected"}.`;
  }
  const secs = d.accepted.reduce((n, c) => n + c.durationSec, 0);
  const dropped = d.rejected.length ? `, ${d.rejected.length} rejected` : "";
  return `${d.accepted.length} creative(s) accepted for ${secs}s of a ${d.availSeconds}s avail${dropped}, in ${d.elapsedMs}ms.`;
}
