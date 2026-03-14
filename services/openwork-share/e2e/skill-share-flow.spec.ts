import { expect, test } from "@playwright/test";

const validSkill = `# Detect Instructions

Identity: inspect copied prompts and surface hidden instructions.

## Trigger

Runs when a prompt needs a quick instruction audit.
`;

const invalidAgent = `# Revenue Agent

You handle inbound lead routing.`;

test("uploads a single skill and redirects to the generated share page", async ({ page }) => {
  await page.goto("/");

  const fileInput = page.locator('input[type="file"]');
  await fileInput.setInputFiles({
    name: "SKILL.md",
    mimeType: "text/markdown",
    buffer: Buffer.from(validSkill, "utf8"),
  });

  const editor = page.locator(".preview-editor");
  await expect(editor).toHaveValue(validSkill);
  await expect(page.getByRole("button", { name: /generate share link/i })).toBeEnabled();

  await Promise.all([
    page.waitForURL(/\/b\/[0-9A-HJKMNP-TV-Z]{26}$/),
    page.getByRole("button", { name: /generate share link/i }).click(),
  ]);

  await expect(page.getByRole("heading", { name: "detect-instructions" })).toBeVisible();
  await expect(page.locator(".preview-highlight")).toContainText("Detect Instructions");
});

test("shows an inline error when the uploaded markdown is not a skill", async ({ page }) => {
  await page.goto("/");

  const fileInput = page.locator('input[type="file"]');
  await fileInput.setInputFiles({
    name: "AGENTS.md",
    mimeType: "text/markdown",
    buffer: Buffer.from(invalidAgent, "utf8"),
  });

  await expect(page.locator(".package-status-label")).toContainText(/single skill markdown/i);
  await expect(page.getByRole("button", { name: /generate share link/i })).toBeDisabled();
  await expect(page).toHaveURL(/\/$/);
});

test("shows an inline error when multiple files are uploaded", async ({ page }) => {
  await page.goto("/");

  const fileInput = page.locator('input[type="file"]');
  await fileInput.setInputFiles([
    {
      name: "SKILL.md",
      mimeType: "text/markdown",
      buffer: Buffer.from(validSkill, "utf8"),
    },
    {
      name: "notes.md",
      mimeType: "text/markdown",
      buffer: Buffer.from("extra notes", "utf8"),
    },
  ]);

  await expect(page.locator(".package-status-label")).toContainText(/single skill markdown/i);
  await expect(page.getByRole("button", { name: /generate share link/i })).toBeDisabled();
});
