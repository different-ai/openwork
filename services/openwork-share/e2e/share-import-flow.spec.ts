import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const fixtureDir = path.dirname(fileURLToPath(import.meta.url));
const acpRouterSkill = readFileSync(
  path.join(fixtureDir, "fixtures", "acp-router-skill.md"),
  "utf8",
);

const skillName = extractFrontmatterName(acpRouterSkill) ?? "acp-router";
const skillDescription = "Skill generated from ACProuter SKILL.md fixture";

const openworkAppBaseUrl = (process.env.OPENWORK_APP_URL ?? "http://localhost:5173").trim() || "http://localhost:5173";

function parseShareLinkParams(rawLink: string): URLSearchParams {
  const questionIndex = rawLink.indexOf("?");
  return new URLSearchParams(questionIndex === -1 ? "" : rawLink.slice(questionIndex + 1));
}

function escapeForRegex(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function waitForOpenworkApp(requestContext: import("@playwright/test").APIRequestContext): Promise<void> {
  const deadline = Date.now() + 30_000;
  let lastError: Error | null = null;

  while (Date.now() < deadline) {
    try {
      const response = await requestContext.get(openworkAppBaseUrl, { maxRedirects: 0 });
      if (response.status() >= 200 && response.status() < 600) {
        return;
      }
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(`OpenWork app not reachable at ${openworkAppBaseUrl}: ${lastError?.message || "timed out"}`);
}

function extractFrontmatterName(value: string): string | null {
  const match = String(value ?? "").match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;
  const frontmatter = match[1] ?? "";
  const nameLine = frontmatter.split("\n").find((line) => /^\s*name\s*:/i.test(line));
  if (!nameLine) return null;
  const raw = nameLine.split(":").slice(1).join(":").trim();
  if (!raw) return null;
  return raw.replace(/^["']|["']$/g, "");
}

function toWebAppUrl(openWorkLikeUrl: string): string {
  if (/^https?:\/\//i.test(openWorkLikeUrl)) {
    return openWorkLikeUrl;
  }

  const appUrl = new URL(openworkAppBaseUrl);
  const origin = `${appUrl.origin}${appUrl.pathname && appUrl.pathname !== "/" ? appUrl.pathname : ""}`;
  const query = parseShareLinkParams(openWorkLikeUrl);
  const destination = new URLSearchParams();
  for (const [name, value] of query.entries()) {
    destination.set(name, value);
  }

  return `${origin}/?${destination.toString()}`;
}

async function createShareLink(page: import("@playwright/test").Page) {
  await page.goto("/");

  await page.getByLabel("Skill name").fill(skillName);
  await page.getByLabel("Skill description").fill(skillDescription);

  await page.locator('input[type="file"]').setInputFiles({
    name: "SKILL.md",
    mimeType: "text/markdown",
    buffer: Buffer.from(acpRouterSkill, "utf8"),
  });

  const [response] = await Promise.all([
    page.waitForURL(/\/b\/[0-9A-HJKMNP-TV-Z]{26}$/),
    page.getByRole("button", { name: /generate share link/i }).click(),
  ]);

  const shareUrl = page.url();
  const openInAppLink = page.getByRole("link", { name: /^open in openwork app$/i });
  await expect(openInAppLink).toBeVisible();

  const openInAppHref = (await openInAppLink.getAttribute("href"))?.trim();
  expect(openInAppHref, "open in app link should exist").toBeTruthy();

  return { shareUrl, response, openInAppHref: openInAppHref || "" };
}

async function assertDestinationPickerOpen(page: import("@playwright/test").Page) {
  const modalHeading = page.getByRole("heading", { name: /where should this skill go\?/i });
  const blockedHeading = page.getByRole("heading", { name: /create or connect a worker/i });

  await expect(modalHeading.or(blockedHeading)).toBeVisible({ timeout: 20_000 });

  if (await blockedHeading.isVisible()) {
    await expect(page.getByRole("button", { name: /create local worker/i })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("button", { name: /connect remote worker/i })).toBeVisible({ timeout: 20_000 });
    await expect(
      page.getByText(/openwork needs a local or remote worker before you can start a session/i),
    ).toBeVisible();
    return;
  }

  await expect(page.getByText(/existing workers/i)).toBeVisible();
  await expect(page.getByText(skillName, { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: /connect remote worker/i })).toBeVisible({ timeout: 20_000 });
  await expect(
    page
      .getByRole("button", { name: /create new worker/i })
      .or(page.getByText(/no workers are ready yet\. Create one or connect a remote worker to install this skill\./i)),
  ).toBeVisible({ timeout: 20_000 });
}

test("import flow parses openwork:// link from share page in web app", async ({ page, request }) => {
  await waitForOpenworkApp(request);

  const { shareUrl, openInAppHref } = await createShareLink(page);

  expect(openInAppHref).toContain("openwork://import-bundle?");

  const params = parseShareLinkParams(openInAppHref);
  expect(params.get("ow_bundle"), "ow_bundle should be share URL").toBe(shareUrl);
  expect(params.get("ow_intent"), "intent should be new_worker").toBe("new_worker");
  expect(params.get("ow_label"), "label should come from skill frontmatter").toBe(skillName);
  expect(params.get("ow_source"), "source should be share service").toBe("share_service");

  const appUrl = toWebAppUrl(openInAppHref);
  await page.goto(appUrl);
  await assertDestinationPickerOpen(page);
});

test("import flow parses raw share URL via web-app route and preserves intent context", async ({ page, request }) => {
  await waitForOpenworkApp(request);

  const { shareUrl } = await createShareLink(page);

  const expectedUrl = `${openworkAppBaseUrl}/?ow_bundle=${encodeURIComponent(shareUrl)}&ow_intent=import_current&ow_label=${encodeURIComponent(skillName)}`;
  await page.goto(expectedUrl);
  await expect(page).toHaveURL(new RegExp(`^${escapeForRegex(openworkAppBaseUrl)}(?:/session)?(?:\\?|$|/)`));

  await assertDestinationPickerOpen(page);

  const params = parseShareLinkParams(expectedUrl);
  expect(params.get("ow_bundle"), "raw share URL should be carried through").toBe(shareUrl);
  expect(params.get("ow_intent"), "intent should be import_current").toBe("import_current");
});
