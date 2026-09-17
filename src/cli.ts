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
import { comparePipeline } from "./lib/pipeline";
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
  strict: boolean;
  quiet: boolean;
  variants?: number;
}

function usage(): never {
  process.stderr.write(`splicecheck — ad-break inspection for HLS and DASH

Usage
  splicecheck <url|file>                      analyse a manifest
  splicecheck compare <source> <output>       compare a feed with its stitched output

Options
  --json             emit the full analysis as JSON
  --strict           exit non-zero on warnings as well as errors
  --quiet            print findings only, no summary detail
  --variants <n>     maximum HLS renditions to fetch (default 6)
  -h, --help         this message

Exit codes
  0  no errors (no warnings either, under --strict)
  1  problems found
  2  could not analyse the input
`);
  process.exit(2);
}

function parseArgs(argv: string[]): { cmd: string; targets: string[]; opts: Options } {
  const opts: Options = { json: false, strict: false, quiet: false };
  const targets: string[] = [];
  let cmd = "analyse";

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") usage();
    else if (a === "--json") opts.json = true;
    else if (a === "--strict") opts.strict = true;
    else if (a === "--quiet") opts.quiet = true;
    else if (a === "--variants") opts.variants = Number(argv[++i]);
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
  const sorted = [...findings].sort((a, b) => order[a.severity] - order[b.severity]);
  for (const f of sorted) {
    const s = SEV[f.severity];
    const where = [f.rendition, f.lineNumber !== undefined ? `line ${f.lineNumber}` : undefined]
      .filter(Boolean)
      .join(" · ");
    process.stdout.write(
      `  ${s.paint(s.mark)} ${f.title} ${c.dim(f.code)}${where ? " " + c.dim(where) : ""}\n`,
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

async function runAnalyse(target: string, opts: Options): Promise<number> {
  const r = await load(target, opts);
  if (opts.json) {
    process.stdout.write(JSON.stringify(r, null, 2) + "\n");
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
    const all = [...r.crossFindings, ...r.renditions.flatMap((x) => x.findings)];
    if (all.length === 0) process.stdout.write(c.green("  nothing to report\n\n"));
    else {
      printFindings(all, opts.quiet);
      process.stdout.write("\n");
    }
    process.stdout.write(
      `  ${verdictLine(r.summary.verdict, r.summary.errors, r.summary.warnings, r.summary.infos)}\n\n`,
    );
  }
  if (r.summary.errors > 0) return 1;
  if (opts.strict && r.summary.warnings > 0) return 1;
  return 0;
}

async function runCompare(source: string, output: string, opts: Options): Promise<number> {
  const [src, out] = await Promise.all([load(source, opts), load(output, opts)]);
  const cmp = comparePipeline(src, out, { source: "source", stitched: "output" });

  if (opts.json) {
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
