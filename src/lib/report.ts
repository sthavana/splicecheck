/**
 * A findings report someone can act on away from the tool.
 *
 * The analysis is only useful if it can leave the screen. In practice that
 * means a vendor ticket or an email to whoever runs the packager, so the output
 * is Markdown: the codes, the line numbers, the decoded signalling and the
 * wall-clock times, in a form that survives being pasted into Jira.
 *
 * It states what was checked as well as what was found. A report that lists
 * three warnings without saying it looked at four renditions over a nine-minute
 * window is an assertion; one that says so is evidence.
 */

import type { AnalysisResult, Finding, Severity } from "./analyze";
import type { PipelineComparison } from "./pipeline";

const SEVERITY_ORDER: Severity[] = ["error", "warning", "info"];
const LABEL: Record<Severity, string> = { error: "Errors", warning: "Warnings", info: "Notes" };

function secs(n: number | undefined, digits = 2): string {
  return n === undefined ? "—" : `${n.toFixed(digits).replace(/\.?0+$/, "")}s`;
}

function clock(ms: number | undefined): string {
  return ms === undefined ? "—" : new Date(ms).toISOString().replace("T", " ").replace(/\.\d+Z$/, "Z");
}

function escapeCell(s: string): string {
  return s.replace(/\|/g, "\\|");
}

/** Where a finding applies, as a reader would want to look it up. */
function locate(f: Finding): string {
  const bits: string[] = [];
  if (f.rendition) bits.push(f.rendition);
  if (f.lineNumber !== undefined) bits.push(`line ${f.lineNumber}`);
  if (f.breakIndex !== undefined) bits.push(`break ${f.breakIndex}`);
  if (f.atTime !== undefined) bits.push(`at ${secs(f.atTime)}`);
  return bits.join(", ");
}

export interface ReportOptions {
  /** Included so a pasted report says when it was taken. */
  generatedAt?: number;
  toolUrl?: string;
}

export function analysisToMarkdown(r: AnalysisResult, opts: ReportOptions = {}): string {
  const out: string[] = [];
  const findings = [...r.crossFindings, ...r.renditions.flatMap((x) => x.findings)];
  const bySeverity = (sev: Severity) => findings.filter((f) => f.severity === sev);

  out.push(`# Ad signalling report`);
  out.push("");
  out.push(`**Source:** \`${r.sourceUri}\`  `);
  const takenAt = opts.generatedAt ?? (Date.parse(r.fetchedAt) || Date.now());
  out.push(`**Taken:** ${clock(takenAt)}  `);
  out.push(
    `**Verdict:** ${r.summary.verdict.toUpperCase()} — ${r.summary.errors} error(s), ` +
      `${r.summary.warnings} warning(s), ${r.summary.infos} note(s)`,
  );
  if (r.recorded) out.push(`**Recorded sample:** ${r.recorded.label} (captured ${r.recorded.capturedAt})  `);
  out.push("");

  // What was examined, so the absence of findings means something.
  out.push(`## What was checked`);
  out.push("");
  const rend = r.renditions[0];
  out.push(
    `- ${r.renditions.length} rendition(s)${r.isMaster ? " from a master playlist" : ""}` +
      (rend?.protocol ? `, ${rend.protocol.toUpperCase()}` : ""),
  );
  out.push(`- ${r.summary.breakCount} ad break(s) reconstructed`);
  if (rend?.playlist) {
    out.push(
      `- ${rend.playlist.segments.length} segment(s) spanning ${secs(rend.playlist.totalDuration, 1)}` +
        (rend.playlist.endList ? " (on demand)" : " (live window)"),
    );
    if (rend.playlist.lowLatency) {
      out.push(
        `- Low latency: ${rend.playlist.parts.length} part(s) published, ` +
          `PART-HOLD-BACK ${secs(rend.playlist.serverControl?.partHoldBack)}`,
      );
    }
  }
  if (r.probe) {
    out.push(
      `- ${r.probe.fetched} segment(s) opened (${(r.probe.bytes / 1e6).toFixed(2)}MB, ${r.probe.format}), ` +
        `${r.probe.signals.length} inband cue(s) found`,
    );
  } else {
    out.push(`- Segments were not opened, so only the manifest was checked`);
  }
  if (r.xlink && !("error" in r.xlink)) {
    out.push(`- ${r.xlink.resolved} of ${r.xlink.attempted} remote Period(s) resolved`);
  }
  out.push("");

  if (findings.length === 0) {
    out.push(`## Findings`);
    out.push("");
    out.push(`None. Everything checked above is as it should be.`);
    out.push("");
  } else {
    for (const sev of SEVERITY_ORDER) {
      const list = bySeverity(sev);
      if (list.length === 0) continue;
      out.push(`## ${LABEL[sev]} (${list.length})`);
      out.push("");
      for (const f of list) {
        const where = locate(f);
        out.push(`### ${f.title}`);
        out.push("");
        out.push(`\`${f.code}\`${where ? ` — ${where}` : ""}`);
        out.push("");
        out.push(f.detail);
        out.push("");
      }
    }
  }

  const breaks = r.renditions[0]?.breaks ?? [];
  if (breaks.length > 0) {
    out.push(`## Breaks`);
    out.push("");
    out.push(`| # | Wall clock | Signalled | Actual | Closed | Event id | Type |`);
    out.push(`|---|---|---|---|---|---|---|`);
    for (const b of breaks) {
      out.push(
        `| ${b.index} | ${clock(b.pdt)} | ${secs(b.signalledDuration)} | ${secs(b.actualDuration)} | ` +
          `${b.closed ? "yes" : b.inProgress ? "in progress" : "**no**"} | ${b.eventId ?? "—"} | ` +
          `${escapeCell(b.segmentationType ?? b.signal?.section?.spliceCommandName ?? "—")} |`,
      );
    }
    out.push("");
  }

  if (r.probe && r.probe.signals.length > 0) {
    out.push(`## SCTE-35 carried in the segments`);
    out.push("");
    for (const s of r.probe.signals.slice(0, 12)) {
      out.push(
        `- \`${s.carriage}\`${s.pid !== undefined ? ` pid ${s.pid}` : ""} in \`${s.segmentUri.split("/").pop()}\`` +
          `${s.section ? ` — ${s.section.spliceCommandName}, CRC ${s.section.crcValid ? "valid" : "**invalid**"}` : ""}` +
          `${s.eventId !== undefined ? `, event ${s.eventId}` : ""}`,
      );
      if (s.section) out.push(`  \`${s.hex.slice(0, 96)}${s.hex.length > 96 ? "…" : ""}\``);
    }
    out.push("");
  }

  out.push(`---`);
  out.push("");
  out.push(
    `Generated by SpliceCheck${opts.toolUrl ? ` — ${opts.toolUrl}` : ""}. ` +
      `Codes are stable; quoting one is enough to identify the rule.`,
  );
  return out.join("\n");
}

