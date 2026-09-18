/**
 * The client-side ad insertion path.
 *
 * The contrast with SSAI is the whole point of modelling this. Server-side
 * rewrites the manifest, so the ad arrives as ordinary media on the ordinary
 * URL and the player never knows. Client-side leaves the manifest completely
 * alone: the player reads the marker itself, stops the content, fetches an ad
 * from somewhere else entirely, plays it, and resumes.
 *
 * Everything that follows comes from that one difference — what the manifest
 * looks like, who fires the beacons, what an ad blocker can reach, and what the
 * measurement is actually able to say.
 */

import type { Timeline } from "./timeline";

export interface Creative {
  id: string;
  advertiser: string;
  durationSec: number;
}

export interface CsaiSpec {
  creatives?: Creative[];
  /** The ad server returns nothing in time and the player falls back to content. */
  adServerTimeout?: boolean;
  /** An ad blocker stops the requests to the ad domain. */
  blocked?: boolean;
  /** The player cannot reach the creative CDN after winning the auction. */
  creativeFailsToLoad?: boolean;
}

export type ClientEventKind = "content" | "request" | "ad" | "beacon" | "resume" | "failure";

export interface ClientEvent {
  atSec: number;
  kind: ClientEventKind;
  label: string;
  detail?: string;
}

export interface CsaiResult {
  /** The manifest is untouched; this is the one the origin already served. */
  manifestUnchanged: true;
  vast: string;
  events: ClientEvent[];
  /** Seconds of the avail that actually carried an ad. */
  deliveredSec: number;
  signalledSec: number;
  outcome: "filled" | "under-filled" | "empty";
  notes: string[];
}

const DEFAULT_CREATIVES: Creative[] = [
  { id: "creative-4417", advertiser: "Northbridge Motors", durationSec: 30 },
  { id: "creative-8820", advertiser: "Caldera Coffee", durationSec: 30 },
  { id: "creative-1163", advertiser: "Meridian Bank", durationSec: 30 },
];

const QUARTILES = [
  ["impression", 0],
  ["start", 0],
  ["firstQuartile", 0.25],
  ["midpoint", 0.5],
  ["thirdQuartile", 0.75],
  ["complete", 1],
] as const;

