"use client";


import { useState } from "react";
import type { AvailComparison, AvailStatus, PipelineComparison } from "@/lib/pipeline";
import type { Finding } from "@/lib/analyze";
import { comparisonToMarkdown, reportFilename } from "@/lib/report";

const STATUS: Record<AvailStatus, { label: string; chip: string; blurb: string }> = {
  filled: {
    label: "filled",
    chip: "border-ok-line bg-ok-soft text-ok",
    blurb: "Substituted content covers the avail",
  },
  "under-filled": {
    label: "under-filled",
    chip: "border-warn-line bg-warn-soft text-warn",
    blurb: "Short of the signalled duration — slate or an early return",
  },
  "over-filled": {
    label: "over-filled",
    chip: "border-warn-line bg-warn-soft text-warn",
    blurb: "Runs past the break — content after it is cut",
  },
  passthrough: {
    label: "passed through",
    chip: "border-danger-line bg-danger-soft text-danger",
    blurb: "Break opened but nothing was substituted",
  },
  "not-stitched": {
    label: "not stitched",
    chip: "border-danger-line bg-danger-soft text-danger",
    blurb: "Signalled upstream, absent from the output",
  },
  unsignalled: {
    label: "unsignalled",
    chip: "border-info-line bg-info-soft text-info",
    blurb: "In the output with nothing upstream asking for it",
  },
  unmeasurable: {
    label: "in progress",
    chip: "border-edge bg-raise text-muted",
    blurb: "Still open at the live edge",
  },
};

const SEV: Record<string, string> = {
  error: "bg-danger",
  warning: "bg-warn",
  info: "bg-info",
};

function secs(n: number | undefined) {
  return n === undefined ? "—" : `${n.toFixed(2).replace(/\.?0+$/, "")}s`;
}

function clock(pdt: number | undefined) {
  return pdt === undefined ? "—" : new Date(pdt).toISOString().slice(11, 19);
}

function FillBar({ a }: { a: AvailComparison }) {
  const ratio = Math.max(0, Math.min(a.fillRatio ?? (a.status === "not-stitched" ? 0 : 1), 1.4));
  const colour =
    a.status === "filled"
      ? "bg-ok"
      : a.status === "not-stitched" || a.status === "passthrough"
        ? "bg-danger"
        : "bg-warn";
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-raise">
      <div className={`h-full ${colour}`} style={{ width: `${Math.min(ratio, 1) * 100}%` }} />
    </div>
  );
}

/**
 * The same escape hatch the inspector has. A fill rate is a number somebody
 * has to argue about with a vendor, so it needs to leave the page with its
 * working attached.
 */
function ExportButtons({ comparison }: { comparison: PipelineComparison }) {
  const [copied, setCopied] = useState(false);

  function download(text: string, ext: string, type: string) {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = document.createElement("a");
    a.href = url;
    a.download = reportFilename(comparison.stitched.uri, ext);
    a.click();
    URL.revokeObjectURL(url);
  }

  async function copy() {
    const md = comparisonToMarkdown(comparison, { toolUrl: window.location.origin });
    try {
      await navigator.clipboard.writeText(md);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      download(md, "md", "text/markdown");
    }
  }

  const btn =
    "rounded-md border border-edge bg-panel px-2 py-1 text-[11px] text-soft transition-colors hover:bg-raise hover:text-foreground";

  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      <button type="button" className={btn} onClick={copy}>
        {copied ? "Copied" : "Copy report"}
      </button>
      <button
        type="button"
        className={btn}
        onClick={() => download(comparisonToMarkdown(comparison, { toolUrl: window.location.origin }), "md", "text/markdown")}
      >
        Markdown
      </button>
      <button
        type="button"
        className={btn}
        onClick={() => download(JSON.stringify(comparison, null, 2), "json", "application/json")}
      >
        JSON
      </button>
    </div>
  );
}

