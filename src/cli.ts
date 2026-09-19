/**
 * SpliceCheck command line.
 *
 *   splicecheck <url|file>                 analyse a manifest
 *   splicecheck compare <source> <output>  compare a feed with its stitched output
 *
 * Exits non-zero when errors are found, so it can gate a pipeline.
 */

import { readFile } from "node:fs/promises";
import { analyzeText, analyzeUrl, type RunResult } from "./lib/runner";
import { analysisToMarkdown, comparisonToMarkdown } from "./lib/report";
import { comparePipeline } from "./lib/pipeline";
import { probeMpd, probeRendition, type SegmentProbe } from "./lib/segments";
import { compareScte224, isScte224, parseScte224, type Scte224Comparison } from "./lib/scte224";
import type { Finding } from "./lib/analyze";

const useColour =
  process.stdout.isTTY && !process.env.NO_COLOR && process.env.TERM !== "dumb";
const c = {
  red: (s: string) => (useColour ? `\x1b[31m${s}\x1b[0m` : s),
  amber: (s: string) => (useColour ? `\x1b[33m${s}\x1b[0m` : s),
  blue: (s: string) => (useColour ? `\x1b[36m${s}\x1b[0m` : s),
  green: (s: string) => (useColour ? `\x1b[32m${s}\x1b[0m` : s),
  dim: (s: string) => (useColour ? `\x1b[2m${s}\x1b[0m` : s),
  bold: (s: string) => (useColour ? `\x1b[1m${s}\x1b[0m` : s),
};

const SEV = {
  error: { mark: "✖", paint: c.red },
  warning: { mark: "▲", paint: c.amber },
  info: { mark: "·", paint: c.blue },
} as const;

interface Options {
  json: boolean;
  markdown: boolean;
  strict: boolean;
  quiet: boolean;
  variants?: number;
  /** number of segments to open, or 0 to stay at the manifest layer */
  segments: number;
  /** an SCTE-224 policy document to line the stream's signals up against */
  policy?: string;
}

function usage(): never {
  process.stderr.write(`splicecheck — ad-break inspection for HLS and DASH

Usage
  splicecheck <url|file>                      analyse a manifest
  splicecheck compare <source> <output>       compare a feed with its stitched output

Options
  --json             emit the full analysis as JSON
  --markdown         emit a findings report as Markdown, for a ticket
  --strict           exit non-zero on warnings as well as errors
  --quiet            print findings only, no summary detail
  --variants <n>     maximum HLS renditions to fetch (default 6)
  --segments [n]     open n segments and read the SCTE-35 inside them,
                     then check it agrees with the manifest (default 8)
  --policy <file|url>  an SCTE-224 policy document, checked against the
                     signals the stream actually carries
  -h, --help         this message

Exit codes
  0  no errors (no warnings either, under --strict)
  1  problems found
  2  could not analyse the input
`);
  process.exit(2);
}

function parseArgs(argv: string[]): { cmd: string; targets: string[]; opts: Options } {
  const opts: Options = { json: false, markdown: false, strict: false, quiet: false, segments: 0 };
  const targets: string[] = [];
  let cmd = "analyse";

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") usage();
    else if (a === "--json") opts.json = true;
    else if (a === "--markdown" || a === "--md") opts.markdown = true;
    else if (a === "--strict") opts.strict = true;
    else if (a === "--quiet") opts.quiet = true;
    else if (a === "--variants") opts.variants = Number(argv[++i]);
    else if (a === "--policy") opts.policy = argv[++i];
    else if (a === "--segments") {
      const next = argv[i + 1];
      opts.segments = next && /^\d+$/.test(next) ? Number(argv[++i]) : 8;
    }
    else if (a === "compare" && targets.length === 0) cmd = "compare";
    else if (a.startsWith("-")) {
      process.stderr.write(`unknown option ${a}\n`);
      usage();
    } else targets.push(a);
  }
  if (targets.length === 0) usage();
  return { cmd, targets, opts };
}

/** A target is a URL, or a path to a manifest on disk. */
async function load(target: string, opts: Options): Promise<RunResult> {
  if (/^https?:\/\//i.test(target)) return analyzeUrl(target, opts.variants ?? 6);
  const text = await readFile(target, "utf8");
  return analyzeText(text, target);
}

function printFindings(findings: Finding[], quiet: boolean) {
  const order = { error: 0, warning: 1, info: 2 } as const;
  // The same fault in every rendition is one fault. Show it once and say how
  // many times it occurred, or a stream with four renditions buries its own
  // errors under repeats.
  const groups = new Map<string, { finding: Finding; count: number }>();
  for (const f of findings) {
    const key = `${f.severity}|${f.code}|${f.title}`;
    const g = groups.get(key);
    if (g) g.count++;
    else groups.set(key, { finding: f, count: 1 });
  }

  const sorted = [...groups.values()].sort(
    (a, b) => order[a.finding.severity] - order[b.finding.severity],
  );
  for (const { finding: f, count } of sorted) {
    const s = SEV[f.severity];
    const where = [
      f.rendition,
      count === 1 && f.lineNumber !== undefined ? `line ${f.lineNumber}` : undefined,
    ]
      .filter(Boolean)
      .join(" · ");
    const times = count > 1 ? c.dim(` ×${count}`) : "";
    process.stdout.write(
      `  ${s.paint(s.mark)} ${f.title} ${c.dim(f.code)}${where ? " " + c.dim(where) : ""}${times}\n`,
    );
    if (!quiet) process.stdout.write(`    ${c.dim(wrap(f.detail, 76, "    "))}\n`);
  }
}

function wrap(text: string, width: number, indent: string): string {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    if ((line + " " + w).trim().length > width) {
      lines.push(line.trim());
      line = w;
    } else line += " " + w;
  }
  if (line.trim()) lines.push(line.trim());
  return lines.join("\n" + indent);
}