function vastFor(pod: Creative[], availSec: number): string {
  const ads = pod
    .map(
      (c, i) => `    <Ad id="${c.id}" sequence="${i + 1}">
      <InLine>
        <AdSystem>Simulated Decision Service</AdSystem>
        <AdTitle>${c.advertiser}</AdTitle>
        <Impression><![CDATA[https://ads.example/imp?c=${c.id}]]></Impression>
        <Creatives>
          <Creative>
            <Linear>
              <Duration>${new Date(c.durationSec * 1000).toISOString().slice(11, 19)}</Duration>
              <TrackingEvents>
${QUARTILES.filter(([e]) => e !== "impression")
  .map(
    ([e]) =>
      `                <Tracking event="${e}"><![CDATA[https://ads.example/t?c=${c.id}&e=${e}]]></Tracking>`,
  )
  .join("\n")}
              </TrackingEvents>
              <MediaFiles>
                <MediaFile type="video/mp4" bitrate="2000" width="1280" height="720"><![CDATA[https://cdn.ads.example/${c.id}/720p.mp4]]></MediaFile>
              </MediaFiles>
            </Linear>
          </Creative>
        </Creatives>
      </InLine>
    </Ad>`,
    )
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<VAST version="4.2">
  <!-- Requested by the player when it read the marker, for a ${availSec}s avail -->
${ads || "    <!-- no ads returned -->"}
</VAST>
`;
}

export function runCsai(tl: Timeline, spec: CsaiSpec = {}): CsaiResult {
  const avail = tl.avails[0];
  const pool = spec.creatives ?? DEFAULT_CREATIVES;
  const signalledSec = avail?.durationSec ?? 0;

  const events: ClientEvent[] = [];
  const notes: string[] = [];
  const at = avail?.snappedStartSec ?? 0;

  events.push({
    atSec: Math.max(0, at - 6),
    kind: "content",
    label: "Playing programme",
    detail: "The player is reading the same manifest the origin served — nothing in it has changed.",
  });
  events.push({
    atSec: at,
    kind: "request",
    label: "Marker reached; VAST request",
    detail: "The player parsed the CUE-OUT itself and called the ad server. Nothing upstream did this for it.",
  });

  if (spec.blocked) {
    events.push({
      atSec: at,
      kind: "failure",
      label: "Request blocked",
      detail: "The ad domain is on a blocklist. The request never leaves the device.",
    });
    events.push({
      atSec: at,
      kind: "content",
      label: "Programme continues under the avail",
      detail: "The viewer sees the underlying feed. No impression, no revenue, and nothing upstream can tell.",
    });
    notes.push("A client-side request is reachable by an ad blocker; a server-side splice is not.");
    return { manifestUnchanged: true, vast: vastFor([], signalledSec), events, deliveredSec: 0, signalledSec, outcome: "empty", notes };
  }

  if (spec.adServerTimeout) {
    events.push({
      atSec: at + 2,
      kind: "failure",
      label: "Ad server did not respond in time",
      detail: "The player waited out its timeout and resumed content rather than showing black.",
    });
    events.push({ atSec: at + 2, kind: "content", label: "Programme continues under the avail" });
    notes.push("The decision happens inside the playback deadline, so latency turns directly into unfilled inventory.");
    return { manifestUnchanged: true, vast: vastFor([], signalledSec), events, deliveredSec: 0, signalledSec, outcome: "empty", notes };
  }

  // Fill the avail from the pool, as a decision service would.
  const pod: Creative[] = [];
  let total = 0;
  for (let i = 0; total + 0.001 < signalledSec && i < 32; i++) {
    const c = pool[i % pool.length];
    pod.push(c);
    total += c.durationSec;
  }

  events.push({
    atSec: at,
    kind: "request",
    label: `VAST response: ${pod.length} creative${pod.length === 1 ? "" : "s"}`,
    detail: "The pod, the media file URLs, and every tracking URL the player is expected to call.",
  });

  let cursor = 0;
  let delivered = 0;
  for (const c of pod) {
    if (spec.creativeFailsToLoad && c === pod[0]) {
      events.push({
        atSec: at + cursor,
        kind: "failure",
        label: `${c.advertiser} failed to load`,
        detail: "The auction was won and the creative CDN did not deliver. The slot is dead air or a skip.",
      });
      notes.push("The creative is fetched from a third CDN, which is one more thing between the decision and the screen.");
      cursor += 0;
      continue;
    }
    events.push({
      atSec: at + cursor,
      kind: "ad",
      label: `${c.advertiser} (${c.durationSec}s)`,
      detail: `Loaded from cdn.ads.example, decoded in a separate pipeline from the programme.`,
    });
    for (const [event, frac] of QUARTILES) {
      events.push({
        atSec: at + cursor + c.durationSec * frac,
        kind: "beacon",
        label: event,
        detail: "Fired by the player, from the device.",
      });
    }
    cursor += c.durationSec;
    delivered += c.durationSec;
  }

  events.push({
    atSec: at + Math.max(cursor, signalledSec),
    kind: "resume",
    label: "Resume programme",
    detail: "The player seeks back into the content it never stopped buffering.",
  });

  notes.push("The manifest is byte-for-byte what the origin served — the break is described, never stitched.");
  notes.push("Beacons come from the device, so quartiles reflect what actually played, including mute and backgrounding.");
  if (delivered + 0.001 < signalledSec) {
    notes.push("The pod is shorter than the avail; the remainder is programme content or slate.");
  }

  events.sort((a, b) => a.atSec - b.atSec);

  return {
    manifestUnchanged: true,
    vast: vastFor(pod, signalledSec),
    events,
    deliveredSec: delivered,
    signalledSec,
    outcome: delivered === 0 ? "empty" : delivered + 0.001 < signalledSec ? "under-filled" : "filled",
    notes,
  };
}
