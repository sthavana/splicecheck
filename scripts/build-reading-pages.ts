/**
 * Renders the markdown in content/ into the static reading pages.
 *
 * The prose stays markdown so it is editable and diffable; this adds the page
 * shell, the shared typography and the site chrome. Run it after editing any
 * of them:
 *
 *   npx tsx scripts/build-reading-pages.ts
 */

import { readFileSync, writeFileSync } from "node:fs";
import { marked } from "marked";

interface PageSpec {
  /** Source markdown, relative to the repository root. */
  source: string;
  /** Where the rendered page is written. */
  out: string;
  /** The path it is served at, which is also how the nav marks it current. */
  url: string;
  title: string;
  eyebrow: string;
  standfirst: string;
  description: string;
}

const PAGES: PageSpec[] = [
  {
    source: "content/streaming.md",
    out: "public/streaming.html",
    url: "/streaming",
    title: "How a stream gets to a viewer",
    eyebrow: "Streaming video · reference",
    standfirst:
      "Four systems, four handoffs, and a manifest that is the only thing a player ever sees. What each stage promises — and what it looks like from outside when one of them stops keeping its promise.",
    description:
      "How video actually reaches a player: the ABR ladder, packaging, HLS, DASH, low latency, origin and CDN — and what goes wrong at each handoff.",
  },
  {
    source: "content/faq.md",
    out: "public/faq.html",
    url: "/faq",
    title: "Where video and ad tech talk past each other",
    eyebrow: "Ad insertion · common ground",
    standfirst:
      "Two groups of competent people, both usually right about their own half. These are the disagreements that come up again and again — because a word means two things, or because a fault in one half only becomes visible in the other.",
    description:
      "The recurring misunderstandings between video engineering and ad technology: fill rate meaning two things, why VPAID cannot be stitched, why an empty ad response is technically a success, and why every fault looks like an unfilled avail.",
  },
  {
    source: "content/ad-response.md",
    out: "public/ad-response.html",
    url: "/ad-response",
    title: "The ad response",
    eyebrow: "Ad technology · reference",
    standfirst:
      "SCTE-35 says an avail exists. VAST says what goes in it. This is the half of ad insertion that is written for a player — and server-side insertion is not one.",
    description:
      "VAST and VMAP in depth: the document structure, wrappers and chains, tracking and error reporting, ad pods, and everything that changes when the thing consuming the response is a stitcher rather than a browser.",
  },
];

const NAV_GROUPS: { title: string; note: string; items: [string, string][] }[] = [
  {
    title: "Tool",
    note: "Point it at a live stream",
    items: [
      ["/", "Inspector"],
      ["/scte104", "SCTE-104"],
      ["/compare", "Pipeline comparison"],
      ["/monitors", "Monitors"],
      ["/vast", "Ad response"],
    ],
  },
  {
    title: "Simulator",
    note: "Build a stream, then break it",
    items: [["/simulator", "Chain simulator"]],
  },
  {
    title: "Reading",
    note: "How the chain works",
    items: [
      ["/guide", "Ad insertion"],
      ["/ad-response", "The ad response"],
      ["/streaming", "Delivery chain"],
      ["/faq", "Video vs ad tech"],
      ["/notes/fifty-five-alerts", "Fifty-five alerts"],
    ],
  },
];

/** Heading ids, matching the anchors the markdown already links to. */
const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");

function render(spec: PageSpec): void {
  const md = readFileSync(spec.source, "utf8");

  // Drop the markdown's own title and inline contents: the page supplies a
  // masthead and a sticky rail instead.
  const withoutTitle = md.replace(/^#\s+.*\n/, "");
  const contentsStart = withoutTitle.indexOf("**Contents**");
  const contentsEnd = withoutTitle.indexOf("---", contentsStart);
  const body =
    contentsStart >= 0 && contentsEnd > contentsStart
      ? withoutTitle.slice(0, contentsStart) + withoutTitle.slice(contentsEnd + 3)
      : withoutTitle;

  marked.setOptions({ gfm: true, breaks: false });
  let html = marked.parse(body) as string;

  const sections: { id: string; title: string }[] = [];
  html = html.replace(/<h2>(.*?)<\/h2>/g, (_m, inner: string) => {
    const id = slug(inner);
    const numbered = /^(\d+)\.\s*(.*)$/.exec(inner.replace(/<[^>]+>/g, ""));
    const num = numbered ? numbered[1].padStart(2, "0") : "";
    const title = numbered ? numbered[2] : inner;
    sections.push({ id, title });
    return `<section id="${id}"><h2>${num ? `<span class="sec-num">${num}</span>` : ""}${title}</h2>`;
  });
  html = html.replace(/<section id=/g, (m, offset: number) =>
    offset === html.indexOf("<section id=") ? m : `</section>${m}`,
  );
  html += "</section>";

  // Cross-references to the other project.
  html = html.replace(
    /<p><strong>StreamPulse:<\/strong>([\s\S]*?)<\/p>/g,
    (_m, rest: string) => `<div class="xref"><span class="tag">In StreamPulse</span><p>${rest.trim()}</p></div>`,
  );
  // A paragraph opening "SpliceCheck:" is what the tool does about the section.
  html = html.replace(
    /<p><strong>SpliceCheck:<\/strong>([\s\S]*?)<\/p>/g,
    (_m, rest: string) => `<div class="xref"><span class="tag">In SpliceCheck</span><p>${rest.trim()}</p></div>`,
  );

  html = html.replace(/<table>/g, '<div class="tablewrap"><table>').replace(/<\/table>/g, "</table></div>");

  const toc = sections.map((s) => `        <li><a href="#${s.id}">${s.title}</a></li>`).join("\n");

  const nav = NAV_GROUPS.map(
    (g) => `    <div class="site-nav-group">
      <h2>${g.title}</h2>
      <p class="site-nav-note">${g.note}</p>
      <ul>
${g.items
  .map(
    ([href, label]) =>
      `        <li><a href="${href}"${href === spec.url ? ' aria-current="page"' : ""}>${label}</a></li>`,
  )
  .join("\n")}
      </ul>
    </div>`,
  ).join("\n\n");

  const page = `<!doctype html>
  <html lang="en">
  <head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${spec.title}</title>
  <meta name="description" content="${spec.description}">
  <link rel="icon" href="/icon.svg" type="image/svg+xml">
  <link rel="apple-touch-icon" href="/apple-icon.png">
  <meta property="og:title" content="${spec.title}">
  <meta property="og:description" content="${spec.description}">
  <meta property="og:type" content="article">
  <meta property="og:url" content="https://splicecheck.vercel.app${spec.url}">
  <meta property="og:image" content="https://splicecheck.vercel.app/og.png">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:image" content="https://splicecheck.vercel.app/og.png">
  <link rel="stylesheet" href="/reading.css">
  <script src="/theme.js"></script>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wght@500;600;700&family=Source+Serif+4:opsz,wght@8..60,400;8..60,600&family=JetBrains+Mono:wght@400;500&display=swap">
  </head>
  <body>

  <div class="bars" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div>

  <div class="site-shell">
    <nav class="site-nav" aria-label="Site">
      <a class="site-nav-brand" href="/">Splice<span>Check</span></a>

  ${nav}

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
          <p class="eyebrow">${spec.eyebrow}</p>
          <h1>${spec.title}</h1>
          <p class="standfirst">${spec.standfirst}</p>
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

  writeFileSync(spec.out, page);
  console.log(`wrote ${spec.out} (${Math.round(page.length / 1024)}KB, ${sections.length} sections)`);
}

for (const spec of PAGES) render(spec);