export default function Compare() {
  const [sourceUrl, setSourceUrl] = useState("");
  const [stitchedUrl, setStitchedUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<(PipelineComparison & { pair?: { label: string; note: string } }) | null>(null);

  async function run(pairId?: string) {
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/compare", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          pairId
            ? { pairId }
            : {
                source: { url: sourceUrl },
                stitched: { url: stitchedUrl },
                sourceLabel: "packager feed",
                stitchedLabel: "SSAI output",
              },
        ),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Comparison failed");
      setResult(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Comparison failed");
    } finally {
      setLoading(false);
    }
  }

  const verdictStyle =
    result?.summary.verdict === "fail"
      ? "border-danger-line bg-danger-soft"
      : result?.summary.verdict === "warn"
        ? "border-warn-line bg-warn-soft"
        : "border-ok-line bg-ok-soft";

  return (
    <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-10 sm:px-6">
      <header className="mb-8">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Pipeline comparison
          </h1>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-soft">
            Compare the signalling feed going into an ad-insertion service with the stitched output
            coming out of it, and see which avails were actually filled. The encoder team says the
            SCTE-35 was correct; the ad-tech team says the break never arrived. This puts the two
            streams side by side and settles it.
          </p>
        </div>

      </header>

      <section className="rounded-xl border border-edge bg-panel p-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-[11px] uppercase tracking-wide text-muted">
              Source — before insertion
            </span>
            <input
              value={sourceUrl}
              onChange={(e) => setSourceUrl(e.target.value)}
              placeholder="https://packager/live/master.m3u8"
              className="w-full rounded-lg border border-edge bg-input px-3 py-2 font-mono text-sm outline-none placeholder:text-muted/60 focus:border-accent"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-[11px] uppercase tracking-wide text-muted">
              Output — after insertion
            </span>
            <input
              value={stitchedUrl}
              onChange={(e) => setStitchedUrl(e.target.value)}
              placeholder="https://ssai/v1/session/master.m3u8"
              className="w-full rounded-lg border border-edge bg-input px-3 py-2 font-mono text-sm outline-none placeholder:text-muted/60 focus:border-accent"
            />
          </label>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button
            onClick={() => run()}
            disabled={loading || !sourceUrl.trim() || !stitchedUrl.trim()}
            className="rounded-lg bg-accent px-5 py-2 text-sm font-medium text-on-accent disabled:opacity-40"
          >
            {loading ? "Comparing…" : "Compare"}
          </button>
          <button
            onClick={() => run("ssai-demo")}
            className="rounded border border-edge px-3 py-1.5 text-xs text-muted hover:border-accent hover:text-foreground"
          >
            Run the worked example
          </button>
          <span className="text-[11px] text-muted">
            The two streams are aligned on wall clock, so they need not be the same protocol.
          </span>
        </div>
        {error && <p className="mt-2 text-sm text-danger">{error}</p>}
      </section>

      {result && (
        <>
          <div className={`mt-6 rounded-xl border px-4 py-4 ${verdictStyle}`}>
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div>
                <div className="text-[11px] uppercase tracking-wide text-muted">Fill rate</div>
                <div className="text-4xl font-semibold tabular-nums">
                  {(result.summary.fillRate * 100).toFixed(1)}%
                </div>
                <div className="mt-1 text-sm text-muted">
                  {secs(result.summary.stitchedSeconds)} substituted of {secs(result.summary.signalledSeconds)}{" "}
                  signalled across {result.summary.signalled} avail
                  {result.summary.signalled === 1 ? "" : "s"}
                </div>
                <ExportButtons comparison={result} />
              </div>
              <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-3">
                <Count label="filled" n={result.summary.filled} tone="text-ok" />
                <Count label="under-filled" n={result.summary.underFilled} tone="text-warn" />
                <Count label="over-filled" n={result.summary.overFilled} tone="text-warn" />
                <Count label="passed through" n={result.summary.passthrough} tone="text-danger" />
                <Count label="not stitched" n={result.summary.notStitched} tone="text-danger" />
                <Count label="unsignalled" n={result.summary.unsignalled} tone="text-info" />
              </div>
            </div>
            <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 font-mono text-[11px] text-muted">
              <span>
                {result.source.label} · {result.source.protocol} · {result.source.breakCount} breaks
              </span>
              <span>
                {result.stitched.label} · {result.stitched.protocol} · {result.stitched.breakCount} breaks
              </span>
            </div>
          </div>

          <section className="mt-6">
            <h2 className="mb-2 text-sm font-medium uppercase tracking-wide text-muted">Avail by avail</h2>
            <div className="overflow-x-auto rounded-xl border border-edge bg-panel">
              <table className="w-full text-left text-sm">
                <thead className="text-[11px] uppercase tracking-wide text-muted">
                  <tr className="border-b border-edge">
                    <th className="px-4 py-2 font-medium">At</th>
                    <th className="px-3 py-2 font-medium">Signalled</th>
                    <th className="px-3 py-2 font-medium">In output</th>
                    <th className="px-3 py-2 font-medium">Fill</th>
                    <th className="px-3 py-2 font-medium">Status</th>
                    <th className="px-3 py-2 font-medium">Substituted</th>
                    <th className="px-3 py-2 font-medium">Marked</th>
                  </tr>
                </thead>
                <tbody>
                  {result.avails.map((a) => (
                    <tr key={a.index} className="border-b border-edge/40 last:border-0">
                      <td className="px-4 py-2 font-mono text-xs">{clock(a.pdt)}</td>
                      <td className="px-3 py-2 font-mono text-xs">{secs(a.signalledDuration)}</td>
                      <td className="px-3 py-2 font-mono text-xs">{secs(a.stitchedDuration)}</td>
                      <td className="w-32 px-3 py-2">
                        <FillBar a={a} />
                        <span className="mt-1 block font-mono text-[10px] text-muted">
                          {a.fillRatio !== undefined ? `${Math.round(a.fillRatio * 100)}%` : "—"}
                        </span>
                      </td>
                      <td className="px-3 py-2">
                        <span className={`rounded border px-1.5 py-0.5 text-[10px] ${STATUS[a.status].chip}`}>
                          {STATUS[a.status].label}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-xs">
                        {a.substituted === undefined ? (
                          <span className="text-muted">—</span>
                        ) : a.substituted ? (
                          <span className="text-ok">yes</span>
                        ) : (
                          <span className="text-danger">no</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-xs">
                        {a.marked === undefined ? (
                          <span className="text-muted">—</span>
                        ) : a.marked ? (
                          <span className="text-ok">yes</span>
                        ) : (
                          <span className="text-warn">no</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {result.findings.length > 0 && (
            <section className="mt-6">
              <h2 className="mb-2 text-sm font-medium uppercase tracking-wide text-muted">Findings</h2>
              <div className="rounded-xl border border-edge bg-panel">
                {result.findings.map((f: Finding, i: number) => (
                  <div key={i} className="flex gap-3 border-b border-edge/70 px-4 py-3 last:border-0">
                    <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${SEV[f.severity]}`} />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-baseline gap-x-2">
                        <span className="font-medium">{f.title}</span>
                        <code className="rounded bg-raise px-1.5 py-0.5 font-mono text-[11px] text-muted">
                          {f.code}
                        </code>
                      </div>
                      <p className="mt-1 text-sm leading-relaxed text-soft">{f.detail}</p>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}
        </>
      )}

      <footer className="mt-16 border-t border-edge pt-4 text-xs leading-relaxed text-soft">
        Avails are matched on wall clock, within 6s. Substitution is inferred from the shape of the
        media paths inside the avail against the output&rsquo;s own surrounding content — evidence, not
        proof, and reported as such. Only the window both streams cover is compared.
      </footer>
    </main>
  );
}

function Count({ label, n, tone }: { label: string; n: number; tone: string }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className={`tabular-nums ${n > 0 ? tone : "text-muted"}`}>{n}</span>
      <span className="text-[11px] text-muted">{label}</span>
    </div>
  );
}
