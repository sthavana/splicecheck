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

const toc = sections
  .map((s) => `        <li><a href="#${s.id}">${s.title}</a></li>`)
  .join("\n");

const TOOL: [string, string][] = [
  ["/", "Inspector"],
  ["/compare", "Pipeline comparison"],
  ["/monitors", "Monitors"],
];
const READING: [string, string][] = [
  ["/guide", "Ad insertion"],
  ["/streaming", "Delivery chain"],
  ["/notes/fifty-five-alerts", "Fifty-five alerts"],
];
const links = (items: [string, string][]) =>
  items
    .map(([href, label]) =>
      `        <li><a href="${href}"${href === "/streaming" ? ' aria-current="page"' : ""}>${label}</a></li>`,
    )
    .join("\n");

const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>How a stream gets to a viewer</title>
<meta name="description" content="How video actually reaches a player: the ABR ladder, packaging, HLS, DASH, low latency, origin and CDN — and what goes wrong at each handoff.">
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/apple-icon.png">
<link rel="stylesheet" href="/reading.css">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wght@500;600;700&family=Source+Serif+4:opsz,wght@8..60,400;8..60,600&family=JetBrains+Mono:wght@400;500&display=swap">
</head>
<body>

<div class="bars" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div>

<div class="site-shell">
  <nav class="site-nav" aria-label="Site">
    <a class="site-nav-brand" href="/">Splice<span>Check</span></a>

    <div class="site-nav-group">
      <h2>Tool</h2>
      <ul>
${links(TOOL)}
      </ul>
    </div>

    <div class="site-nav-group">
      <h2>Reading</h2>
      <ul>
${links(READING)}
      </ul>
    </div>

    <div class="site-nav-toc">
      <h2>On this page</h2>
      <ol>
${toc}
      </ol>
    </div>

    <div class="site-nav-foot">
      <a href="https://github.com/sthavana/splicecheck">Source</a>
    </div>
  </nav>

  <div class="site-main">
    <div class="shell wide">

      <header class="masthead">
        <p class="eyebrow">Streaming video · reference</p>
        <h1>How a stream gets to a viewer</h1>
        <p class="standfirst">Four systems, four handoffs, and a manifest that is the
        only thing a player ever sees. What each stage promises — and what it looks
        like from outside when one of them stops keeping its promise.</p>
      </header>

      <main>
${html}
      </main>
    </div>
  </div>
</div>
</body>
</html>
`;

writeFileSync("public/streaming.html", page);
console.log(`wrote public/streaming.html (${page.length} bytes, ${sections.length} sections)`);
