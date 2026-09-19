/**
 * Resolving remote Periods, and checking what comes back.
 *
 * A Period with xlink:href is a promise: the packager has left a hole in the
 * timeline and named a service that fills it at playback time. Everything else
 * about a manifest can be checked from its text. This cannot — the avail either
 * plays or it does not depending on a request nobody downstream can see the
 * result of, made at a moment nobody downstream controls.
 *
 * So this makes the request, the way a player would, and reports what happened:
 * whether it answered, how long it took, and whether what came back matches the
 * shape the manifest reserved for it.
 */

import { parseMpd, type DashPeriod, type MpdDocument } from "./dash";
import type { Finding } from "./analyze";
import { assertPublicUrl } from "./runner";

export interface XlinkResolution {
  periodId?: string;
  href: string;
  actuate: string;
  ok: boolean;
  status?: number;
  ms: number;
  error?: string;
  /** Periods the remote document supplied. */
  periodsReturned?: number;
  /** Total duration of what came back, seconds. */
  resolvedDuration?: number;
  /** What the placeholder said the avail would be, seconds. */
  declaredDuration?: number;
  /** Representation signature of the resolved content, for comparison. */
  resolvedCodecs?: string[];
}

export interface XlinkReport {
  attempted: number;
  resolved: number;
  resolutions: XlinkResolution[];
  findings: Finding[];
}

/** What a resolution attempt returns, so tests can supply one without a server. */
export interface RemoteResponse {
  ok: boolean;
  status?: number;
  text?: string;
  ms: number;
  error?: string;
}

export type RemoteFetcher = (url: string, timeoutMs: number) => Promise<RemoteResponse>;

export interface XlinkOptions {
  timeoutMs?: number;
  /** Cap on how many remote Periods to resolve in one pass. */
  maxPeriods?: number;
  /** Injectable, the way the analyser's own fetcher is. */
  fetcher?: RemoteFetcher;
}

const DEFAULTS: Required<Omit<XlinkOptions, "fetcher">> = { timeoutMs: 8_000, maxPeriods: 6 };

/**
 * The deadline a player is working to. A resolution slower than this arrives
 * after the point it was needed, whatever the HTTP status says.
 */
const LATE_MS = 2_000;

function codecSignature(periods: DashPeriod[]): string[] {
  const out = new Set<string>();
  for (const p of periods) {
    for (const as of p.adaptationSets) {
      for (const r of as.representations) {
        out.add(`${r.codecs ?? "?"} ${r.width ?? ""}x${r.height ?? ""}`.trim());
      }
    }
  }
  return [...out];
}

function contentSignature(mpd: MpdDocument): string[] {
  return codecSignature(mpd.periods.filter((p) => !p.isPlaceholder && p.adaptationSets.length > 0));
}

const liveFetcher: RemoteFetcher = async (url, timeoutMs) => {
  assertPublicUrl(url);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const started = Date.now();
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      cache: "no-store",
      headers: { "User-Agent": "SpliceCheck/0.1 (ad-signalling inspector)" },
    });
    const text = await res.text();
    return { ok: res.ok, status: res.status, text, ms: Date.now() - started };
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
 * A remote document is a Period fragment rather than a whole MPD, so it is
 * wrapped before parsing. Services differ on whether they return a bare
 * <Period>, several of them, or an MPD containing them.
 */
function parseRemote(text: string, baseUri: string): DashPeriod[] {
  const trimmed = text.trim();
  const wrapped = /<MPD[\s>]/.test(trimmed)
    ? trimmed
    : `<?xml version="1.0"?><MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" minBufferTime="PT2S">${trimmed.replace(/^<\?xml[^>]*\?>/, "")}</MPD>`;
  return parseMpd(wrapped, baseUri).periods;
}

