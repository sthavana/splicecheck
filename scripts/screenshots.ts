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
