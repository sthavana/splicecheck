"use client";

import { useState } from "react";
import type { Finding } from "@/lib/analyze";
import type { VastAnalysis, VmapDocument, WrapperChain, StreamProfile } from "@/lib/vast";

interface VastResponse extends VastAnalysis {
  kind: "vast";
  uri: string;
  profile: StreamProfile;
  chain?: WrapperChain;
}
interface VmapResponse {
  kind: "vmap";
  uri: string;
  vmap: VmapDocument;
  findings: Finding[];
}
type Result = VastResponse | VmapResponse;

const SEV: Record<string, { dot: string; chip: string }> = {
  error: { dot: "bg-danger", chip: "border-danger-line bg-danger-soft text-danger" },
  warning: { dot: "bg-warn", chip: "border-warn-line bg-warn-soft text-warn" },
  info: { dot: "bg-info", chip: "border-info-line bg-info-soft text-info" },
};

const SAMPLE = `<VAST version="4.2">
  <Ad id="4417"><InLine>
    <AdSystem>Simulated Decision Service</AdSystem>
    <AdTitle>Northbridge Motors</AdTitle>
    <Impression><![CDATA[https://ads.example/imp?c=4417]]></Impression>
    <Creatives><Creative><Linear>
      <Duration>00:00:45</Duration>
      <TrackingEvents><Tracking event="start"/></TrackingEvents>
      <MediaFiles>
        <MediaFile type="application/javascript" apiFramework="VPAID"><![CDATA[https://ads.example/vpaid.js]]></MediaFile>
        <MediaFile type="video/mp4" codec="hvc1.1.6.L93.B0" width="1920" height="1080" bitrate="9000"><![CDATA[https://cdn.ads.example/4417.mp4]]></MediaFile>
      </MediaFiles>
    </Linear></Creative></Creatives>
  </InLine></Ad>
</VAST>`;

