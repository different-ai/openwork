import { expect, test, type Page } from "@playwright/test";

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
  const ogImageUrl = await page.locator('meta[property="og:image"]').getAttribute("content");
  const ogTitle = await page.locator('meta[property="og:title"]').getAttribute("content");
  const ogDescription = await page.locator('meta[property="og:description"]').getAttribute("content");
  const twitterCard = await page.locator('meta[name="twitter:card"]').getAttribute("content");

  expect(ogImageUrl).toBeTruthy();
  expect(ogImageUrl).toContain("/og/");
  expect(ogTitle).toBe("agent-creator");
  expect(ogDescription).toBe("Create new OpenCode agents with a gpt-5.2-codex default.");
  expect(twitterCard).toBe("summary_large_image");

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

  const svgResponse = await page.request.get(`${ogImageUrl!}?format=svg`);
  expect(svgResponse.ok()).toBeTruthy();
  expect(svgResponse.headers()["content-type"] ?? "").toContain("image/svg+xml");

  const svg = await svgResponse.text();
  expect(svg).toContain("Agent Creator");
  expect(svg).toContain("agent-creator.md");
  expect(svg).toContain("SKILL.md");
  expect(svg).toContain("share.openwork.software");
  expect(svg).not.toContain("Any markdown body is acceptable here.");

  const pastePreviewHtml = await page.content();
  expect(pastePreviewHtml).toContain(shareUrl);
});
