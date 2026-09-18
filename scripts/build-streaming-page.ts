/**
 * Renders content/streaming.md into public/streaming.html.
 *
 * The prose is kept as markdown so it stays editable and diffable; this adds
 * the page shell, the shared typography and the site chrome. Run it after
 * editing the markdown:
 *
 *   npx tsx scripts/build-streaming-page.ts
 */

import { readFileSync, writeFileSync } from "node:fs";
import { marked } from "marked";

const md = readFileSync("content/streaming.md", "utf8");

// Drop the markdown's own title and its inline contents list: the page supplies
// a masthead and a sticky rail instead.
const withoutTitle = md.replace(/^#\s+.*\n/, "");
const contentsStart = withoutTitle.indexOf("**Contents**");
const contentsEnd = withoutTitle.indexOf("---", contentsStart);
const body =
  contentsStart >= 0 && contentsEnd > contentsStart
    ? withoutTitle.slice(0, contentsStart) + withoutTitle.slice(contentsEnd + 3)
    : withoutTitle;

marked.setOptions({ gfm: true, breaks: false });
let html = marked.parse(body) as string;

/** Heading ids, matching the anchors the markdown already links to. */
const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");

const sections: { id: string; title: string }[] = [];
html = html.replace(/<h2>(.*?)<\/h2>/g, (_m, inner: string) => {
  const id = slug(inner);
  const numbered = /^(\d+)\.\s*(.*)$/.exec(inner.replace(/<[^>]+>/g, ""));
  const num = numbered ? numbered[1].padStart(2, "0") : "";
  const title = numbered ? numbered[2] : inner;
  sections.push({ id, title });
  return `<section id="${id}"><h2>${num ? `<span class="sec-num">${num}</span>` : ""}${title}</h2>`;
});
// Close each section before the next one opens, and at the end.
html = html.replace(/<section id=/g, (m, offset: number) =>
  offset === html.indexOf("<section id=") ? m : `</section>${m}`,
);
html += "</section>";

// The "StreamPulse:" paragraphs are cross-references to the other project.
html = html.replace(
  /<p><strong>StreamPulse:<\/strong>([\s\S]*?)<\/p>/g,
  (_m, rest: string) =>
    `<div class="xref"><span class="tag">In StreamPulse</span><p>${rest.trim()}</p></div>`,
);

// Tables and code need their own scroll container so the page never scrolls.
html = html.replace(/<table>/g, '<div class="tablewrap"><table>').replace(/<\/table>/g, "</table></div>");

const rail = sections
  .map((s) => `<li><a href="#${s.id}">${s.title}</a></li>`)
  .join("\n        ");

const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>How a stream gets to a viewer</title>
<meta name="description" content="How video actually reaches a player: the ABR ladder, packaging, HLS, DASH, low latency, origin and CDN — and what goes wrong at each handoff.">
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/apple-icon.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wght@500;600;700&family=Source+Serif+4:opsz,wght@8..60,400;8..60,600&family=JetBrains+Mono:wght@400;500&display=swap">
<link rel="stylesheet" href="/reading.css">
<style>
  /* This page is a reference with a rail, like the ad insertion guide. */
  .layout { display: grid; grid-template-columns: 232px minmax(0, 1fr); gap: 56px; align-items: start; }
  nav.rail { position: sticky; top: 24px; font-family: var(--display); font-size: 13.5px; line-height: 1.45; }
  nav.rail h2 {
    font-family: var(--mono); font-size: 11px; letter-spacing: 0.14em; text-transform: uppercase;
    color: var(--ink-faint); font-weight: 500; margin: 0 0 14px;
  }
  nav.rail ol { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 9px; counter-reset: rail; }
  nav.rail a {
    color: var(--ink-soft); text-decoration: none; display: grid; grid-template-columns: 22px 1fr;
    gap: 6px; padding-block: 2px; border-left: 2px solid transparent; padding-left: 10px; margin-left: -12px;
  }
  nav.rail a::before {
    counter-increment: rail; content: counter(rail, decimal-leading-zero);
    font-family: var(--mono); font-size: 10.5px; color: var(--ink-faint); padding-top: 2px;
  }
  nav.rail a:hover { color: var(--accent); border-left-color: var(--accent); }
  @media (max-width: 900px) {
    .layout { grid-template-columns: 1fr; gap: 0; }
    nav.rail {
      position: static; border: 1px solid var(--rule); border-radius: 4px;
      padding: 18px 20px; margin-bottom: 44px; background: var(--surface);
    }
    nav.rail ol { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 8px 20px; }
  }
</style>
</head>
<body>

<div class="bars" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div>

<div class="toolbar">
  <div>
    <a class="brand" href="/">Splice<span>Check</span></a>
    <a href="/">Inspector</a>
    <a href="/compare">Pipeline comparison</a>
    <a href="/monitors">Monitors</a>
    <a href="/guide">Ad insertion</a>
    <a href="/notes/fifty-five-alerts">Fifty-five alerts</a>
    <span class="spacer"></span>
    <a href="https://github.com/sthavana/splicecheck">Source</a>
  </div>
</div>

<div class="shell wide">

<header class="masthead">
  <p class="eyebrow">Streaming video · reference</p>
  <h1>How a stream gets to a viewer</h1>
  <p class="standfirst">Four systems, four handoffs, and a manifest that is the
  only thing a player ever sees. What each stage promises — and what it looks
  like from outside when one of them stops keeping its promise.</p>
</header>

<div class="layout">
  <nav class="rail" aria-label="Contents">
    <h2>Contents</h2>
    <ol>
        ${rail}
    </ol>
  </nav>

  <main>
${html}
  </main>
</div>
</div>
</body>
</html>
`;

writeFileSync("public/streaming.html", page);
console.log(`wrote public/streaming.html (${page.length} bytes, ${sections.length} sections)`);
