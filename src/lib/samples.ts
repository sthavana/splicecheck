/**
 * Recorded manifests, so the tool demonstrates itself without depending on a
 * live origin still being up. These are real captures from production
 * services, not hand-written fixtures — the point is to show what the analyser
 * says about streams somebody actually operates.
 */

import { readFile } from "node:fs/promises";
import { join, normalize } from "node:path";
import type { Fetcher } from "./runner";

export interface Sample {
  id: string;
  label: string;
  note: string;
  /** file inside fixtures/samples/<id>/ that the analysis starts from */
  entry: string;
  capturedAt: string;
  liveUrl?: string;
  /** synthetic fixtures, clearly marked as such */
  synthetic?: boolean;
}

/** A source feed paired with the stitched output produced from it. */
export interface PipelinePair {
  id: string;
  label: string;
  note: string;
  sourceId: string;
  stitchedId: string;
  sourceLabel: string;
  stitchedLabel: string;
}

export const PIPELINE_PAIRS: PipelinePair[] = [
  {
    id: "ssai-demo",
    label: "Packager feed vs SSAI output",
    note: "Four signalled avails: one filled correctly, one under-filled, one opened but never substituted, one missing entirely",
    sourceId: "ssai-source",
    stitchedId: "ssai-output",
    sourceLabel: "packager feed",
    stitchedLabel: "SSAI output",
  },
];

export function getPipelinePair(id: string): PipelinePair | undefined {
  return PIPELINE_PAIRS.find((p) => p.id === id);
}

export const SAMPLES: Sample[] = [
  {
    id: "telus-dash",
    label: "Multi-period DASH, live linear",
    note: "A live DASH service where each avail is its own Period, with SCTE-35 in both a standard and a vendor EventStream",
    entry: "manifest.mpd",
    capturedAt: "2026-09-17",
    liveUrl:
      "https://origin-irp-telus-avprod-a-01.vos360.video/Content/DASH_DASH/Live/channel(232006004130)/manifest.mpd",
  },
  {
    id: "ssai-source",
    label: "Packager feed (pre-insertion)",
    note: "Signalling-only feed with four 30s avails",
    entry: "playlist.m3u8",
    capturedAt: "synthetic",
    synthetic: true,
  },
  {
    id: "ssai-output",
    label: "SSAI output (post-insertion)",
    note: "The stitched result, with one avail filled, one short, one passed through and one missing",
    entry: "playlist.m3u8",
    capturedAt: "synthetic",
    synthetic: true,
  },
  {
    id: "unified-hls",
    label: "HLS, dual-signalled SCTE-35",
    note: "Live HLS carrying both EXT-X-DATERANGE and EXT-X-CUE-OUT at each splice point, across four renditions",
    entry: "master.m3u8",
    capturedAt: "2026-09-17",
    liveUrl: "https://demo.unified-streaming.com/k8s/live/scte35.isml/.m3u8",
  },
];

/** Synthetic origin so relative variant URIs in a recorded master still resolve. */
const RECORDED_ORIGIN = "https://recorded.splicecheck.local";

export function sampleEntryUrl(s: Sample): string {
  return `${RECORDED_ORIGIN}/${s.id}/${s.entry}`;
}

export function getSample(id: string): Sample | undefined {
  return SAMPLES.find((s) => s.id === id);
}

/**
 * Serves a recorded bundle from disk. Paths are confined to the sample's own
 * directory: a recorded manifest is still untrusted input.
 */
export function recordedFetcher(sample: Sample): Fetcher {
  const root = join(process.cwd(), "fixtures", "samples", sample.id);
  return async (url: string) => {
    const t0 = Date.now();
    let rel: string;
    try {
      const u = new URL(url);
      rel = decodeURIComponent(u.pathname.replace(new RegExp(`^/${sample.id}/`), ""));
    } catch {
      rel = url;
    }
    const safe = normalize(rel).replace(/^(\.\.[/\\])+/, "");
    if (safe.includes("..")) throw new Error("Refusing to read outside the sample bundle");
    const file = join(root, safe);
    if (!file.startsWith(root)) throw new Error("Refusing to read outside the sample bundle");
    try {
      const text = await readFile(file, "utf8");
      return { text, finalUrl: url, ms: Date.now() - t0 };
    } catch {
      throw new Error(`Recorded sample is missing ${safe}`);
    }
  };
}