export async function resolveRemotePeriods(
  mpd: MpdDocument,
  options: XlinkOptions = {},
): Promise<XlinkReport> {
  const opts = { ...DEFAULTS, ...options };
  const fetcher = options.fetcher ?? liveFetcher;
  const report: XlinkReport = { attempted: 0, resolved: 0, resolutions: [], findings: [] };
  const add = (severity: Finding["severity"], code: string, title: string, detail: string) =>
    report.findings.push({ severity, code, title, detail });

  const remote = mpd.periods.filter((p) => p.xlinkHref).slice(0, opts.maxPeriods);
  if (remote.length === 0) return report;

  const contentCodecs = contentSignature(mpd);

  for (const p of remote) {
    report.attempted++;
    const href = new URL(p.xlinkHref!, mpd.uri).toString();
    const actuate = p.xlinkActuate ?? "onRequest";
    const res = await fetcher(href, opts.timeoutMs);

    const r: XlinkResolution = {
      periodId: p.id,
      href,
      actuate,
      ok: res.ok,
      status: res.status,
      ms: res.ms,
      error: res.error,
      declaredDuration: p.declaredDuration,
    };

    if (!res.ok || !res.text) {
      add(
        "error",
        "XLINK_RESOLVE_FAILED",
        `Remote Period ${p.id ?? "?"} did not resolve${res.status ? ` (HTTP ${res.status})` : ""}`,
        `The ad decision service at ${href} ${res.error ?? `answered HTTP ${res.status}`} after ${res.ms}ms. A player reaching this Period gets nothing to play: depending on the client that is a stall, a skip, or a jump straight to the content after the break. The avail is lost, and nothing in the manifest would have told you.`,
      );
      report.resolutions.push(r);
      continue;
    }

    let periods: DashPeriod[];
    try {
      periods = parseRemote(res.text, href);
    } catch (e) {
      r.error = e instanceof Error ? e.message : String(e);
      add(
        "error",
        "XLINK_RESOLVE_UNPARSEABLE",
        `Remote Period ${p.id ?? "?"} returned something that is not a Period`,
        `The service answered in ${res.ms}ms, but what came back does not parse as DASH: ${r.error}. A resolution that returns a body a client cannot read fails exactly like one that returns nothing, and is harder to notice because the request itself succeeded.`,
      );
      report.resolutions.push(r);
      continue;
    }

    report.resolved++;
    r.periodsReturned = periods.length;
    r.resolvedDuration = periods.reduce(
      (n, x) => n + (x.declaredDuration ?? x.mediaDuration ?? 0),
      0,
    );
    r.resolvedCodecs = codecSignature(periods);

    if (periods.length === 0) {
      add(
        "warning",
        "XLINK_RESOLVED_EMPTY",
        `Remote Period ${p.id ?? "?"} resolved to nothing`,
        `The service answered in ${res.ms}ms with a valid document containing no Periods. This is how an unfilled avail is supposed to look — the break collapses and content resumes — so it is not a fault in itself. It is, though, inventory that went unsold, and it is invisible from the manifest alone.`,
      );
    }

    if (res.ms > LATE_MS) {
      add(
        "warning",
        "XLINK_RESOLVE_SLOW",
        `Remote Period ${p.id ?? "?"} took ${(res.ms / 1000).toFixed(1)}s to resolve`,
        `The ad decision took ${res.ms}ms. With xlink:actuate="${actuate}" that time is spent ${
          actuate === "onRequest" ? "at the point playback reaches the avail, so the player has nothing to show until it completes" : "on every manifest refresh"
        }. A decision slower than a couple of seconds arrives after the moment it was needed, and the player fills the gap with a stall or by skipping the break.`,
      );
    }

    if (
      p.declaredDuration !== undefined &&
      r.resolvedDuration !== undefined &&
      r.resolvedDuration > 0 &&
      Math.abs(r.resolvedDuration - p.declaredDuration) > 0.5
    ) {
      const delta = r.resolvedDuration - p.declaredDuration;
      add(
        "error",
        "XLINK_DURATION_MISMATCH",
        `Remote Period ${p.id ?? "?"} resolved to ${r.resolvedDuration.toFixed(1)}s against a declared ${p.declaredDuration.toFixed(1)}s`,
        `The placeholder reserved ${p.declaredDuration.toFixed(1)}s and the service returned ${r.resolvedDuration.toFixed(1)}s — ${Math.abs(delta).toFixed(1)}s ${delta > 0 ? "more" : "less"}. Every Period after this one is laid out against the declared figure, so resolution shifts the timeline by that amount: ${delta > 0 ? "the ad runs over and the content after it is cut" : "the break returns early and the gap shows as a stall or a freeze"}.`,
      );
    }

    if (contentCodecs.length && r.resolvedCodecs?.length) {
      const shared = r.resolvedCodecs.filter((c) => contentCodecs.includes(c));
      if (shared.length === 0) {
        add(
          "warning",
          "XLINK_CODEC_MISMATCH",
          `Remote Period ${p.id ?? "?"} returned content encoded differently from the programme`,
          `The resolved Period presents ${r.resolvedCodecs.join(", ")} while the programme around it presents ${contentCodecs.join(", ")}. A client has to tear down and re-initialise its decoders at both ends of the break, which is the black frame or audio drop that gets reported as "the ad broke the stream" — and it is the ad service's encode, not the packager's, that caused it.`,
        );
      }
    }

    report.resolutions.push(r);
  }

  return report;
}
