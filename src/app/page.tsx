"use client";

import Link from "next/link";

import { useState } from "react";
import type { AnalysisResult, AdBreak, Finding, Interstitial, PeriodSummary, RenditionAnalysis } from "@/lib/analyze";
import type { SegmentProbe } from "@/lib/segments";

function PeriodTable({ periods }: { periods: PeriodSummary[] }) {
  const t0 = periods[0]?.start ?? 0;
  const maxGap = Math.max(0, ...periods.map((p) => Math.abs(p.gapToNext ?? 0)));
  return (
    <div data-shot="periods" className="rounded-lg border border-edge bg-panel">
      <div className="border-b border-edge px-4 py-2 text-[11px] uppercase tracking-wide text-muted">
        Period timeline — {periods.length} periods, {periods.filter((p) => p.isAd).length} carrying ad signalling
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead className="text-muted">
            <tr className="border-b border-edge/70">
              <th className="px-4 py-2 font-medium">Period</th>
              <th className="px-3 py-2 font-medium">Offset</th>
              <th className="px-3 py-2 font-medium">Duration</th>
              <th className="px-3 py-2 font-medium">Kind</th>
              <th className="px-3 py-2 font-medium">A/V skew</th>
              <th className="px-3 py-2 font-medium">Gap to next</th>
            </tr>
          </thead>
          <tbody className="font-mono">
            {periods.map((p) => {
              const gap = p.gapToNext;
              const gapBad = gap !== undefined && Math.abs(gap) > 0.05;
              return (
                <tr key={p.index} className="border-b border-edge/40 last:border-0">
                  <td className="px-4 py-1.5">{p.id ?? p.index}</td>
                  <td className="px-3 py-1.5 text-muted">{(p.start - t0).toFixed(3)}s</td>
                  <td className="px-3 py-1.5">{p.duration.toFixed(3)}s</td>
                  <td className="px-3 py-1.5">
                    {p.isAd ? (
                      <span className="rounded border border-amber-400/30 bg-amber-400/10 px-1.5 py-0.5 text-[10px] text-amber-200">
                        AD
                      </span>
                    ) : (
                      <span className="text-muted">content</span>
                    )}
                    {p.segmentationType && <span className="ml-2 font-sans text-muted">{p.segmentationType}</span>}
                  </td>
                  <td className={`px-3 py-1.5 ${p.avSkew > 0.1 ? "text-amber-300" : "text-muted"}`}>
                    {(p.avSkew * 1000).toFixed(1)}ms
                  </td>
                  <td className={`px-3 py-1.5 ${gapBad ? "text-red-300" : "text-muted"}`}>
                    {gap === undefined
                      ? "—"
                      : (() => {
                          const msRounded = Math.round(gap * 1000 * 10) / 10 || 0;
                          return `${msRounded >= 0 ? "+" : ""}${msRounded.toFixed(1)}ms`;
                        })()}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="border-t border-edge px-4 py-2 text-[11px] text-muted">
        Largest boundary discontinuity {(maxGap * 1000).toFixed(1)}ms. Sub-frame differences are normal;
        anything past 50ms is reported as a finding.
      </div>
    </div>
  );
}

function ProbePanel({ probe }: { probe: SegmentProbe }) {
  return (
    <section className="mt-6">
      <h2 className="mb-2 text-sm font-medium uppercase tracking-wide text-muted">
        Inside the segments
      </h2>
      <div className="rounded-xl border border-edge bg-panel">
        <div className="border-b border-edge px-4 py-2 text-[11px] text-muted">
          {probe.fetched} of {probe.attempted} segments read · {(probe.bytes / 1024 / 1024).toFixed(2)}MB ·{" "}
          {probe.format} · {probe.signals.length} inband cue{probe.signals.length === 1 ? "" : "s"}
          {probe.fetchErrors.length > 0 && ` · ${probe.fetchErrors.length} fetch error(s)`}
        </div>
        {probe.signals.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-muted">
            No SCTE-35 found in the segments that were read — for this stream the manifest is the
            only carriage.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="text-[11px] uppercase tracking-wide text-muted">
                <tr className="border-b border-edge/70">
                  <th className="px-4 py-2 font-medium">Resolved time</th>
                  <th className="px-3 py-2 font-medium">Event</th>
                  <th className="px-3 py-2 font-medium">Duration</th>
                  <th className="px-3 py-2 font-medium">Carriage</th>
                  <th className="px-3 py-2 font-medium">CRC</th>
                </tr>
              </thead>
              <tbody className="font-mono">
                {probe.signals.map((s, i) => (
                  <tr key={i} className="border-b border-edge/40 last:border-0">
                    <td className="px-4 py-1.5">{s.pdt ? clock(s.pdt) : "unanchored"}</td>
                    <td className="px-3 py-1.5">{s.eventId ?? "—"}</td>
                    <td className="px-3 py-1.5">{s.durationSeconds ? `${s.durationSeconds}s` : "—"}</td>
                    <td className="px-3 py-1.5 text-muted">
                      {s.tsCarriage === "id3-pes"
                        ? `ID3 PRIV · PID 0x${s.pid?.toString(16)}`
                        : s.pid !== undefined
                          ? `section · PID 0x${s.pid.toString(16)}`
                          : (s.schemeIdUri ?? "emsg")}
                    </td>
                    <td className="px-3 py-1.5">
                      {s.section ? (
                        s.section.crcValid ? (
                          <span className="text-emerald-400">valid</span>
                        ) : (
                          <span className="text-amber-300">invalid</span>
                        )
                      ) : (
                        <span className="text-red-300">undecodable</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}

function InterstitialTable({ interstitials }: { interstitials: Interstitial[] }) {
  return (
    <div className="rounded-lg border border-edge bg-panel">
      <div className="border-b border-edge px-4 py-2 text-[11px] uppercase tracking-wide text-muted">
        Interstitials — {interstitials.length} signalled, played by the client rather than spliced
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead className="text-muted">
            <tr className="border-b border-edge/70">
              <th className="px-4 py-2 font-medium">ID</th>
              <th className="px-3 py-2 font-medium">At</th>
              <th className="px-3 py-2 font-medium">Duration</th>
              <th className="px-3 py-2 font-medium">Cue</th>
              <th className="px-3 py-2 font-medium">Asset</th>
            </tr>
          </thead>
          <tbody className="font-mono">
            {interstitials.map((i, n) => (
              <tr key={n} className="border-b border-edge/40 last:border-0">
                <td className="px-4 py-1.5">{i.id ?? "—"}</td>
                <td className="px-3 py-1.5 text-muted">{secs(i.startTime)}</td>
                <td className="px-3 py-1.5">{i.duration !== undefined ? secs(i.duration) : <span className="text-amber-300">none</span>}</td>
                <td className="px-3 py-1.5 text-muted">{i.cue.length ? i.cue.join(",") : "—"}</td>
                <td className="px-3 py-1.5">
                  {i.assetUri && i.assetList ? (
                    <span className="text-red-300">URI and LIST</span>
                  ) : i.assetUri ? (
                    <span className="text-muted">X-ASSET-URI</span>
                  ) : i.assetList ? (
                    <span className="text-muted">X-ASSET-LIST</span>
                  ) : (
                    <span className="text-red-300">none</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const SAMPLES: { id?: string; label: string; url?: string; note: string; recorded?: boolean }[] = [
  {
    id: "multiperiod-dash",
    label: "Multi-period DASH",
    note: "Live multi-period DASH — each avail is its own Period, with paired SCTE-35 start and end descriptors",
    recorded: true,
  },
  {
    id: "unified-dash",
    label: "DASH EventStream",
    note: "Live DASH carrying avails as Events with an explicit duration instead of as Periods",
    recorded: true,
  },
  {
    id: "unified-hls",
    label: "HLS, dual-signalled",
    note: "Recorded from a live HLS feed carrying both DATERANGE and CUE-OUT, four renditions",
    recorded: true,
  },
  {
    label: "Apple bipbop (live)",
    url: "https://devstreaming-cdn.apple.com/videos/streaming/examples/bipbop_16x9/bipbop_16x9_variant.m3u8",
    note: "Control case — a stream with no ad signalling at all",
  },
];

const SEVERITY_STYLE: Record<string, { dot: string; chip: string; label: string }> = {
  error: { dot: "bg-red-500", chip: "bg-red-500/10 text-red-300 border-red-500/30", label: "Error" },
  warning: { dot: "bg-amber-400", chip: "bg-amber-400/10 text-amber-200 border-amber-400/30", label: "Warning" },
  info: { dot: "bg-sky-400", chip: "bg-sky-400/10 text-sky-200 border-sky-400/30", label: "Info" },
};

function secs(n: number | undefined, d = 2) {
  return n === undefined ? "—" : `${n.toFixed(d)}s`;
}

function clock(pdt: number | undefined) {
  if (pdt === undefined) return "—";
  return new Date(pdt).toISOString().replace("T", " ").replace(/\.\d+Z$/, "Z");
}

function FindingRow({ f }: { f: Finding }) {
  const s = SEVERITY_STYLE[f.severity];
  return (
    <div className="flex gap-3 border-b border-edge/70 px-4 py-3 last:border-0">
      <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${s.dot}`} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <span className="font-medium">{f.title}</span>
          <code className="rounded bg-white/5 px-1.5 py-0.5 font-mono text-[11px] text-muted">{f.code}</code>
          {f.rendition && <span className="text-[11px] text-muted">in {f.rendition}</span>}
          {f.lineNumber !== undefined && <span className="text-[11px] text-muted">line {f.lineNumber}</span>}
        </div>
        <p className="mt-1 text-sm leading-relaxed text-muted">{f.detail}</p>
      </div>
    </div>
  );
}

function BreakCard({ b }: { b: AdBreak }) {
  const [open, setOpen] = useState(false);
  const sec = b.signal?.section;
  const delta =
    b.actualDuration !== undefined && b.signalledDuration !== undefined
      ? b.actualDuration - b.signalledDuration
      : undefined;

  return (
    <div className="rounded-lg border border-edge bg-panel">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-4 px-4 py-3 text-left hover:bg-white/[0.02]"
      >
        <span className="font-mono text-xs text-muted">#{b.index}</span>
        <span className="flex-1">
          <span className="block text-sm font-medium">
            {b.segmentationType ?? (b.outOfNetwork === true ? "splice_insert out of network" : "Ad break")}
          </span>
          <span className="block font-mono text-[11px] text-muted">
            {b.periodId ? `period ${b.periodId} · ` : ""}t={secs(b.startTime)} · {clock(b.pdt)}
          </span>
        </span>
        <span className="hidden text-right sm:block">
          <span className="block text-sm">
            signalled {secs(b.signalledDuration)} · actual {secs(b.actualDuration)}
          </span>
          <span className="block text-[11px] text-muted">
            {b.segmentCount} segment{b.segmentCount === 1 ? "" : "s"}
            {delta !== undefined && Math.abs(delta) > 0.01 && (
              <span className={Math.abs(delta) > 0.5 ? "text-amber-300" : ""}>
                {" "}· {delta > 0 ? "+" : ""}
                {delta.toFixed(2)}s
              </span>
            )}
          </span>
        </span>
        <span className="flex items-center gap-1.5">
          {b.windowClipped && (
            <span className="rounded border border-edge px-1.5 py-0.5 text-[10px] text-muted">
              clipped by window
            </span>
          )}
          {b.inProgress && (
            <span className="rounded border border-sky-400/30 bg-sky-400/10 px-1.5 py-0.5 text-[10px] text-sky-200">
              open
            </span>
          )}
          {!b.closed && !b.inProgress && (
            <span className="rounded border border-red-500/30 bg-red-500/10 px-1.5 py-0.5 text-[10px] text-red-300">
              unclosed
            </span>
          )}
          {b.signal && !b.signal.ok && (
            <span className="rounded border border-red-500/30 bg-red-500/10 px-1.5 py-0.5 text-[10px] text-red-300">
              bad SCTE-35
            </span>
          )}
          <span className="text-muted">{open ? "−" : "+"}</span>
        </span>
      </button>

      {open && (
        <div data-shot="break-detail" className="border-t border-edge px-4 py-3 text-sm">
          <dl className="grid grid-cols-1 gap-x-8 gap-y-2 sm:grid-cols-2">
            <Row k="Signalled duration" v={`${secs(b.signalledDuration)}${b.signalledDurationSource ? ` (${b.signalledDurationSource})` : ""}`} />
            <Row k="Actual segment total" v={secs(b.actualDuration)} />
            <Row k="Discontinuity at start" v={b.discontinuityAtStart ? "yes" : "no"} warn={!b.discontinuityAtStart} />
            <Row k="Discontinuity at end" v={b.discontinuityAtEnd ? "yes" : "no"} warn={b.closed && !b.discontinuityAtEnd} />
            {b.eventId !== undefined && <Row k="Event ID" v={String(b.eventId)} />}
            {b.upid && <Row k={`UPID (${b.upidType})`} v={b.upid} mono />}
            {b.segmentationTypeId !== undefined && (
              <Row k="Segmentation type" v={`0x${b.segmentationTypeId.toString(16)} — ${b.segmentationType}`} />
            )}
            {b.edgeDistance !== undefined && (
              <Row k="Distance from live edge" v={secs(b.edgeDistance, 1)} />
            )}
            {b.autoReturn !== undefined && <Row k="auto_return" v={String(b.autoReturn)} />}
            {b.spliceImmediate !== undefined && <Row k="splice_immediate" v={String(b.spliceImmediate)} warn={b.spliceImmediate} />}
          </dl>

          <div className="mt-3">
            <div className="mb-1 text-[11px] uppercase tracking-wide text-muted">Manifest tag</div>
            <pre className="overflow-x-auto rounded bg-black/40 p-2 font-mono text-[11px] leading-relaxed">{b.outTag}</pre>
          </div>

          {sec && (
            <div className="mt-3">
              <div className="mb-1 text-[11px] uppercase tracking-wide text-muted">
                Decoded splice_info_section — {sec.spliceCommandName}
                {" · CRC "}
                <span className={sec.crcValid ? "text-emerald-400" : "text-red-400"}>
                  {sec.crcValid ? "valid" : "INVALID"}
                </span>
              </div>
              <pre className="overflow-x-auto rounded bg-black/40 p-2 font-mono text-[11px] leading-relaxed text-muted">
{JSON.stringify(
  {
    protocol_version: sec.protocolVersion,
    pts_adjustment: sec.ptsAdjustment,
    tier: sec.tier,
    command: sec.spliceCommandName,
    ...(sec.timeSignal ? { time_signal: { pts_time: sec.timeSignal.ptsTime, seconds: sec.timeSignal.ptsSeconds } } : {}),
    ...(sec.spliceInsert ? { splice_insert: sec.spliceInsert } : {}),
    descriptors: sec.descriptors,
  },
  null,
  2,
)}
              </pre>
            </div>
          )}
          {b.signal && !b.signal.ok && (
            <p className="mt-3 rounded border border-red-500/30 bg-red-500/10 p-2 text-sm text-red-200">
              SCTE-35 decode failed: {b.signal.error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function Row({ k, v, warn, mono }: { k: string; v: string; warn?: boolean; mono?: boolean }) {
  return (
    <div className="flex justify-between gap-4 border-b border-edge/50 py-1">
      <dt className="text-muted">{k}</dt>
      <dd className={`${mono ? "font-mono text-xs" : ""} ${warn ? "text-amber-300" : ""} min-w-0 break-all text-right`}>
        {v}
      </dd>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-lg border border-edge bg-panel px-4 py-3">
      <div className="text-[11px] uppercase tracking-wide text-muted">{label}</div>
      <div className={`mt-1 text-xl font-semibold ${tone ?? ""}`}>{value}</div>
    </div>
  );
}

function RenditionPanel({ r }: { r: RenditionAnalysis }) {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Ad breaks" value={String(r.stats.breakCount)} />
        <Stat
          label={r.protocol === "dash" ? "Periods" : "Segments"}
          value={String(r.protocol === "dash" ? (r.periods?.length ?? 0) : r.stats.segmentCount)}
        />
        <Stat label="Window" value={`${Math.round(r.stats.windowDuration)}s`} />
        <Stat label="Ad load" value={`${r.stats.adPercent.toFixed(1)}%`} />
      </div>

      <div className="flex flex-wrap gap-2 text-[11px]">
        <Tag on={r.stats.live} yes="LIVE" no="VOD" />
        <Tag
          on={r.stats.hasPdt}
          yes={r.protocol === "dash" ? "availabilityStartTime" : "PROGRAM-DATE-TIME"}
          no={r.protocol === "dash" ? "no availabilityStartTime" : "no PDT"}
          warnOnNo
        />
        <span className="rounded border border-edge px-2 py-1 uppercase text-muted">{r.protocol}</span>
        {r.stats.lowLatency && <span className="rounded border border-edge px-2 py-1 text-muted">LL-HLS</span>}
        {r.playlist?.targetDuration && (
          <span className="rounded border border-edge px-2 py-1 text-muted">
            TARGETDURATION {r.playlist.targetDuration}s
          </span>
        )}
      </div>

      {r.protocol === "dash" && r.periods && <PeriodTable periods={r.periods} />}

      {r.interstitials && r.interstitials.length > 0 && (
        <InterstitialTable interstitials={r.interstitials} />
      )}

      {r.breaks.length > 0 ? (
        <div className="space-y-2">
          {r.breaks.map((b) => (
            <BreakCard key={b.index} b={b} />
          ))}
        </div>
      ) : (
        <p className="rounded-lg border border-edge bg-panel px-4 py-6 text-center text-sm text-muted">
          No ad breaks found in this rendition&rsquo;s current window.
        </p>
      )}
    </div>
  );
}

function Tag({ on, yes, no, warnOnNo }: { on: boolean; yes: string; no: string; warnOnNo?: boolean }) {
  return (
    <span
      className={`rounded border px-2 py-1 ${
        on ? "border-edge text-muted" : warnOnNo ? "border-amber-400/30 bg-amber-400/10 text-amber-200" : "border-edge text-muted"
      }`}
    >
      {on ? yes : no}
    </span>
  );
}

export default function Home() {
  const [url, setUrl] = useState("");
  const [paste, setPaste] = useState("");
  const [mode, setMode] = useState<"url" | "paste">("url");
  const [readSegments, setReadSegments] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [active, setActive] = useState(0);

  async function run(overrideUrl?: string, sampleId?: string) {
    setLoading(true);
    setError(null);
    setResult(null);
    setActive(0);
    try {
      const res = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          sampleId
            ? { sampleId }
            : mode === "url" || overrideUrl
              ? { url: overrideUrl ?? url, probeSegments: readSegments ? 8 : 0 }
              : { text: paste },
        ),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Analysis failed");
      setResult(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Analysis failed");
    } finally {
      setLoading(false);
    }
  }

  const allFindings = result
    ? [
        ...result.crossFindings,
        ...result.renditions.flatMap((r) => r.findings),
        ...(result.probe?.findings ?? []),
      ].sort(
        (a, b) =>
          ["error", "warning", "info"].indexOf(a.severity) - ["error", "warning", "info"].indexOf(b.severity),
      )
    : [];

  const verdictStyle =
    result?.summary.verdict === "fail"
      ? "border-red-500/40 bg-red-500/10"
      : result?.summary.verdict === "warn"
        ? "border-amber-400/40 bg-amber-400/10"
        : "border-emerald-500/40 bg-emerald-500/10";

  return (
    <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-10 sm:px-6">
      <header className="mb-8 flex flex-wrap items-start justify-between gap-3">
        <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          Splice<span className="text-accent">Check</span>
        </h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">
          Point it at an HLS or DASH stream and it reconstructs every ad break, decodes the SCTE-35
          riding with it, and reports the conditions that make server-side ad insertion mis-fire —
          unclosed avails, duration disagreements, missing discontinuities, renditions that do not
          splice at the same point, and periods that do not meet.
        </p>
        </div>
        <div className="flex shrink-0 flex-col gap-1 text-sm">
          <Link href="/compare" className="text-accent hover:underline">
            pipeline comparison →
          </Link>
          <Link href="/monitors" className="text-accent hover:underline">
            continuous monitors →
          </Link>
          <a href="/guide" className="text-accent hover:underline">
            how ad insertion works →
          </a>
        </div>
      </header>

      <section className="rounded-xl border border-edge bg-panel p-4">
        <div className="mb-3 flex gap-1 text-xs">
          {(["url", "paste"] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={`rounded px-3 py-1.5 ${
                mode === m ? "bg-white/10 text-foreground" : "text-muted hover:text-foreground"
              }`}
            >
              {m === "url" ? "Playlist URL" : "Paste manifest"}
            </button>
          ))}
        </div>

        {mode === "url" ? (
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && !loading && run()}
              placeholder="https://example.com/live/master.m3u8  or  manifest.mpd"
              className="flex-1 rounded-lg border border-edge bg-black/30 px-3 py-2 font-mono text-sm outline-none placeholder:text-muted/60 focus:border-accent"
            />
            <button
              onClick={() => run()}
              disabled={loading || !url.trim()}
              className="rounded-lg bg-accent px-5 py-2 text-sm font-medium text-[#04121f] disabled:opacity-40"
            >
              {loading ? "Analysing…" : "Analyse"}
            </button>
          </div>
        ) : (
          <div className="space-y-2">
            <textarea
              value={paste}
              onChange={(e) => setPaste(e.target.value)}
              rows={10}
              placeholder="#EXTM3U&#10;#EXT-X-VERSION:3&#10;…"
              className="w-full rounded-lg border border-edge bg-black/30 px-3 py-2 font-mono text-xs outline-none placeholder:text-muted/60 focus:border-accent"
            />
            <button
              onClick={() => run()}
              disabled={loading || !paste.trim()}
              className="rounded-lg bg-accent px-5 py-2 text-sm font-medium text-[#04121f] disabled:opacity-40"
            >
              {loading ? "Analysing…" : "Analyse pasted playlist"}
            </button>
          </div>
        )}

        {mode === "url" && (
          <label className="mt-3 flex cursor-pointer items-start gap-2 text-xs text-muted">
            <input
              type="checkbox"
              checked={readSegments}
              onChange={(e) => setReadSegments(e.target.checked)}
              className="mt-0.5"
            />
            <span>
              Open the segments and read the SCTE-35 inside them, then check it agrees with the
              manifest. Downloads a few MB and takes a few seconds — HLS only, and not available for
              the recorded samples.
            </span>
          </label>
        )}

        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted">
          <span>Try:</span>
          {SAMPLES.map((s) => (
            <button
              key={s.id ?? s.url}
              onClick={() => {
                setMode("url");
                setUrl(s.url ?? "");
                run(s.url, s.id);
              }}
              title={s.note}
              className="rounded border border-edge px-2 py-1 hover:border-accent hover:text-foreground"
            >
              {s.label}
              {s.recorded && <span className="ml-1.5 text-[10px] text-muted">recorded</span>}
            </button>
          ))}
        </div>
      </section>

      {error && (
        <div className="mt-6 rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200">
          {error}
        </div>
      )}

      {result && (
        <>
          <div className={`mt-6 rounded-xl border px-4 py-4 ${verdictStyle}`}>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="text-lg font-semibold">
                  {result.summary.verdict === "fail"
                    ? "Problems found that will affect ad delivery"
                    : result.summary.verdict === "warn"
                      ? "Signalling works, with issues worth fixing"
                      : "No problems detected"}
                </div>
                <div className="mt-0.5 font-mono text-[11px] break-all text-muted">{result.sourceUri}</div>
                {result.recorded && (
                  <div className="mt-1 text-[11px] text-muted">
                    Captured {result.recorded.capturedAt} from a live service, so this analysis is
                    reproducible whether or not that origin is still up.
                  </div>
                )}
              </div>
              <div className="flex gap-2 text-xs">
                <span className={`rounded border px-2 py-1 ${SEVERITY_STYLE.error.chip}`}>
                  {result.summary.errors} errors
                </span>
                <span className={`rounded border px-2 py-1 ${SEVERITY_STYLE.warning.chip}`}>
                  {result.summary.warnings} warnings
                </span>
                <span className={`rounded border px-2 py-1 ${SEVERITY_STYLE.info.chip}`}>
                  {result.summary.infos} info
                </span>
              </div>
            </div>
          </div>

          {result.probe && <ProbePanel probe={result.probe} />}

          {allFindings.length > 0 && (
            <section className="mt-6">
              <h2 className="mb-2 text-sm font-medium uppercase tracking-wide text-muted">Findings</h2>
              <div className="rounded-xl border border-edge bg-panel">
                {allFindings.map((f, i) => (
                  <FindingRow key={i} f={f} />
                ))}
              </div>
            </section>
          )}

          <section className="mt-8">
            <h2 className="mb-2 text-sm font-medium uppercase tracking-wide text-muted">
              Ad breaks by rendition
            </h2>
            {result.renditions.length > 1 && (
              <div className="mb-3 flex flex-wrap gap-1 text-xs">
                {result.renditions.map((r, i) => (
                  <button
                    key={r.uri + i}
                    onClick={() => setActive(i)}
                    className={`rounded px-3 py-1.5 ${
                      active === i ? "bg-white/10 text-foreground" : "text-muted hover:text-foreground"
                    }`}
                  >
                    {r.label}
                    <span className="ml-1.5 text-muted">({r.breaks.length})</span>
                  </button>
                ))}
              </div>
            )}
            {result.renditions[active] && <RenditionPanel r={result.renditions[active]} />}
          </section>
        </>
      )}

      <footer className="mt-16 border-t border-edge pt-4 text-xs text-muted">
        Decodes SCTE-35 per ANSI/SCTE 35 2022. HLS: EXT-X-CUE-OUT/IN, EXT-X-DATERANGE, EXT-OATCLS-SCTE35,
        EXT-X-SCTE35, EXT-X-SPLICEPOINT-SCTE35. DASH: multi-period, SCTE-35 EventStreams, period continuity,
        presentation-time offsets.
      </footer>
    </main>
  );
}
