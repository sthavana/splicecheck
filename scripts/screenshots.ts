/**
 * Regenerate the README screenshots.
 *
 *   npm run dev          # in one shell
 *   npx tsx scripts/screenshots.ts
 *
 * Captures against the recorded sample bundles rather than live origins, so
 * the images stay reproducible.
 */

import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const BASE = process.env.SPLICECHECK_URL ?? "http://localhost:3001";
const OUT = "docs";
const VIEWPORT = { width: 1280, height: 900 };

async function main() {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: VIEWPORT,
    deviceScaleFactor: 2,
    colorScheme: "dark",
  });

  // --- inspector, multi-period DASH -------------------------------------
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: /Multi-period DASH/ }).click();
  await page.waitForSelector('[data-shot="periods"]', { timeout: 60_000 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/inspector-dash.png` });
  console.log("captured inspector-dash.png");

  // The period timeline is the distinctive DASH view; capture it directly.
  await page.locator('[data-shot="periods"]').screenshot({ path: `${OUT}/inspector-periods.png` });
  console.log("captured inspector-periods.png");

  // Expand a break to show the decoded SCTE-35.
  const firstBreak = page.locator("button", { hasText: /Provider Advertisement/ }).first();
  if (await firstBreak.count()) {
    await firstBreak.click();
    await page.waitForSelector('[data-shot="break-detail"]', { timeout: 20_000 });
    await page.waitForTimeout(400);
    await firstBreak.locator("xpath=..").screenshot({ path: `${OUT}/inspector-scte35.png` });
    console.log("captured inspector-scte35.png");
  }

  // --- pipeline comparison ----------------------------------------------
  await page.goto(`${BASE}/compare`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: /Run the worked example/ }).click();
  await page.waitForSelector("text=Fill rate", { timeout: 60_000 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/pipeline-compare.png`, fullPage: false });
  console.log("captured pipeline-compare.png");

  // --- simulator ---------------------------------------------------------
  // The chain first, clean, with the stitched output on screen: this is the
  // shot that shows the manifests are generated rather than canned.
  await page.goto(`${BASE}/simulator`, { waitUntil: "networkidle" });
  await page.waitForSelector("text=Chain simulator, text=Encoder", { timeout: 60_000 }).catch(() => {});
  await page.getByRole("button", { name: /^SSAI/ }).click();
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${OUT}/simulator.png` });
  console.log("captured simulator.png");

  // The SCTE-35 the encoder emits, decoded back by this project's own parser.
  await page.getByRole("button", { name: /^Encoder/ }).click();
  await page.waitForSelector("text=SCTE-35 as the encoder emits it", { timeout: 20_000 });
  await page.waitForTimeout(600);
  await page
    .locator("section", { hasText: "SCTE-35 as the encoder emits it" })
    .first()
    .screenshot({ path: `${OUT}/simulator-encoder.png` });
  console.log("captured simulator-encoder.png");

  // The stitched manifest, to show the output is generated rather than canned.
  await page.getByRole("button", { name: /^SSAI/ }).click();
  await page.waitForTimeout(900);
  await page
    .locator("section", { hasText: "SSAI output" })
    .first()
    .screenshot({ path: `${OUT}/simulator-manifest.png` });
  console.log("captured simulator-manifest.png");

  // A fault switched on and caught, which is the point of the whole thing.
  // Under-fill is the one to show: it lands on the stitched output, so the
  // finding and the comparison that grades it appear side by side. A fault
  // belonging to the source manifest would leave this panel correctly empty.
  // By label, not by index: adding a control to the page should not silently
  // repoint this at a different one.
  await page
    .locator("label")
    .filter({ hasText: "Ad service behaviour" })
    .locator("select")
    .selectOption("under-fill");
  await page.waitForTimeout(2500);
  await page
    .locator("section", { hasText: "The inspector on" })
    .first()
    .screenshot({ path: `${OUT}/simulator-fault.png` });
  console.log("captured simulator-fault.png");

  // --- monitors ----------------------------------------------------------
  await page.goto(`${BASE}/monitors`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1500); // let the first poll render
  await page.screenshot({ path: `${OUT}/monitors.png`, fullPage: false });
  console.log("captured monitors.png");

  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
