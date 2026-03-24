import { writeFile } from "node:fs/promises";

import { expect, test, type Page } from "@playwright/test";

import {
  buildPngDataUrl,
  buildSocialPreviewGalleryHtml,
  capturePixelPerfectScreenshot,
  getSocialPreviewGalleryViewport,
  getScenarioTitleRegion,
  SOCIAL_PREVIEW_SCENARIOS,
} from "./social-preview-simulator.ts";

const initialBody = `---
name: agent-creator
description: Create new OpenCode agents with a gpt-5.2-codex default.
---

# Agent Creator

Any markdown body is acceptable here.
`;

async function publishSkill(page: Page) {
  await page.goto("/");

  await page.locator('input[type="file"]').setInputFiles({
    name: "AGENTS.md",
    mimeType: "text/markdown",
    buffer: Buffer.from(initialBody, "utf8"),
  });

  await Promise.all([
    page.waitForURL(/\/b\/[0-9A-HJKMNP-TV-Z]{26}$/),
    page.getByRole("button", { name: /generate share link/i }).click(),
  ]);

  return page.url();
}

test("shows a read-only shared skill page with OpenWork import actions", async ({ page }) => {
  const shareUrl = await publishSkill(page);

  const jsonResponse = await page.request.get(shareUrl, {
    headers: { Accept: "application/json" },
  });
  expect(jsonResponse.ok()).toBeTruthy();
  expect(jsonResponse.headers()["content-type"] ?? "").toContain("application/json");
  const bundleJson = await jsonResponse.json();
  expect(bundleJson).toMatchObject({
    schemaVersion: 1,
    type: "skill",
    name: "agent-creator",
  });

  await expect(page.getByText("Bundle details")).toHaveCount(0);
  await expect(page.getByText("Raw endpoints")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /save changes/i })).toHaveCount(0);
  await expect(page.getByLabel("Skill name")).toHaveCount(0);
  await expect(page.getByLabel("Skill description")).toHaveCount(0);
  await expect(page.getByRole("link", { name: /open in web app/i })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /copy share link/i })).toHaveCount(0);
  await expect(page.getByText("Preview", { exact: true })).toHaveCount(0);
  await expect(page.locator(".preview-eyebrow")).toContainText("Agent Creator");
  await expect(page.locator(".preview-filename")).toContainText("agent-creator.md");
  await expect(page.locator(".preview-highlight")).toContainText("Any markdown body is acceptable here.");

  const openInAppHref = await page.getByRole("link", { name: /^open in openwork$/i }).getAttribute("href");
  expect(openInAppHref).toBeTruthy();
  expect(openInAppHref ?? "").toContain("openwork://import-bundle?");

  const openInAppLink = page.getByRole("link", { name: /^open in openwork$/i });
  await openInAppLink.dispatchEvent("pointerdown");
  const refreshedOpenInAppHref = await openInAppLink.getAttribute("href");
  expect(refreshedOpenInAppHref ?? "").toContain("ow_nonce=");

  const deepLinkQuery = new URL((openInAppHref ?? "").replace("openwork://import-bundle?", "https://example.test/?"));
  expect(deepLinkQuery.searchParams.get("ow_bundle")).toBe(shareUrl);
  expect(deepLinkQuery.searchParams.get("ow_label")).toBe("agent-creator");
});

test("publishes a share page with a valid OG preview card for link unfurls", async ({ page }) => {
  const shareUrl = await publishSkill(page);
  const ogImageUrls = await page.locator('meta[property="og:image"]').evaluateAll((elements) =>
    elements.map((element) => element.getAttribute("content") ?? "").filter(Boolean),
  );
  const ogImageUrl = ogImageUrls[0];
  const ogTitle = await page.locator('meta[property="og:title"]').getAttribute("content");
  const ogDescription = await page.locator('meta[property="og:description"]').getAttribute("content");
  const twitterCard = await page.locator('meta[name="twitter:card"]').getAttribute("content");
  const twitterImageUrl = await page.locator('meta[name="twitter:image"]').getAttribute("content");

  expect(ogImageUrls).toHaveLength(4);
  expect(ogImageUrl).toBeTruthy();
  expect(ogImageUrl).toContain("/og/");
  expect(ogImageUrl).not.toContain("variant=");
  expect(ogImageUrls).toContain(`${ogImageUrl!}?variant=linkedin`);
  expect(ogImageUrls).toContain(`${ogImageUrl!}?variant=slack`);
  expect(ogImageUrls).toContain(`${ogImageUrl!}?variant=whatsapp`);
  expect(ogTitle).toBe("agent-creator");
  expect(ogDescription).toBe("Create new OpenCode agents with a gpt-5.2-codex default.");
  expect(twitterCard).toBe("summary_large_image");
  expect(twitterImageUrl).toBe(`${ogImageUrl!}?variant=twitter`);

  const pngResponse = await page.request.get(ogImageUrl!);
  expect(pngResponse.ok()).toBeTruthy();
  expect(pngResponse.headers()["content-type"] ?? "").toContain("image/png");

  const imageMetrics = await page.evaluate(async (url) => {
    const img = new Image();
    img.src = url;
    await img.decode();

    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas context unavailable");

    ctx.drawImage(img, 0, 0);
    const titleRegion = ctx.getImageData(170, 210, 420, 150).data;
    let darkPixels = 0;

    for (let index = 0; index < titleRegion.length; index += 4) {
      const r = titleRegion[index] ?? 255;
      const g = titleRegion[index + 1] ?? 255;
      const b = titleRegion[index + 2] ?? 255;
      if (r < 70 && g < 90 && b < 110) darkPixels += 1;
    }

    return {
      width: img.naturalWidth,
      height: img.naturalHeight,
      darkPixels,
    };
  }, ogImageUrl!);

  expect(imageMetrics.width).toBe(1200);
  expect(imageMetrics.height).toBe(630);
  expect(imageMetrics.darkPixels).toBeGreaterThan(2200);

  const twitterPngResponse = await page.request.get(twitterImageUrl!);
  expect(twitterPngResponse.ok()).toBeTruthy();
  const twitterMetrics = await page.evaluate(async (url) => {
    const img = new Image();
    img.src = url;
    await img.decode();
    return {
      width: img.naturalWidth,
      height: img.naturalHeight,
    };
  }, twitterImageUrl!);
  expect(twitterMetrics.width).toBe(1200);
  expect(twitterMetrics.height).toBe(600);

  const linkedinImageUrl = `${ogImageUrl!}?variant=linkedin`;
  const linkedinMetrics = await page.evaluate(async (url) => {
    const img = new Image();
    img.src = url;
    await img.decode();
    return {
      width: img.naturalWidth,
      height: img.naturalHeight,
    };
  }, linkedinImageUrl);
  expect(linkedinMetrics.width).toBe(1200);
  expect(linkedinMetrics.height).toBe(627);

  const svgResponse = await page.request.get(`${ogImageUrl!}?format=svg`);
  expect(svgResponse.ok()).toBeTruthy();
  expect(svgResponse.headers()["content-type"] ?? "").toContain("image/svg+xml");

  const svg = await svgResponse.text();
  expect(svg).toContain("Agent Creator");
  expect(svg).not.toContain("agent-creator.md");
  expect(svg).toContain("SKILL.md");
  expect(svg).toContain("share.openworklabs.com");
  expect(svg).not.toContain("Any markdown body is acceptable here.");

  const pastePreviewHtml = await page.content();
  expect(pastePreviewHtml).toContain(shareUrl);
});