function Findings({ findings }: { findings: Finding[] }) {
  if (findings.length === 0) {
    return (
      <p className="rounded-lg border border-ok-line bg-ok-soft px-4 py-3 text-sm text-ok">
        Nothing to report. The response is well formed, and fits the break and the stream it was
        checked against.
      </p>
    );
  }
  return (
    <ul className="flex flex-col gap-3">
      {findings.map((f, i) => (
        <li key={i} className="rounded-lg border border-edge bg-panel p-4">
          <div className="flex flex-wrap items-baseline gap-2">
            <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${SEV[f.severity].dot}`} />
            <span className="text-sm font-medium text-foreground">{f.title}</span>
            <span className="font-mono text-[10px] uppercase tracking-wider text-muted">{f.code}</span>
          </div>
          <p className="mt-1.5 text-sm leading-relaxed text-soft">{f.detail}</p>
        </li>
      ))}
    </ul>
  );
}

export default function VastPage() {
  const [mode, setMode] = useState<"paste" | "url">("paste");
  const [xml, setXml] = useState(SAMPLE);
  const [url, setUrl] = useState("");
  const [streamUrl, setStreamUrl] = useState("");
  const [availSeconds, setAvailSeconds] = useState("");
  const [follow, setFollow] = useState(false);
  const [serverSide, setServerSide] = useState(true);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/vast", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          xml: mode === "paste" ? xml : undefined,
          url: mode === "url" ? url : undefined,
          streamUrl: streamUrl.trim() || undefined,
          availSeconds: availSeconds ? Number(availSeconds) : undefined,
          follow,
          serverSide,
        }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? "Could not read that document");
      setResult(j);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
      setResult(null);
    } finally {
      setBusy(false);
    }
  }

  const input =
    "w-full rounded-md border border-edge bg-input px-3 py-2 text-sm text-foreground placeholder:text-muted focus:border-accent focus:outline-none";

  return (
    <main className="mx-auto w-full max-w-4xl flex-1 px-4 py-10 sm:px-6">
      <header className="mb-8">
        <p className="text-[11px] uppercase tracking-wider text-accent">Ad response</p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">VAST and VMAP</h1>
        <p className="mt-3 max-w-2xl text-sm leading-relaxed text-soft">
          SCTE-35 says an avail exists. VAST says what goes in it. An avail signalled perfectly and
          filled with a creative the packager cannot use is still an unfilled avail — and from the
          manifest it looks like a fault in the signalling. Paste a response, or give the tag URL,
          and it is checked against what server-side insertion can actually do.
        </p>
      </header>

      <section className="rounded-xl border border-edge bg-panel p-4">
        <div className="mb-3 flex gap-1 text-xs">
          {(["paste", "url"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={`rounded-md px-2.5 py-1.5 transition-colors ${
                mode === m ? "bg-raise-strong text-foreground" : "text-muted hover:text-foreground"
              }`}
            >
              {m === "paste" ? "Paste a response" : "Ad tag URL"}
            </button>
          ))}
        </div>

        {mode === "paste" ? (
          <textarea
            id="vast-xml"
            className={`${input} h-56 font-mono text-[12px]`}
            value={xml}
            onChange={(e) => setXml(e.target.value)}
            spellCheck={false}
          />
        ) : (
          <input
            id="vast-url"
            className={`${input} font-mono text-[12px]`}
            placeholder="https://ads.example/vast?pod=1"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
        )}

        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1.5">
            <span className="text-[11px] uppercase tracking-wider text-muted">
              Check against this stream&rsquo;s ladder
            </span>
            <input
              id="vast-stream"
              className={`${input} font-mono text-[12px]`}
              placeholder="https://origin.example/index.m3u8 (optional)"
              value={streamUrl}
              onChange={(e) => setStreamUrl(e.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-[11px] uppercase tracking-wider text-muted">Avail duration, seconds</span>
            <input
              id="vast-avail"
              className={input}
              placeholder="30 (optional)"
              inputMode="decimal"
              value={availSeconds}
              onChange={(e) => setAvailSeconds(e.target.value)}
            />
          </label>
        </div>

        <div className="mt-3 flex flex-col gap-2">
          <label className="flex cursor-pointer items-start gap-2 text-xs text-muted">
            <input id="vast-serverside" type="checkbox" className="mt-0.5" checked={serverSide} onChange={(e) => setServerSide(e.target.checked)} />
            <span>
              Judge it as server-side insertion. A stitcher has no JavaScript engine and picks a
              rendition up front, so an executable creative is unfillable by construction — untick
              this to check the same response as a client-side player would see it.
            </span>
          </label>
          <label className="flex cursor-pointer items-start gap-2 text-xs text-muted">
            <input id="vast-follow" type="checkbox" className="mt-0.5" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
            <span>
              Follow the wrapper chain. Makes real requests to the ad servers the document points at,
              and reports how many hops and how long they took against the decision budget.
            </span>
          </label>
        </div>

        <button
          type="button"
          onClick={run}
          disabled={busy}
          className="mt-4 rounded-md bg-accent px-3 py-1.5 text-sm text-on-accent transition-opacity disabled:opacity-60"
        >
          {busy ? "Checking…" : "Check the response"}
        </button>
      </section>

      {error && (
        <div className="mt-6 rounded-lg border border-danger-line bg-danger-soft px-4 py-3 text-sm text-danger">
          {error}
        </div>
      )}

      {result?.kind === "vast" && (
        <>
          <section className="mt-6 flex flex-wrap gap-2 text-xs">
            <span className="rounded border border-edge bg-panel px-2 py-1 text-soft">
              {result.adCount} ad{result.adCount === 1 ? "" : "s"}
            </span>
            <span className="rounded border border-edge bg-panel px-2 py-1 text-soft">
              {result.totalDurationSec.toFixed(1)}s of creative
            </span>
            {result.wrapperCount > 0 && (
              <span className="rounded border border-edge bg-panel px-2 py-1 text-soft">
                {result.wrapperCount} wrapper{result.wrapperCount === 1 ? "" : "s"}
              </span>
            )}
            {result.profile.codecs?.length ? (
              <span className="rounded border border-edge bg-panel px-2 py-1 text-muted">
                ladder: {result.profile.codecs.join(", ")}
              </span>
            ) : null}
          </section>

          {result.chain && result.chain.hops.length > 0 && (
            <section className="mt-6">
              <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">
                Wrapper chain — {result.chain.totalMs}ms across {result.chain.hops.length} hop
                {result.chain.hops.length === 1 ? "" : "s"}
              </h2>
              <ol className="rounded-lg border border-edge bg-panel divide-y divide-edge">
                {result.chain.hops.map((h) => (
                  <li key={h.depth} className="flex flex-wrap items-baseline gap-x-3 px-4 py-2 text-xs">
                    <span className="text-muted">hop {h.depth}</span>
                    <span className={`rounded border px-1.5 py-0.5 text-[10px] uppercase ${h.ok ? SEV.info.chip : SEV.error.chip}`}>
                      {h.ok ? `${h.adCount ?? 0} ad(s)` : "failed"}
                    </span>
                    <span className={h.ms > 1000 ? "text-warn" : "text-muted"}>{h.ms}ms</span>
                    <span className="min-w-0 break-all font-mono text-[11px] text-muted">{h.url}</span>
                  </li>
                ))}
              </ol>
            </section>
          )}

          <section className="mt-6">
            <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">Findings</h2>
            <Findings findings={result.findings} />
          </section>
        </>
      )}

      {result?.kind === "vmap" && (
        <>
          <section className="mt-6">
            <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">
              Schedule — {result.vmap.breaks.length} break{result.vmap.breaks.length === 1 ? "" : "s"}
            </h2>
            <ol className="rounded-lg border border-edge bg-panel divide-y divide-edge">
              {result.vmap.breaks.map((b, i) => (
                <li key={i} className="flex flex-wrap items-baseline gap-x-3 px-4 py-2 text-sm">
                  <span className="font-medium text-foreground">{b.id ?? `break ${i}`}</span>
                  <span className="font-mono text-xs text-muted">{b.timeOffset ?? "no offset"}</span>
                  <span className="text-xs text-muted">{b.breakType ?? "—"}</span>
                  <span className="min-w-0 break-all font-mono text-[11px] text-muted">
                    {b.adTagUri ?? (b.inline ? "inline VAST" : "no source")}
                  </span>
                </li>
              ))}
            </ol>
          </section>
          <section className="mt-6">
            <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">Findings</h2>
            <Findings findings={result.findings} />
          </section>
        </>
      )}
    </main>
  );
}
