"use client";

import { useEffect, useRef, useState } from "react";
import type { Finding } from "@/lib/analyze";
import type { AvailStatus, PipelineComparison } from "@/lib/pipeline";
import type { RunResult } from "@/lib/runner";
import type { SimConfig, Stage } from "@/lib/sim/chain";
import type { EncoderSignal } from "@/lib/sim/timeline";
import type { StitchedAvail } from "@/lib/sim/ssai";
import type { ClientEvent, CsaiResult } from "@/lib/sim/csai";

interface SimResponse {
  config: SimConfig;
  stages: Stage[];
  signals: EncoderSignal[];
  avails: { id: number; startSec: number; durationSec: number; snappedStartSec: number; snappedDurationSec: number }[];
  segmentCount: number;
  ssai: { avails: StitchedAvail[]; beacons: { availId: number; creative: string; event: string; atSec: number }[]; uri: string };
  csai?: CsaiResult;
  analysis: {
    origin: RunResult | { error: string };
    ssai: RunResult | { error: string };
    comparison: PipelineComparison | { error: string };
  };
}

const STATUS_CHIP: Record<AvailStatus, string> = {
  filled: "border-ok-line bg-ok-soft text-ok",
  "under-filled": "border-warn-line bg-warn-soft text-warn",
  "over-filled": "border-warn-line bg-warn-soft text-warn",
  passthrough: "border-danger-line bg-danger-soft text-danger",
  "not-stitched": "border-danger-line bg-danger-soft text-danger",
  unsignalled: "border-info-line bg-info-soft text-info",
  unmeasurable: "border-edge bg-raise text-muted",
};

const SEV_DOT: Record<string, string> = { error: "bg-danger", warning: "bg-warn", info: "bg-info" };

/** Each fault is a real failure seen in production, not an arbitrary switch. */
interface Fault {
  key: string;
  label: string;
  blurb: string;
  stage: string;
  /** Conditions that must all hold for this fault to be offered. */
  requires?: { protocol?: "hls" | "dash"; adMode?: "ssai" | "csai" };
}

const FAULTS: Fault[] = [
  { key: "invalidCrc", label: "Corrupt the CRC", blurb: "The encoder emits a section receivers will reject.", stage: "Encoder" },
  { key: "availOffBoundary", label: "Splice mid-segment", blurb: "The schedule asks for a break the packager cannot land on.", stage: "Encoder" },
  { key: "dropCueIn", label: "Drop the CUE-IN", blurb: "The break opens and is never closed.", stage: "Packaging", requires: { protocol: "hls" } },
  { key: "noDiscontinuity", label: "No discontinuity", blurb: "Signalling with no timeline break behind it.", stage: "Packaging", requires: { protocol: "hls" } },
  { key: "untranscribedAvail", label: "Lose the first avail", blurb: "A signalled break never reaches the manifest.", stage: "Packaging" },
  { key: "shortWindow", label: "Shorten the DVR", blurb: "The window opens part-way through a break.", stage: "Origin" },
  { key: "stalled", label: "Stall the origin", blurb: "A valid manifest that has stopped advancing.", stage: "Origin" },
  { key: "dropDiscontinuity", label: "Splice without a discontinuity", blurb: "Ads spliced in with no decoder reset.", stage: "SSAI", requires: { protocol: "hls", adMode: "ssai" } },
  { key: "noPeriodContinuity", label: "No period continuity", blurb: "Players re-initialise the decoder at every ad transition.", stage: "SSAI", requires: { protocol: "dash", adMode: "ssai" } },
  { key: "periodGap", label: "Gap between Periods", blurb: "The next Period starts later than the previous one ended.", stage: "SSAI", requires: { protocol: "dash", adMode: "ssai" } },
  { key: "dropPresentationTimeOffset", label: "Drop @presentationTimeOffset", blurb: "Segment numbering no longer maps to the presentation timeline.", stage: "Packaging", requires: { protocol: "dash" } },
  { key: "adBlocked", label: "Ad request blocked", blurb: "A blocklist stops the call before it leaves the device.", stage: "CSAI", requires: { adMode: "csai" } },
  { key: "adServerTimeout", label: "Ad server times out", blurb: "No response inside the playback deadline.", stage: "CSAI", requires: { adMode: "csai" } },
  { key: "creativeFailsToLoad", label: "Creative fails to load", blurb: "The auction is won and the CDN does not deliver.", stage: "CSAI", requires: { adMode: "csai" } },
];

