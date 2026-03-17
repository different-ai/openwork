import { expect, test } from "@playwright/test";

const initialBody = `---
name: agent-creator
description: Create new OpenCode agents with a gpt-5.2-codex default.
---

# Agent Creator

Any markdown body is acceptable here.
`;

test("shows a read-only shared skill page with OpenWork import actions", async ({ page }) => {
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

  const shareUrl = page.url();

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