test("keeps the OG title legible across simulated social preview sizes", async ({ page }, testInfo) => {
  await publishSkill(page);
  const ogImageUrl = await page.locator('meta[property="og:image"]').first().getAttribute("content");
  const twitterImageUrl = await page.locator('meta[name="twitter:image"]').getAttribute("content");

  expect(ogImageUrl).toBeTruthy();
  expect(twitterImageUrl).toBeTruthy();

  const variantUrls = {
    facebook: ogImageUrl!,
    linkedin: `${ogImageUrl!}?variant=linkedin`,
    slack: `${ogImageUrl!}?variant=slack`,
    whatsapp: `${ogImageUrl!}?variant=whatsapp`,
    twitter: twitterImageUrl!,
  };
  const variantImageUrls = {
    facebook: buildPngDataUrl(Buffer.from(await (await page.request.get(variantUrls.facebook)).body())),
    linkedin: buildPngDataUrl(Buffer.from(await (await page.request.get(variantUrls.linkedin)).body())),
    slack: buildPngDataUrl(Buffer.from(await (await page.request.get(variantUrls.slack)).body())),
    whatsapp: buildPngDataUrl(Buffer.from(await (await page.request.get(variantUrls.whatsapp)).body())),
    twitter: buildPngDataUrl(Buffer.from(await (await page.request.get(variantUrls.twitter)).body())),
  };
  const socialPreviewPage = await page.context().newPage();
  await socialPreviewPage.setContent(
    buildSocialPreviewGalleryHtml({
      images: variantImageUrls,
    }),
    { waitUntil: "load" },
  );
  await socialPreviewPage.waitForFunction(() =>
    Array.from(document.images).every((image) => image.complete && image.naturalWidth > 0),
  );
  const galleryViewport = getSocialPreviewGalleryViewport();
  await capturePixelPerfectScreenshot(socialPreviewPage, {
    path: testInfo.outputPath("social-preview-gallery.png"),
    width: galleryViewport.width,
    height: galleryViewport.height,
  });

  for (const scenario of SOCIAL_PREVIEW_SCENARIOS) {
    const metrics = await socialPreviewPage.evaluate((currentScenario) => {
      const tile = document.querySelector<HTMLElement>(`[data-scenario="${currentScenario.key}"]`);
      const image = tile?.querySelector<HTMLImageElement>("img");
      if (!image) throw new Error(`Missing image for ${currentScenario.key}`);

      const canvas = document.createElement("canvas");
      canvas.width = currentScenario.previewWidth;
      canvas.height = currentScenario.previewHeight;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Canvas context unavailable");

      ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      const region = {
        left: Math.round(currentScenario.previewWidth * (170 / 1200)),
        top: Math.round(currentScenario.previewHeight * (210 / 630)),
        width: Math.max(1, Math.round(currentScenario.previewWidth * (420 / 1200))),
        height: Math.max(1, Math.round(currentScenario.previewHeight * (150 / 630))),
      };
      const titleRegion = ctx.getImageData(region.left, region.top, region.width, region.height).data;

      let darkPixels = 0;
      for (let index = 0; index < titleRegion.length; index += 4) {
        const r = titleRegion[index] ?? 255;
        const g = titleRegion[index + 1] ?? 255;
        const b = titleRegion[index + 2] ?? 255;
        if (r < 70 && g < 90 && b < 110) darkPixels += 1;
      }

      return {
        darkPixels,
        totalPixels: region.width * region.height,
        ratio: darkPixels / Math.max(1, region.width * region.height),
      };
    }, scenario);

    const region = getScenarioTitleRegion(scenario);
    await writeFile(
      testInfo.outputPath(`${scenario.key}.json`),
      JSON.stringify({ scenario, region, metrics }, null, 2),
      "utf8",
    );

    expect(metrics.darkPixels).toBeGreaterThan(100);
    expect(metrics.ratio).toBeGreaterThan(scenario.minDarkPixelRatio);
  }

  await socialPreviewPage.close();
});