const EVENT_STYLE: Record<ClientEvent["kind"], string> = {
  content: "border-edge bg-raise text-muted",
  request: "border-info-line bg-info-soft text-info",
  ad: "border-ok-line bg-ok-soft text-ok",
  beacon: "border-edge bg-input text-muted",
  resume: "border-edge bg-raise text-muted",
  failure: "border-danger-line bg-danger-soft text-danger",
};

const STITCH_MODES: { value: string; label: string; blurb: string }[] = [
  { value: "fill", label: "Fills the avail", blurb: "The pod covers the break exactly." },
  { value: "under-fill", label: "Under-fills", blurb: "Not enough creative; an early return to programme." },
  { value: "over-fill", label: "Over-runs", blurb: "The pod runs past the break and cuts content." },
  { value: "passthrough", label: "Passes through", blurb: "Opens the break and leaves the programme in it." },
  { value: "drop-markers", label: "Stitches nothing", blurb: "Consumes the signalling and emits no break." },
];

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[11px] uppercase tracking-wider text-muted">{label}</span>
      {children}
    </label>
  );
}

const SELECT =
  "rounded-md border border-edge bg-input px-2.5 py-1.5 text-sm text-foreground focus:border-accent focus:outline-none";

const isMarker = (l: string) => {
  const t = l.trim();
  return (
    t.startsWith("#EXT-X-CUE") ||
    t.startsWith("#EXT-X-DATERANGE") ||
    t.startsWith("#EXT-OATCLS") ||
    t.startsWith("<EventStream") ||
    t.startsWith("<Event ") ||
    t.startsWith("<scte35:Signal") ||
    t.startsWith("<Tracking ") ||
    t.startsWith("<Impression")
  );
};

function lineClass(l: string): string {
  const t = l.trim();
  if (isMarker(l)) return "block text-accent";
  // DISCONTINUITY-SEQUENCE is a header count, not a splice.
  if (t === "#EXT-X-DISCONTINUITY" || t.startsWith("<Period ")) return "block text-warn";
  if (t.startsWith("ads/") || t.startsWith("<AssetIdentifier") || t.startsWith("<SupplementalProperty") || t.startsWith("<Ad "))
    return "block text-ok";
  return "block";
}

/**
 * A packaged programme is mostly unremarkable segments, and the break is the
 * reason anyone is looking, so the view opens on the first marker rather than
 * at the top.
 */
function Manifest({ text }: { text: string }) {
  const box = useRef<HTMLPreElement>(null);
  const lines = text.split("\n");
  const firstMarker = lines.findIndex(isMarker);

  useEffect(() => {
    const el = box.current;
    if (!el || firstMarker < 0) return;
    const target = el.children[Math.max(0, firstMarker - 4)] as HTMLElement | undefined;
    el.scrollTop = target ? target.offsetTop - el.offsetTop : 0;
  }, [text, firstMarker]);

  return (
    <>
      <pre
        ref={box}
        className="max-h-96 overflow-auto rounded-md border border-edge bg-input p-3 text-[11.5px] leading-relaxed text-soft"
      >
        {lines.map((line, i) => (
          <span key={i} className={lineClass(line)}>
            {line || "\u00a0"}
          </span>
        ))}
      </pre>
      {firstMarker > 8 && (
        <p className="mt-1.5 text-[11px] text-muted">
          {lines.length} lines; scrolled to the first marker at line {firstMarker + 1}.
        </p>
      )}
    </>
  );
}