export function comparisonToMarkdown(c: PipelineComparison, opts: ReportOptions = {}): string {
  const out: string[] = [];
  out.push(`# Pipeline comparison report`);
  out.push("");
  out.push(`**Source:** \`${c.source.uri}\` (${c.source.protocol}, ${c.source.breakCount} breaks)  `);
  out.push(`**Output:** \`${c.stitched.uri}\` (${c.stitched.protocol}, ${c.stitched.breakCount} breaks)  `);
  out.push(`**Taken:** ${clock(opts.generatedAt ?? Date.now())}  `);
  out.push(
    `**Verdict:** ${c.summary.verdict.toUpperCase()} — fill rate ` +
      `${Math.round(c.summary.fillRate * 100)}% ` +
      `(${secs(c.summary.stitchedSeconds, 0)} of ${secs(c.summary.signalledSeconds, 0)} signalled)`,
  );
  out.push("");

  out.push(`## Avails`);
  out.push("");
  out.push(`| # | Wall clock | Status | Signalled | Delivered | Fill |`);
  out.push(`|---|---|---|---|---|---|`);
  for (const a of c.avails) {
    out.push(
      `| ${a.index} | ${clock(a.pdt)} | ${a.status} | ${secs(a.signalledDuration)} | ` +
        `${secs(a.stitchedDuration)} | ${a.fillRatio !== undefined ? `${Math.round(a.fillRatio * 100)}%` : "—"} |`,
    );
  }
  out.push("");

  if (c.findings.length > 0) {
    for (const sev of SEVERITY_ORDER) {
      const list = c.findings.filter((f) => f.severity === sev);
      if (list.length === 0) continue;
      out.push(`## ${LABEL[sev]} (${list.length})`);
      out.push("");
      for (const f of list) {
        out.push(`### ${f.title}`);
        out.push("");
        out.push(`\`${f.code}\``);
        out.push("");
        out.push(f.detail);
        out.push("");
      }
    }
  }

  out.push(`---`);
  out.push("");
  out.push(`Generated by SpliceCheck${opts.toolUrl ? ` — ${opts.toolUrl}` : ""}.`);
  return out.join("\n");
}

/** A filename that sorts and does not collide. */
export function reportFilename(uri: string, ext: string, at = Date.now()): string {
  let name = "report";
  try {
    name = new URL(uri).hostname.replace(/^www\./, "");
  } catch {
    name = uri.split(/[/\\]/).pop() ?? "report";
  }
  const stamp = new Date(at).toISOString().slice(0, 16).replace(/[:T]/g, "-");
  return `splicecheck-${name.replace(/[^a-z0-9.-]/gi, "_")}-${stamp}.${ext}`;
}
