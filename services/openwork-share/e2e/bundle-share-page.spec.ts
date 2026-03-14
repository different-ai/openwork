import { expect, test } from "@playwright/test";

const initialBody = `# Agent Creator

Any markdown body is acceptable here.
`;

test("edits a shared skill, republishes it, and keeps the OpenWork import link pointed at the new bundle", async ({ page }) => {
  await page.goto("/");

  await page.getByLabel("Skill name").fill("agent-creator");
  await page.getByLabel("Skill description").fill("Create new OpenCode agents with a gpt-5.2-codex default.");

  await page.locator('input[type="file"]').setInputFiles({
    name: "AGENTS.md",
    mimeType: "text/markdown",
    buffer: Buffer.from(initialBody, "utf8"),
  });

  await Promise.all([
    page.waitForURL(/\/b\/[0-9A-HJKMNP-TV-Z]{26}$/),
    page.getByRole("button", { name: /generate share link/i }).click(),
  ]);

  const firstShareUrl = page.url();

  await expect(page.getByText("Bundle details")).toHaveCount(0);
  await expect(page.getByText("Raw endpoints")).toHaveCount(0);
  await expect(page.locator("main")).not.toContainText("Open in app to choose where to add this skill.");
  await expect(page.locator(".preview-filename")).toContainText("skill.md");

  await page.getByLabel("Skill name").fill("edited-agent-creator");
  await page.getByLabel("Skill description").fill("Edited on the share page.");
  await page.locator(".preview-editor").fill(`# Updated Agent Creator

This copy was edited on the share page.
`);

  await Promise.all([
    page.waitForURL((url) => /\/b\/[0-9A-HJKMNP-TV-Z]{26}$/.test(url.toString()) && url.toString() !== firstShareUrl),
    page.getByRole("button", { name: /save changes/i }).click(),
  ]);

  const secondShareUrl = page.url();
  expect(secondShareUrl).not.toBe(firstShareUrl);

  await expect(page.getByLabel("Skill name")).toHaveValue("edited-agent-creator");
  await expect(page.getByLabel("Skill description")).toHaveValue("Edited on the share page.");
  await expect(page.locator(".preview-highlight")).toContainText("This copy was edited on the share page.");

  const openInAppHref = await page.getByRole("link", { name: /^open in app$/i }).getAttribute("href");
  expect(openInAppHref).toBeTruthy();
  expect(openInAppHref ?? "").toContain("openwork://import-bundle?");

  const deepLinkQuery = new URL((openInAppHref ?? "").replace("openwork://import-bundle?", "https://example.test/?"));
  expect(deepLinkQuery.searchParams.get("ow_bundle")).toBe(secondShareUrl);
  expect(deepLinkQuery.searchParams.get("ow_label")).toBe("edited-agent-creator");
});
