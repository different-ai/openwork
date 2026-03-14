import { expect, test } from "@playwright/test";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const fixtureDir = path.dirname(fileURLToPath(import.meta.url));
const acpRouterSkill = readFileSync(
  path.join(fixtureDir, "fixtures", "acp-router-skill.md"),
  "utf8",
);

const skillName = extractFrontmatterName(acpRouterSkill) ?? "acp-router";
const skillDescription = "Skill generated from ACProuter SKILL.md fixture";
const openworkShareArtifactsDir = path.resolve(process.cwd(), "../../tmp/openwork-share-playwright");

const openworkAppBaseUrl = (process.env.OPENWORK_APP_URL ?? "http://localhost:5173").trim() || "http://localhost:5173";

function parseShareLinkParams(rawLink: string): URLSearchParams {
  const normalized = rawLink.trim();
  if (!normalized) {
    return new URLSearchParams();
  }

  if (normalized.startsWith("openwork://")) {
    const questionIndex = normalized.indexOf("?");
    return new URLSearchParams(questionIndex === -1 ? "" : normalized.slice(questionIndex + 1));
  }

  if (normalized.startsWith("http://") || normalized.startsWith("https://")) {
    try {
      return new URLSearchParams(new URL(normalized).search);
    } catch {
      // fall back to lightweight query extraction
    }
  }

  const questionIndex = normalized.indexOf("?");
  if (questionIndex > -1) {
    return new URLSearchParams(normalized.slice(questionIndex + 1));
  }

  if (/[?&]ow_bundle=/.test(normalized) || /[?&]ow_intent=/.test(normalized) || /[?&]ow_label=/.test(normalized)) {
    return new URLSearchParams(normalized);
  }

  return new URLSearchParams();
}