function verdictLine(verdict: string, errors: number, warnings: number, infos: number): string {
  const label =
    verdict === "fail"
      ? c.red(c.bold("FAIL"))
      : verdict === "warn"
        ? c.amber(c.bold("WARN"))
        : c.green(c.bold("PASS"));
  return `${label}  ${errors} error${errors === 1 ? "" : "s"}, ${warnings} warning${warnings === 1 ? "" : "s"}, ${infos} info`;
}

function printPolicy(cmp: Scte224Comparison) {
  const points = cmp.matched.length + cmp.unmatchedPoints.length;
  process.stdout.write(
    c.dim(
      `  policy: ${points} media point${points === 1 ? "" : "s"} · ${cmp.matched.length} matched a signal · ` +
        `${cmp.unmatchedPoints.length} matched nothing · ${cmp.unmatchedBreaks.length} signal(s) ungoverned\n`,
    ),
  );
  for (const m of cmp.matched) {
    const applied = m.point.applies.length ? m.point.applies.join(", ") : "no policy";
    process.stdout.write(
      c.dim(`    ${m.point.id ?? "(unnamed)"} → break ${m.breakIndex}  ${applied}\n`),
    );
  }
  process.stdout.write("\n");
}

function printProbe(probe: SegmentProbe) {
  process.stdout.write(
    c.dim(
      `  segments: ${probe.fetched}/${probe.attempted} read · ${(probe.bytes / 1024 / 1024).toFixed(2)}MB · ${probe.format} · ` +
        `${probe.signals.length} inband cue${probe.signals.length === 1 ? "" : "s"}\n`,
    ),
  );
  for (const s of probe.signals) {
    const where =
      s.tsCarriage === "id3-pes"
        ? `ID3 PRIV on PID 0x${s.pid?.toString(16)}`
        : s.pid !== undefined
          ? `PID 0x${s.pid.toString(16)}`
          : (s.schemeIdUri ?? "emsg");
    process.stdout.write(
      c.dim(
        `    ${s.pdt ? new Date(s.pdt).toISOString() : "unanchored"}  event ${s.eventId ?? "?"}  ` +
          `${s.durationSeconds ?? "?"}s  ${where}${s.section && !s.section.crcValid ? "  CRC invalid" : ""}\n`,
      ),
    );
  }
  process.stdout.write("\n");
}

