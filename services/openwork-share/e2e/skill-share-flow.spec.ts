import { expect, test } from "@playwright/test";

const uploadedBody = `# Agent Creator

Any markdown body is acceptable here.
`;

test("uploads a single skill and redirects to the generated share page", async ({ page }) => {
  await page.goto("/");

  await page.getByLabel("Skill name").fill("agent-creator");
  await page.getByLabel("Skill description").fill("Create new OpenCode agents with a gpt-5.2-codex default.");

  const fileInput = page.locator('input[type="file"]');
  await fileInput.setInputFiles({
    name: "AGENTS.md",
    mimeType: "text/markdown",
    buffer: Buffer.from(uploadedBody, "utf8"),
  });

  const editor = page.locator(".preview-editor");
  await expect(editor).toHaveValue(uploadedBody);
  await expect(page.getByRole("button", { name: /generate share link/i })).toBeEnabled();

  await Promise.all([
    page.waitForURL(/\/b\/[0-9A-HJKMNP-TV-Z]{26}$/),
    page.getByRole("button", { name: /generate share link/i }).click(),
  ]);

  await expect(page.locator("main")).toContainText("agent-creator");
  await expect(page.getByLabel("Skill name")).toHaveCount(0);
  await expect(page.getByLabel("Skill description")).toHaveCount(0);
  await expect(page.locator(".share-frontmatter-preview")).toContainText("name: agent-creator");
  await expect(page.locator(".share-frontmatter-preview")).toContainText(
    "description: Create new OpenCode agents with a gpt-5.2-codex default.",
  );
  await expect(page.locator(".preview-highlight")).toContainText("Any markdown body is acceptable here.");
});

test("shows an inline error when the required frontmatter fields are empty", async ({ page }) => {
  await page.goto("/");

  await page.getByLabel("Skill name").fill("");
  await page.getByLabel("Skill description").fill("");
  await expect(page.locator(".package-status-label")).toContainText(/name and description/i);
  await expect(page.getByRole("button", { name: /generate share link/i })).toBeDisabled();
  await expect(page).toHaveURL(/\/$/);
});

test("shows an inline error when multiple files are uploaded", async ({ page }) => {
  await page.goto("/");

  const fileInput = page.locator('input[type="file"]');
  await fileInput.setInputFiles([
    {
      name: "something.txt",
      mimeType: "text/markdown",
      buffer: Buffer.from(uploadedBody, "utf8"),
    },
    {
      name: "notes.md",
      mimeType: "text/markdown",
      buffer: Buffer.from("extra notes", "utf8"),
    },
  ]);

  await expect(page.locator(".package-status-label")).toContainText(/single skill/i);
  await expect(page.getByRole("button", { name: /generate share link/i })).toBeDisabled();
});
