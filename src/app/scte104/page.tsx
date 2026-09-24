"use client";

import { useState } from "react";
import type { Finding } from "@/lib/analyze";
import type { Scte104Message } from "@/lib/scte104";

interface Result {
  message: Scte104Message;
  findings: Finding[];
  checked?: { field: string; requested: string; emitted: string; agrees: boolean }[];
  emitted?: { commandName: string; crcValid: boolean; from?: string };
  warning?: string;
}

const DOT: Record<string, string> = { error: "bg-danger", warning: "bg-warn", info: "bg-info" };

/**
 * A spliceStart_normal with eight seconds of pre-roll and a ninety-second
 * break — the shape a well-behaved automation system sends.
 */
const SAMPLE = "ffff001e00000100010000010101000e010000138900011f400384010101";

export default function Scte104Page() {
  const [message, setMessage] = useState(SAMPLE);
  const [scte35, setScte35] = useState("");
  const [streamUrl, setStreamUrl] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/scte104", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message,
          scte35: scte35.trim() || undefined,
          streamUrl: streamUrl.trim() || undefined,
        }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? "Could not read that message");
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
        <p className="text-[11px] uppercase tracking-wider text-accent">Upstream</p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">SCTE-104</h1>
        <p className="mt-3 max-w-2xl text-sm leading-relaxed text-soft">
          The message playout automation sends the encoder, before any of this is SCTE-35. It is the
          first transcription in the chain and the only one nobody downstream can see: automation
          asks for a splice, the encoder emits a <code className="font-mono">splice_info_section</code>,
          and the two are separate artefacts produced by different vendors&rsquo; software. Paste the
          message — from a capture, a debug log, or an automation trace — and it is decoded, checked,
          and compared against what the stream actually carries.
        </p>
      </header>

      <section className="rounded-xl border border-edge bg-panel p-4">
        <label className="flex flex-col gap-1.5">
          <span className="text-[11px] uppercase tracking-wider text-muted">
            The message, as hex or base64
          </span>
          <textarea
            id="s104-message"
            className={`${input} h-28 font-mono text-[12px]`}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            spellCheck={false}
          />
        </label>

        <p className="mt-3 text-[11px] uppercase tracking-wider text-muted">
          What the encoder emitted — either is optional
        </p>
        <div className="mt-1.5 grid gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1.5">
            <span className="text-xs text-muted">A SCTE-35 payload</span>
            <input
              id="s104-scte35"
              className={`${input} font-mono text-[12px]`}
              placeholder="/DAvAAAAAAAA///wFAVIAACP..."
              value={scte35}
              onChange={(e) => setScte35(e.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs text-muted">Or a stream to take one from</span>
            <input
              id="s104-stream"
              className={`${input} font-mono text-[12px]`}
              placeholder="https://origin.example/index.m3u8"
              value={streamUrl}
              onChange={(e) => setStreamUrl(e.target.value)}
            />
          </label>
        </div>

        <button
          type="button"
          onClick={run}
          disabled={busy}
          className="mt-4 rounded-md bg-accent px-3 py-1.5 text-sm text-on-accent transition-opacity disabled:opacity-60"
        >
          {busy ? "Reading…" : "Read the message"}
        </button>
      </section>

      {error && (
        <div className="mt-6 rounded-lg border border-danger-line bg-danger-soft px-4 py-3 text-sm text-danger">
          {error}
        </div>
      )}

      {result && (
        <>
          <section className="mt-6 rounded-lg border border-edge bg-panel p-5">
            <h2 className="mb-3 text-sm font-medium text-foreground">
              What automation asked for
            </h2>
            <div className="mb-3 flex flex-wrap gap-2 text-xs">
              <span className="rounded border border-edge bg-input px-2 py-1 text-soft">
                {result.message.kind} operation message
              </span>
              <span className="rounded border border-edge bg-input px-2 py-1 text-muted">
                AS {result.message.asIndex} · message {result.message.messageNumber}
              </span>
              {result.message.timestamp && (
                <span className="rounded border border-edge bg-input px-2 py-1 text-muted">
                  time {result.message.timestamp.typeName}
                  {result.message.timestamp.utcIso ? ` · ${result.message.timestamp.utcIso}` : ""}
                </span>
              )}
            </div>
            <ul className="flex flex-col gap-2">
              {result.message.operations.map((op, i) => (
                <li key={i} className="rounded-md border border-edge bg-input p-3 text-xs">
                  <div className="font-mono text-[11px] text-accent">{op.opName}</div>
                  {op.spliceRequest && (
                    <div className="mt-1.5 grid gap-x-6 gap-y-1 text-soft sm:grid-cols-2">
                      <span>{op.spliceRequest.spliceInsertTypeName}</span>
                      <span>event {op.spliceRequest.spliceEventId}</span>
                      <span>pre-roll {(op.spliceRequest.preRollMs / 1000).toFixed(1)}s</span>
                      <span>duration {op.spliceRequest.breakDurationSeconds}s</span>
                      <span>avail {op.spliceRequest.availNum} of {op.spliceRequest.availsExpected}</span>
                      <span>auto-return {op.spliceRequest.autoReturn ? "yes" : "no"}</span>
                    </div>
                  )}
                  {op.segmentation && (
                    <div className="mt-1.5 grid gap-x-6 gap-y-1 text-soft sm:grid-cols-2">
                      <span>event {op.segmentation.eventId}</span>
                      <span>type 0x{op.segmentation.typeId.toString(16)}</span>
                      <span>duration {op.segmentation.durationSeconds}s</span>
                      <span>segment {op.segmentation.segmentNum}/{op.segmentation.segmentsExpected}</span>
                    </div>
                  )}
                  {op.rawHex && (
                    <div className="mt-1.5 break-all font-mono text-[10px] text-muted">{op.rawHex}</div>
                  )}
                </li>
              ))}
            </ul>
          </section>

          {result.checked && result.checked.length > 0 && (
            <section className="mt-4 rounded-lg border border-edge bg-panel p-5">
              <h2 className="mb-1 text-sm font-medium text-foreground">
                Against what the encoder emitted
              </h2>
              <p className="mb-3 text-xs text-muted">
                {result.emitted?.commandName}
                {result.emitted?.from ? ` · from ${result.emitted.from}` : ""}
                {result.emitted && !result.emitted.crcValid ? " · CRC invalid" : ""}
              </p>
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-muted">
                    <th className="pb-2 font-normal">Field</th>
                    <th className="pb-2 font-normal">Asked for</th>
                    <th className="pb-2 font-normal">Emitted</th>
                  </tr>
                </thead>
                <tbody>
                  {result.checked.map((k, i) => (
                    <tr key={i} className="border-t border-edge">
                      <td className="py-1.5 text-soft">{k.field}</td>
                      <td className="py-1.5 font-mono text-muted">{k.requested}</td>
                      <td className={`py-1.5 font-mono ${k.agrees ? "text-muted" : "text-danger"}`}>
                        {k.emitted} {k.agrees ? "" : "✖"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          {result.warning && (
            <p className="mt-4 rounded-lg border border-warn-line bg-warn-soft px-4 py-3 text-sm text-warn">
              {result.warning}
            </p>
          )}

          <section className="mt-4">
            <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">Findings</h2>
            {result.findings.length === 0 ? (
              <p className="rounded-lg border border-ok-line bg-ok-soft px-4 py-3 text-sm text-ok">
                Nothing to report. The message is well formed, states enough pre-roll for a decision
                to happen, and — where it was compared — agrees with what the encoder emitted.
              </p>
            ) : (
              <ul className="flex flex-col gap-3">
                {result.findings.map((f, i) => (
                  <li key={i} className="rounded-lg border border-edge bg-panel p-4">
                    <div className="flex flex-wrap items-baseline gap-2">
                      <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${DOT[f.severity]}`} />
                      <span className="text-sm font-medium text-foreground">{f.title}</span>
                      <span className="font-mono text-[10px] uppercase tracking-wider text-muted">{f.code}</span>
                    </div>
                    <p className="mt-1.5 text-sm leading-relaxed text-soft">{f.detail}</p>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </main>
  );
}
