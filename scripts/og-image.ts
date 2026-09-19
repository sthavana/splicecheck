/**
 * Renders public/og.png, the card a shared link shows.
 *
 * A link posted to LinkedIn or Slack with no card reads as broken, so this is
 * not decoration. 1200×630 is the size every platform crops to.
 *
 *   npx tsx scripts/og-image.ts
 */

import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const HTML = `<!doctype html>
<html><head><meta charset="utf-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wght@500;600;700&family=JetBrains+Mono:wght@400;500&display=swap">
<style>
  * { box-sizing: border-box; margin: 0; }
  body {
    width: 1200px; height: 630px; background: #0d1117; color: #e4ebf2;
    font-family: Archivo, system-ui, sans-serif; display: flex; flex-direction: column;
    justify-content: space-between; padding: 58px 68px 48px; position: relative; overflow: hidden;
  }
  .bars { position: absolute; inset: 0 0 auto 0; height: 6px; display: grid; grid-template-columns: repeat(7, 1fr); }
  .bars i:nth-child(1){background:#c0c0c0}.bars i:nth-child(2){background:#c0c000}
  .bars i:nth-child(3){background:#00c0c0}.bars i:nth-child(4){background:#00c000}
  .bars i:nth-child(5){background:#c000c0}.bars i:nth-child(6){background:#c00000}
  .bars i:nth-child(7){background:#0000c0}
  h1 { font-size: 74px; font-weight: 700; letter-spacing: -0.03em; }
  h1 span { color: #f0a04b; }
  p.tag { font-size: 27px; line-height: 1.38; color: #b3c0ce; max-width: 21ch; margin-top: 20px; font-weight: 500; }
  pre {
    font-family: "JetBrains Mono", monospace; font-size: 15.5px; line-height: 1.85;
    background: #141a22; border: 1px solid #232c38; border-radius: 8px;
    padding: 22px 26px; color: #8593a4; white-space: pre;
  }
  .cue { color: #f0a04b; }
  .ad { color: #5fd3a3; }
  .disc { color: #efc27b; }
  .row { flex: 1; display: flex; align-items: center; justify-content: space-between; gap: 54px; }
  .foot { font-family: "JetBrains Mono", monospace; font-size: 17px; color: #8593a4; letter-spacing: 0.02em; }
</style></head>
<body>
  <div class="bars"><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div>
  <div class="row">
    <div>
      <h1>Splice<span>Check</span></h1>
      <p class="tag">Ad signalling in HLS and DASH, end to end.</p>
    </div>
<pre><span class="disc">#EXT-X-DISCONTINUITY</span>
<span class="cue">#EXT-X-CUE-OUT:90.000</span>
#EXTINF:6.000,
<span class="ad">ads/creative-4417/seg_00000.ts</span>
#EXT-X-CUE-OUT-CONT:ELAPSED=6.000
#EXTINF:6.000,
<span class="ad">ads/creative-4417/seg_00001.ts</span></pre>
  </div>
  <div class="foot">inspect · compare · monitor · simulate</div>
</body></html>`;

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
  await page.setContent(HTML, { waitUntil: "networkidle" });
  await page.waitForTimeout(600); // let the webfonts land
  mkdirSync("public", { recursive: true });
  await page.screenshot({ path: "public/og.png" });
  await browser.close();
  console.log("wrote public/og.png");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