async function runAnalyse(target: string, opts: Options): Promise<number> {
  const r = await load(target, opts);
  let probe: SegmentProbe | undefined;
  const first = r.renditions[0];
  if (opts.segments > 0 && first) {
    if (first.protocol === "hls") {
      probe = await probeRendition(first, { maxSegments: opts.segments });
    } else if (first.protocol === "dash" && r.raw) {
      probe = await probeMpd(r.raw.text, r.raw.uri, first, { maxSegments: opts.segments });
    }
  }
  // SCTE-224 says what should happen at a signal; the stream says when.
  let policy: Scte224Comparison | undefined;
  if (opts.policy && first) {
    const xml = /^https?:\/\//i.test(opts.policy)
      ? await (await fetch(opts.policy)).text()
      : await readFile(opts.policy, "utf8");
    if (!isScte224(xml)) throw new Error("That does not look like an SCTE-224 document");
    policy = compareScte224(parseScte224(xml), first.breaks, { label: first.label });
  }

  if (opts.markdown) {
    process.stdout.write(analysisToMarkdown({ ...r, probe }) + "\n");
  } else if (opts.json) {
    process.stdout.write(JSON.stringify({ ...r, raw: undefined, probe, policy }, null, 2) + "\n");
  } else {
    const first = r.renditions[0];
    process.stdout.write(`\n${c.bold(r.sourceUri)}\n`);
    process.stdout.write(
      c.dim(
        `  ${r.meta.protocol.toUpperCase()} · ${r.renditions.length} rendition${r.renditions.length === 1 ? "" : "s"} · ` +
          `${first?.breaks.length ?? 0} ad break${first?.breaks.length === 1 ? "" : "s"} · ` +
          `${Math.round(first?.stats.windowDuration ?? 0)}s window · ${(first?.stats.adPercent ?? 0).toFixed(1)}% ad load\n\n`,
      ),
    );
    if (probe) printProbe(probe);
    if (policy) printPolicy(policy);
    const all = [
      ...r.crossFindings,
      ...r.renditions.flatMap((x) => x.findings),
      ...(probe?.findings ?? []),
      ...(policy?.findings ?? []),
    ];
    if (all.length === 0) process.stdout.write(c.green("  nothing to report\n\n"));
    else {
      printFindings(all, opts.quiet);
      process.stdout.write("\n");
    }
    // The verdict must account for what the segments said, or the summary
    // contradicts the findings printed directly above it.
    const extra = [...(probe?.findings ?? []), ...(policy?.findings ?? [])];
    const pErrors = extra.filter((f) => f.severity === "error").length;
    const pWarnings = extra.filter((f) => f.severity === "warning").length;
    const pInfos = extra.filter((f) => f.severity === "info").length;
    const errors = r.summary.errors + pErrors;
    const warnings = r.summary.warnings + pWarnings;
    const verdict = errors > 0 ? "fail" : warnings > 0 ? "warn" : "pass";
    process.stdout.write(
      `  ${verdictLine(verdict, errors, warnings, r.summary.infos + pInfos)}\n\n`,
    );
  }
  const extraFindings = [...(probe?.findings ?? []), ...(policy?.findings ?? [])];
  const extraErrors = extraFindings.filter((f) => f.severity === "error").length;
  const extraWarnings = extraFindings.filter((f) => f.severity === "warning").length;
  if (r.summary.errors + extraErrors > 0) return 1;
  if (opts.strict && r.summary.warnings + extraWarnings > 0) return 1;
  return 0;
}

async function runCompare(source: string, output: string, opts: Options): Promise<number> {
  const [src, out] = await Promise.all([load(source, opts), load(output, opts)]);
  const cmp = comparePipeline(src, out, { source: "source", stitched: "output" });

  if (opts.markdown) {
    process.stdout.write(comparisonToMarkdown(cmp) + "\n");
  } else if (opts.json) {
    process.stdout.write(JSON.stringify(cmp, null, 2) + "\n");
  } else {
    process.stdout.write(`\n${c.bold("source")} ${c.dim(cmp.source.uri)}\n`);
    process.stdout.write(`${c.bold("output")} ${c.dim(cmp.stitched.uri)}\n\n`);
    const pct = (cmp.summary.fillRate * 100).toFixed(1);
    const paint =
      cmp.summary.fillRate >= 0.99 ? c.green : cmp.summary.fillRate >= 0.9 ? c.amber : c.red;
    process.stdout.write(`  ${c.bold("fill rate")} ${paint(c.bold(pct + "%"))}  `);
    process.stdout.write(
      c.dim(
        `${cmp.summary.stitchedSeconds.toFixed(0)}s of ${cmp.summary.signalledSeconds.toFixed(0)}s signalled across ${cmp.summary.signalled} avail${cmp.summary.signalled === 1 ? "" : "s"}\n\n`,
      ),
    );
    for (const a of cmp.avails) {
      const when = a.pdt ? new Date(a.pdt).toISOString().slice(11, 19) : "—";
      const paintStatus =
        a.status === "filled"
          ? c.green
          : a.status === "not-stitched" || a.status === "passthrough"
            ? c.red
            : c.amber;
      process.stdout.write(
        `  ${c.dim(when)}  signalled ${String(a.signalledDuration ?? "—").padStart(6)}s  ` +
          `output ${String(a.stitchedDuration ?? "—").padStart(6)}s  ${paintStatus(a.status)}\n`,
      );
    }
    process.stdout.write("\n");
    if (cmp.findings.length) {
      printFindings(cmp.findings, opts.quiet);
      process.stdout.write("\n");
    }
    const errors = cmp.findings.filter((f) => f.severity === "error").length;
    const warnings = cmp.findings.filter((f) => f.severity === "warning").length;
    process.stdout.write(`  ${verdictLine(cmp.summary.verdict, errors, warnings, 0)}\n\n`);
  }

  const errors = cmp.findings.filter((f) => f.severity === "error").length;
  const warnings = cmp.findings.filter((f) => f.severity === "warning").length;
  if (errors > 0) return 1;
  if (opts.strict && warnings > 0) return 1;
  return 0;
}

async function main() {
  const { cmd, targets, opts } = parseArgs(process.argv.slice(2));
  try {
    if (cmd === "compare") {
      if (targets.length < 2) {
        process.stderr.write("compare needs a source and an output\n");
        return 2;
      }
      return await runCompare(targets[0], targets[1], opts);
    }
    return await runAnalyse(targets[0], opts);
  } catch (e) {
    process.stderr.write(`${c.red("✖")} ${e instanceof Error ? e.message : String(e)}\n`);
    return 2;
  }
}

main().then((code) => process.exit(code));