function escapeForRegex(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

async function captureEvidence(page: import("@playwright/test").Page, filename: string): Promise<void> {
  mkdirSync(openworkShareArtifactsDir, { recursive: true });
  await page.screenshot({ path: path.join(openworkShareArtifactsDir, filename), fullPage: true });
}

async function resolveChatComposer(page: import("@playwright/test").Page): Promise<import("@playwright/test").Locator | null> {
  const candidates = [
    page.getByRole("textbox", { name: /message|chat/i }),
    page.getByPlaceholder(/message|chat/i),
    page.getByRole("textbox"),
    page.locator("[contenteditable='true'][role='textbox']").first(),
    page.locator("[contenteditable='true']").first(),
    page.locator("textarea").first(),
    page.locator("input[type='text']").first(),
  ];

  for (const candidate of candidates) {
    const count = await candidate.count().catch(() => 0);
    if (count === 0) {
      continue;
    }

    if (await candidate.first().isVisible({ timeout: 200 }).catch(() => false)) {
      return candidate.first();
    }
  }

  return null;
}

async function submitChatMessage(page: import("@playwright/test").Page, message: string): Promise<boolean> {
  const composer = await resolveChatComposer(page);
  if (!composer) {
    return false;
  }

  await composer.click();
  await composer.fill("");
  await composer.type(message, { delay: 0 });
  await captureEvidence(page, "chat-message-typed.png");

  const sendButton = page.getByRole("button", { name: /send/i });
  if (await sendButton.isVisible().catch(() => false)) {
    await sendButton.first().click();
    return true;
  }

  await composer.press("Enter");
  return true;
}

async function hasWorkerSetupBranch(page: import("@playwright/test").Page): Promise<boolean> {
  return (
    (await page.getByRole("heading", { name: /create or connect a worker/i }).isVisible().catch(() => false)) ||
    (await page.getByText(/openwork needs a local or remote worker/i).isVisible().catch(() => false)) ||
    (await page.getByText(/session idle/i).isVisible().catch(() => false))
  );
}

async function waitForOpenInAppShareLink(page: import("@playwright/test").Page): Promise<string> {
  const deadline = Date.now() + 45_000;
  let lastError: Error | null = null;

  while (Date.now() < deadline) {
    try {
      const linkSelectors = [
        page.getByRole("link", { name: /open in openwork app/i }),
        page.getByRole("link", { name: /open in openwork/i }),
        page.locator("a[href^='openwork://import-bundle']").first(),
        page.locator("a[href*='ow_bundle=']").first(),
        page.locator("a[href*='share.openwork.software/b/']").first(),
      ];

      for (const locator of linkSelectors) {
        const count = await locator.count();
        if (count === 0) {
          continue;
        }

        const openInAppLink = locator.first();
        const href = (await openInAppLink.getAttribute("href"))?.trim();
        if (href) {
          return href;
        }
      }

      const anyShareAnchor = page.locator("a[href]").filter({ hasText: /open in/i }).first();
      const anyCount = await anyShareAnchor.count();
      if (anyCount > 0) {
        const href = (await anyShareAnchor.getAttribute("href"))?.trim();
        if (href) {
          return href;
        }
      }

      const fallback = page.locator("a[href]").first();
      const fallbackCount = await fallback.count();
      if (fallbackCount > 0) {
        const href = (await fallback.getAttribute("href"))?.trim();
        if (href) {
          return href;
        }
      }

      await new Promise((resolve) => setTimeout(resolve, 250));
      continue;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  await captureEvidence(page, "chat-share-link-missing.png");
  throw new Error(`Could not find an OpenWork import/open-in-app link in the chat output: ${lastError?.message || "timed out"}`);

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

async function createShareFromChat(page: import("@playwright/test").Page) {
  await page.goto(openworkAppBaseUrl);
  const hasNewSkill = await submitChatMessage(page, "/new-skill");
  if (!hasNewSkill) {
    return { openInAppHref: "", mode: "blocked" as const };
  }

  await page.waitForTimeout(500);
  const hasCreator = await submitChatMessage(page, "/skill-creator");
  if (!hasCreator) {
    return { openInAppHref: "", mode: "blocked" as const };
  }

  await page.waitForTimeout(500);
  const hasBody = await submitChatMessage(page, acpRouterSkill);
  if (!hasBody) {
    return { openInAppHref: "", mode: "blocked" as const };
  }

  await waitForOpenworkApp(page.request);
  await page.waitForTimeout(750);
  const openInAppHref = await waitForOpenInAppShareLink(page);
  expect(openInAppHref, "open in app link should exist").toBeTruthy();

  await captureEvidence(page, "chat-import-share-link.png");
  return { openInAppHref: openInAppHref || "", mode: "chat" as const };
}

function assertImportIntent(params: URLSearchParams, label: string) {
  expect(
    ["new_worker", "import_current", "import"].includes(params.get("ow_intent") || ""),
    `${label}: observed intent should be supported`,
  ).toBe(true);
}

function assertFixtureLabel(params: URLSearchParams) {
  expect(params.get("ow_label"), "label should come from fixture frontmatter").toBe(skillName);
}

async function assertDestinationPickerOpen(page: import("@playwright/test").Page) {
  const modalHeading = page.getByRole("heading", { name: /where should this skill go\?/i });
  const blockedHeading = page.getByRole("heading", { name: /create or connect a worker/i });
  const actionablePickerChoices = [
    page.getByRole("button", { name: /create new worker/i }),
    page.getByRole("button", { name: /create local worker/i }),
    page.getByRole("button", { name: /connect remote worker/i }),
    page.getByRole("button", { name: /existing workers/i }),
  ];

  await expect(modalHeading.or(blockedHeading)).toBeVisible({ timeout: 20_000 });

  if (await blockedHeading.isVisible()) {
    await expect(page.getByRole("button", { name: /create local worker/i })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("button", { name: /connect remote worker/i })).toBeVisible({ timeout: 20_000 });
    await expect(
      page.getByText(/openwork needs a local or remote worker before you can start a session/i),
    ).toBeVisible();
    return;
  }

  await expect(
    page.getByText(/where should this skill go\?|existing workers|select.*worker|no workers are ready/i),
  ).toBeVisible();
  const visibleChoice = await Promise.all(
    actionablePickerChoices.map((choice) => choice.isVisible().then((value) => ({ choice, value }))),
  );
  expect(
    visibleChoice.some(({ value }) => value),
    "destination chooser should expose at least one actionable path",
  ).toBe(true);
  await captureEvidence(page, "chat-or-share-import-destination.png");
}

test("import flow via /new-skill + /skill-creator in OpenWork chat", async ({ page, request }) => {
  await waitForOpenworkApp(request);

  const { openInAppHref, mode } = await createShareFromChat(page);
  if (mode === "blocked") {
    await expect(await hasWorkerSetupBranch(page)).toBeTruthy();
    await captureEvidence(page, "chat-import-blocked-setup-route.png");
    await assertDestinationPickerOpen(page);
    return;
  }

  const params = parseShareLinkParams(openInAppHref);
  const shareUrl = params.get("ow_bundle");
  expect(shareUrl, "chat path should include ow_bundle").toBeTruthy();
  expect(openInAppHref.includes("openwork://import-bundle") || openInAppHref.includes("ow_bundle="), "chat flow should expose import params");
  assertFixtureLabel(params);
  assertImportIntent(params, "chat");

  expect(params.get("ow_source"), "source should be share service").toBe("share_service");
  const appUrl = toWebAppUrl(openInAppHref);
  await page.goto(appUrl);
  await expect(page).toHaveURL(new RegExp(`^${escapeForRegex(openworkAppBaseUrl)}(?:/session)?(?:\\?|$|/)`));
  await captureEvidence(page, "chat-import-webapp-route.png");
  await assertDestinationPickerOpen(page);
});

test("import flow via share-page paste path", async ({ page, request }) => {
  await waitForOpenworkApp(request);

  const { shareUrl, openInAppHref } = await createShareLink(page);

  expect(openInAppHref).toContain("openwork://import-bundle?");

  const params = parseShareLinkParams(openInAppHref);
  expect(params.get("ow_source"), "source should be share service").toBe("share_service");
  expect(params.get("ow_bundle"), "ow_bundle should be share URL").toBe(shareUrl);
  assertImportIntent(params, "share-page");
  assertFixtureLabel(params);
  await captureEvidence(page, "share-page-import-link.png");

  const appUrl = toWebAppUrl(openInAppHref);
  await page.goto(appUrl);
  await expect(page).toHaveURL(new RegExp(`^${escapeForRegex(openworkAppBaseUrl)}(?:/session)?(?:\\?|$|/)`));
  await captureEvidence(page, "share-page-import-webapp-route.png");
  await assertDestinationPickerOpen(page);

  const expectedUrl = `${openworkAppBaseUrl}/?ow_bundle=${encodeURIComponent(shareUrl)}&ow_intent=import_current&ow_label=${encodeURIComponent(skillName)}`;
  await page.goto(expectedUrl);
  await captureEvidence(page, "share-page-raw-route.png");
  await assertDestinationPickerOpen(page);

  const routeParams = parseShareLinkParams(expectedUrl);
  expect(routeParams.get("ow_bundle"), "raw share URL should be carried through").toBe(shareUrl);
  expect(routeParams.get("ow_intent"), "intent should be import_current").toBe("import_current");
  assertFixtureLabel(routeParams);
});