function findingsOf(r: RunResult | { error: string }): Finding[] {
  if ("error" in r) return [];
  return r.renditions.flatMap((x) => x.findings).concat(r.crossFindings);
}

export default function SimulatorPage() {
  const [signalStyle, setSignalStyle] = useState<"time_signal" | "splice_insert">("time_signal");
  const [markerStyle, setMarkerStyle] = useState<"both" | "daterange" | "cue-out">("both");
  const [stitchMode, setStitchMode] = useState("fill");
  const [protocol, setProtocol] = useState<"hls" | "dash">("hls");
  const [adMode, setAdMode] = useState<"ssai" | "csai">("ssai");
  const [faults, setFaults] = useState<Record<string, boolean>>({});
  const [stage, setStage] = useState<Stage["id"]>("packager");
  const [result, setResult] = useState<{ key: string; data: SimResponse } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const body = {
    signalStyle,
    markerStyle,
    stitchMode,
    protocol,
    adMode,
    faults: {
      ...Object.fromEntries(Object.entries(faults).filter(([k, v]) => v && k !== "untranscribedAvail")),
      ...(faults.untranscribedAvail ? { untranscribedAvail: 1001 } : {}),
    },
  };
  // The request is fully described by the controls, so the controls are the
  // cache key: the view is stale exactly when the key it was fetched for is no
  // longer the current one. Deriving it this way means the effect never has to
  // set state synchronously to say "loading".
  const key = JSON.stringify(body);
  const data = result?.data ?? null;
  const busy = result?.key !== key;

  useEffect(() => {
    const ctl = new AbortController();
    (async () => {
      try {
        const res = await fetch("/api/simulate", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: key,
          signal: ctl.signal,
        });
        const j = await res.json();
        if (ctl.signal.aborted) return;
        if (!res.ok) throw new Error(j.error ?? "Simulation failed");
        setResult({ key, data: j });
        setError(null);
      } catch (e) {
        if (ctl.signal.aborted) return;
        setError(e instanceof Error ? e.message : "Simulation failed");
      }
    })();
    return () => ctl.abort();
  }, [key]);

  const current = data?.stages.find((s) => s.id === stage);
  const comparison = data && !("error" in data.analysis.comparison) ? data.analysis.comparison : null;
  const originFindings = data ? findingsOf(data.analysis.origin) : [];
  const worst = originFindings.some((f) => f.severity === "error")
    ? "error"
    : originFindings.some((f) => f.severity === "warning")
      ? "warning"
      : "clean";

  return (
    <div className="mx-auto max-w-5xl px-6 py-10">
      <header className="mb-8">
        <p className="text-[11px] uppercase tracking-wider text-accent">Simulator</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-foreground">
          Build a stream, then break it
        </h1>
        <p className="mt-3 max-w-2xl text-sm leading-relaxed text-soft">
          A synthetic channel run through the whole chain: an encoder emitting real SCTE-35, a
          packager transcribing it into HLS or DASH, an origin windowing it, and an ad inserted
          either server-side into the manifest or client-side in the player. Every manifest below is
          generated here, and then handed to the same inspector this site points at live streams —
          so you can see a fault introduced and caught in the same breath.
        </p>
      </header>

      <section className="mb-6 rounded-lg border border-edge bg-panel p-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Delivery">
            <select className={SELECT} value={protocol} onChange={(e) => setProtocol(e.target.value as never)}>
              <option value="hls">HLS</option>
              <option value="dash">DASH</option>
            </select>
          </Field>
          <Field label="Ad insertion">
            <select className={SELECT} value={adMode} onChange={(e) => setAdMode(e.target.value as never)}>
              <option value="ssai">Server-side — the manifest is rewritten</option>
              <option value="csai">Client-side — the player fetches the ad</option>
            </select>
          </Field>
        </div>

        <div className="mt-4 grid gap-4 sm:grid-cols-3">
          <Field label="Encoder signalling">
            <select className={SELECT} value={signalStyle} onChange={(e) => setSignalStyle(e.target.value as never)}>
              <option value="time_signal">time_signal + segmentation descriptor</option>
              <option value="splice_insert">splice_insert</option>
            </select>
          </Field>
          <Field label="Packager markers">
            <select
              className={SELECT}
              value={markerStyle}
              disabled={protocol === "dash"}
              onChange={(e) => setMarkerStyle(e.target.value as never)}
            >
              <option value="both">DATERANGE and CUE-OUT</option>
              <option value="daterange">EXT-X-DATERANGE only</option>
              <option value="cue-out">EXT-X-CUE-OUT only</option>
            </select>
          </Field>
          <Field label="Ad service behaviour">
            <select className={SELECT} value={stitchMode} disabled={adMode === "csai"} onChange={(e) => setStitchMode(e.target.value)}>
              {STITCH_MODES.map((m) => (
                <option key={m.value} value={m.value}>{m.label}</option>
              ))}
            </select>
          </Field>
        </div>
        <p className="mt-2 text-xs text-muted">
          {protocol === "dash"
            ? "DASH carries the signalling in a Period-level EventStream; the ad service splits the presentation into Periods rather than rewriting tags."
            : adMode === "csai"
              ? "Client-side leaves the manifest untouched — the player reads the marker and fetches the ad itself."
              : STITCH_MODES.find((m) => m.value === stitchMode)?.blurb}
        </p>

        <div className="mt-5 border-t border-edge pt-4">
          <p className="mb-3 text-[11px] uppercase tracking-wider text-muted">Inject a fault</p>
          <div className="grid gap-2 sm:grid-cols-2">
            {FAULTS.filter(
              (f) =>
                (!f.requires?.protocol || f.requires.protocol === protocol) &&
                (!f.requires?.adMode || f.requires.adMode === adMode),
            ).map((f) => (
              <label key={f.key} className="flex cursor-pointer items-start gap-2.5 rounded-md p-1.5 hover:bg-raise">
                <input
                  id={`fault-${f.key}`}
                  type="checkbox"
                  className="mt-0.5 accent-accent"
                  checked={!!faults[f.key]}
                  onChange={(e) => setFaults((s) => ({ ...s, [f.key]: e.target.checked }))}
                />
                <span className="min-w-0">
                  <span className="block text-sm text-foreground">
                    {f.label}
                    <span className="ml-2 text-[10px] uppercase tracking-wider text-muted">{f.stage}</span>
                  </span>
                  <span className="block text-xs text-muted">{f.blurb}</span>
                </span>
              </label>
            ))}
          </div>
        </div>
      </section>

      {error && (
        <div className="mb-6 rounded-lg border border-danger-line bg-danger-soft p-4 text-sm text-danger">{error}</div>
      )}

      {data && (
        <div className={busy ? "opacity-60 transition-opacity" : "transition-opacity"}>
          <section className="mb-6 grid gap-2 sm:grid-cols-4">
            {data.stages.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => setStage(s.id)}
                aria-current={stage === s.id ? "true" : undefined}
                className={`rounded-lg border p-3 text-left transition-colors ${
                  stage === s.id ? "border-accent bg-raise" : "border-edge bg-panel hover:bg-raise"
                }`}
              >
                <span className="block text-sm font-medium text-foreground">{s.title}</span>
                <span className="mt-1 block text-xs leading-snug text-muted">{s.note}</span>
              </button>
            ))}
          </section>

          {stage === "encoder" ? (
            <section className="mb-6 rounded-lg border border-edge bg-panel p-5">
              <h2 className="mb-1 text-sm font-medium text-foreground">SCTE-35 as the encoder emits it</h2>
              <p className="mb-4 text-xs text-muted">
                Written by the simulator and decoded by this project&rsquo;s own parser. The CRC is
                computed the way a receiver checks it.
              </p>
              <div className="flex flex-col gap-3">
                {data.signals.map((s, i) => (
                  <div key={i} className="rounded-md border border-edge bg-input p-3">
                    <div className="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs">
                      <span className={`rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wider ${
                        s.kind === "out" ? "bg-accent text-on-accent" : "bg-raise text-muted"
                      }`}>
                        {s.kind === "out" ? "break start" : "break end"}
                      </span>
                      <span className="text-soft">{s.command}</span>
                      <span className="text-muted">avail {s.availId}</span>
                      <span className="text-muted">media {s.mediaSec.toFixed(1)}s</span>
                      <span className="text-muted">PTS {s.pts}</span>
                      {s.durationSec !== undefined && <span className="text-muted">duration {s.durationSec}s</span>}
                      {s.corrupted && <span className="text-danger">CRC corrupted</span>}
                    </div>
                    <code className="block break-all text-[11px] leading-relaxed text-soft">{s.base64}</code>
                  </div>
                ))}
              </div>
            </section>
          ) : (
            current?.text && (
              <section className="mb-6">
                <div className="mb-2 flex items-baseline justify-between">
                  <h2 className="text-sm font-medium text-foreground">{current.title} output</h2>
                  <span className="text-xs text-muted">{current.uri}</span>
                </div>
                <Manifest text={current.text} />
              </section>
            )
          )}

          <section className="grid gap-4 sm:grid-cols-2">
            <div className="rounded-lg border border-edge bg-panel p-5">
              <h2 className="mb-1 text-sm font-medium text-foreground">
                The inspector on the {protocol === "dash" ? "MPD" : "origin manifest"}
              </h2>
              <p className="mb-3 text-xs text-muted">
                {worst === "clean"
                  ? "Nothing above information — the stream is correct."
                  : `${originFindings.filter((f) => f.severity !== "info").length} finding(s) worth acting on.`}
              </p>
              {originFindings.length === 0 ? (
                <p className="text-sm text-muted">No findings.</p>
              ) : (
                <ul className="flex flex-col gap-2.5">
                  {originFindings.map((f, i) => (
                    <li key={i} className="flex gap-2.5">
                      <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${SEV_DOT[f.severity]}`} />
                      <span className="min-w-0">
                        <span className="block text-sm text-foreground">{f.title}</span>
                        <span className="block font-mono text-[10px] uppercase tracking-wider text-muted">{f.code}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {data.csai ? (
              <div className="rounded-lg border border-edge bg-panel p-5">
                <h2 className="mb-1 text-sm font-medium text-foreground">What happens in the player</h2>
                <p className="mb-3 text-xs text-muted">
                  There is no stitched manifest to compare — the origin&rsquo;s bytes reach the player
                  unchanged, and everything below happens on the device.
                </p>
                <ol className="flex flex-col gap-1.5">
                  {data.csai.events
                    .filter((e) => e.kind !== "beacon")
                    .map((e, i) => (
                      <li key={i} className="flex items-baseline gap-2.5">
                        <span className="w-12 shrink-0 text-right font-mono text-[11px] text-muted">
                          {e.atSec.toFixed(0)}s
                        </span>
                        <span className={`rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wider ${EVENT_STYLE[e.kind]}`}>
                          {e.kind}
                        </span>
                        <span className="min-w-0 text-sm text-foreground">{e.label}</span>
                      </li>
                    ))}
                </ol>
                <p className="mt-4 border-t border-edge pt-3 text-xs text-muted">
                  {data.csai.deliveredSec}s of {data.csai.signalledSec}s delivered ·{" "}
                  <span
                    className={
                      data.csai.outcome === "filled"
                        ? "text-ok"
                        : data.csai.outcome === "empty"
                          ? "text-danger"
                          : "text-warn"
                    }
                  >
                    {data.csai.outcome}
                  </span>
                </p>
                <ul className="mt-3 flex flex-col gap-1.5">
                  {data.csai.notes.map((n, i) => (
                    <li key={i} className="text-xs leading-relaxed text-soft">
                      {n}
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
            <div className="rounded-lg border border-edge bg-panel p-5">
              <h2 className="mb-1 text-sm font-medium text-foreground">Packager output against SSAI output</h2>
              <p className="mb-3 text-xs text-muted">
                The same pipeline comparison the tool runs on real streams, over the session window.
              </p>
              {!comparison ? (
                <p className="text-sm text-muted">No comparison available.</p>
              ) : comparison.avails.length === 0 ? (
                <p className="text-sm text-soft">
                  No avail appears on either side — the inventory was lost before anything could
                  act on it.
                </p>
              ) : (
                <ul className="flex flex-col gap-3">
                  {comparison.avails.map((a) => (
                    <li key={a.index} className="flex items-center gap-3">
                      <span className={`rounded border px-2 py-0.5 text-[11px] ${STATUS_CHIP[a.status]}`}>
                        {a.status}
                      </span>
                      <span className="text-xs text-muted">
                        signalled {a.signalledDuration?.toFixed(0) ?? "—"}s · delivered{" "}
                        {a.stitchedDuration?.toFixed(0) ?? "—"}s
                        {a.fillRatio !== undefined && ` · ${Math.round(a.fillRatio * 100)}%`}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              {comparison && (
                <p className="mt-4 border-t border-edge pt-3 text-xs text-muted">
                  Fill rate {Math.round(comparison.summary.fillRate * 100)}% · verdict{" "}
                  <span className={comparison.summary.verdict === "pass" ? "text-ok" : comparison.summary.verdict === "warn" ? "text-warn" : "text-danger"}>
                    {comparison.summary.verdict}
                  </span>
                </p>
              )}
            </div>
            )}
          </section>

          {data.csai && (
            <section className="mt-4 rounded-lg border border-edge bg-panel p-5">
              <h2 className="mb-1 text-sm font-medium text-foreground">Beacons the player fires</h2>
              <p className="mb-3 text-xs text-muted">
                From the device, so they reflect what actually played — and so a blocklist can stop
                every one of them. That is the trade the two approaches make against each other.
              </p>
              <div className="flex flex-wrap gap-1.5">
                {data.csai.events
                  .filter((e) => e.kind === "beacon")
                  .slice(0, 24)
                  .map((e, i) => (
                    <span key={i} className="rounded border border-edge bg-input px-2 py-0.5 font-mono text-[10px] text-muted">
                      {e.label}
                    </span>
                  ))}
                {data.csai.events.filter((e) => e.kind === "beacon").length === 0 && (
                  <span className="text-xs text-danger">None — nothing played, so nothing was counted.</span>
                )}
              </div>
            </section>
          )}

          {!data.csai && data.ssai.beacons.length > 0 && (
            <section className="mt-4 rounded-lg border border-edge bg-panel p-5">
              <h2 className="mb-1 text-sm font-medium text-foreground">Beacons the ad service fires</h2>
              <p className="mb-3 text-xs text-muted">
                Server-side, because the client cannot see the ads. This is the measurement
                trade-off: robust against blocking, blind to whether anyone was watching.
              </p>
              <div className="flex flex-wrap gap-1.5">
                {data.ssai.beacons.slice(0, 20).map((b, i) => (
                  <span key={i} className="rounded border border-edge bg-input px-2 py-0.5 font-mono text-[10px] text-muted">
                    {b.creative} {b.event}
                  </span>
                ))}
              </div>
            </section>
          )}
        </div>
      )}

      {busy && !data && <p className="text-sm text-muted">Running the chain…</p>}
    </div>
  );
}
