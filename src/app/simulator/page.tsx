"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Finding } from "@/lib/analyze";
import type { AvailStatus, PipelineComparison } from "@/lib/pipeline";
import type { RunResult } from "@/lib/runner";
import type { SimConfig, Stage } from "@/lib/sim/chain";
import type { EncoderSignal } from "@/lib/sim/timeline";
import type { StitchedAvail } from "@/lib/sim/ssai";

interface SimResponse {
  config: SimConfig;
  stages: Stage[];
  signals: EncoderSignal[];
  avails: { id: number; startSec: number; durationSec: number; snappedStartSec: number; snappedDurationSec: number }[];
  segmentCount: number;
  ssai: { avails: StitchedAvail[]; beacons: { availId: number; creative: string; event: string; atSec: number }[]; uri: string };
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
const FAULTS: { key: string; label: string; blurb: string; stage: string }[] = [
  { key: "invalidCrc", label: "Corrupt the CRC", blurb: "The encoder emits a section receivers will reject.", stage: "Encoder" },
  { key: "availOffBoundary", label: "Splice mid-segment", blurb: "The schedule asks for a break the packager cannot land on.", stage: "Encoder" },
  { key: "dropCueIn", label: "Drop the CUE-IN", blurb: "The break opens and is never closed.", stage: "Packaging" },
  { key: "noDiscontinuity", label: "No discontinuity", blurb: "Signalling with no timeline break behind it.", stage: "Packaging" },
  { key: "untranscribedAvail", label: "Lose the first avail", blurb: "A signalled break never reaches the manifest.", stage: "Packaging" },
  { key: "shortWindow", label: "Shorten the DVR", blurb: "The window opens part-way through a break.", stage: "Origin" },
  { key: "stalled", label: "Stall the origin", blurb: "A valid manifest that has stopped advancing.", stage: "Origin" },
  { key: "dropDiscontinuity", label: "Splice without a discontinuity", blurb: "Ads spliced in with no decoder reset.", stage: "SSAI" },
];

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

const isMarker = (l: string) =>
  l.startsWith("#EXT-X-CUE") || l.startsWith("#EXT-X-DATERANGE") || l.startsWith("#EXT-OATCLS");

function lineClass(l: string): string {
  if (isMarker(l)) return "block text-accent";
  // DISCONTINUITY-SEQUENCE is a header count, not a splice.
  if (l === "#EXT-X-DISCONTINUITY") return "block text-warn";
  if (l.startsWith("ads/")) return "block text-ok";
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
  const [faults, setFaults] = useState<Record<string, boolean>>({});
  const [stage, setStage] = useState<Stage["id"]>("packager");
  const [data, setData] = useState<SimResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        signalStyle,
        markerStyle,
        stitchMode,
        faults: {
          ...Object.fromEntries(
            Object.entries(faults).filter(([k, v]) => v && k !== "untranscribedAvail"),
          ),
          ...(faults.untranscribedAvail ? { untranscribedAvail: 1001 } : {}),
        },
      };
      const res = await fetch("/api/simulate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? "Simulation failed");
      setData(j);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Simulation failed");
    } finally {
      setBusy(false);
    }
  }, [signalStyle, markerStyle, stitchMode, faults]);

  useEffect(() => {
    void run();
  }, [run]);

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
          packager transcribing it into HLS, an origin windowing it, and an ad service stitching
          into the avails. Every manifest below is generated here, and then handed to the same
          inspector this site points at live streams — so you can see a fault introduced and caught
          in the same breath.
        </p>
      </header>

      <section className="mb-6 rounded-lg border border-edge bg-panel p-5">
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Encoder signalling">
            <select className={SELECT} value={signalStyle} onChange={(e) => setSignalStyle(e.target.value as never)}>
              <option value="time_signal">time_signal + segmentation descriptor</option>
              <option value="splice_insert">splice_insert</option>
            </select>
          </Field>
          <Field label="Packager markers">
            <select className={SELECT} value={markerStyle} onChange={(e) => setMarkerStyle(e.target.value as never)}>
              <option value="both">DATERANGE and CUE-OUT</option>
              <option value="daterange">EXT-X-DATERANGE only</option>
              <option value="cue-out">EXT-X-CUE-OUT only</option>
            </select>
          </Field>
          <Field label="Ad service behaviour">
            <select className={SELECT} value={stitchMode} onChange={(e) => setStitchMode(e.target.value)}>
              {STITCH_MODES.map((m) => (
                <option key={m.value} value={m.value}>{m.label}</option>
              ))}
            </select>
          </Field>
        </div>
        <p className="mt-2 text-xs text-muted">
          {STITCH_MODES.find((m) => m.value === stitchMode)?.blurb}
        </p>

        <div className="mt-5 border-t border-edge pt-4">
          <p className="mb-3 text-[11px] uppercase tracking-wider text-muted">Inject a fault</p>
          <div className="grid gap-2 sm:grid-cols-2">
            {FAULTS.map((f) => (
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
        <>
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
              <h2 className="mb-1 text-sm font-medium text-foreground">The inspector on the origin manifest</h2>
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
          </section>

          {data.ssai.beacons.length > 0 && (
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
        </>
      )}

      {busy && !data && <p className="text-sm text-muted">Running the chain…</p>}
    </div>
  );
}
