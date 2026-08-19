import { expect } from "vitest";
import { clickButton, evalIn, fill, waitFor } from "@openwork/behaviors";
import { navigate } from "@openwork/cdp";
import { screenshot } from "@openwork/test-evidence";
import { chrome } from "@openwork/hosts";
import {
  localMysqlIsRunning,
  localRedisIsRunning,
  needs,
  selfHostServer,
  test,
  unmetNeeds,
} from "@openwork/testkit";
import type { TestNeeds } from "@openwork/testkit";

const requirements: TestNeeds = { optIn: ["OPENWORK_EVAL_E2E_TESTS"] };
const missingRequirements = unmetNeeds(requirements, process.env);
const daytonaPlacement = process.env.OPENWORK_EVAL_DAYTONA === "1";
const mysqlOpen = await localMysqlIsRunning();
const redisOpen = await localRedisIsRunning();
const title = missingRequirements.length > 0
  ? `enterprise install guide skipped — needs: ${missingRequirements.join(", ")}`
  : daytonaPlacement
    ? "enterprise install guide skipped — needs: local placement (unset OPENWORK_EVAL_DAYTONA)"
    : !mysqlOpen
      ? "enterprise install guide skipped — needs: MySQL on 127.0.0.1:3306"
      : !redisOpen
        ? "enterprise install guide skipped — needs: Redis on 127.0.0.1:6379"
        : "a self-hosted owner sees the three-step Enterprise install guide and exact workspace address";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

test.skipIf(missingRequirements.length > 0 || daytonaPlacement || !mysqlOpen || !redisOpen)(title, async ({ evidence, place }) => {
  needs(requirements);

  const ownerEmail = `owner+${Date.now().toString(36)}@enterprise-install.test`;
  const password = "OpenWorkEval123!";
  await using den = await selfHostServer({
    place,
    name: "Enterprise Install Guide",
    slug: "enterprise-install-guide",
    ownerEmails: [ownerEmail],
    allowPublicSignup: true,
  });

  await using browser = await chrome({
    name: "enterprise-install-guide",
    startUrl: den.ref.webUrl,
    headless: true,
  });
  await waitFor(browser, `Boolean(document.querySelector('input[type="email"]'))`, {
    timeoutMs: 60_000,
    label: "self-host owner email entry",
  });
  await fill(browser, 'input[type="email"]', ownerEmail, { timeoutMs: 30_000 });
  await clickButton(browser, "Next", { timeoutMs: 30_000 });
  await waitFor(browser, `Boolean(document.querySelector('input[autocomplete="name"]')) && Boolean(document.querySelector('input[type="password"]'))`, {
    timeoutMs: 30_000,
    label: "eligible owner signup form",
  });
  await fill(browser, 'input[autocomplete="name"]', "Enterprise Owner", { timeoutMs: 30_000 });
  await fill(browser, 'input[type="password"]', password, { timeoutMs: 30_000 });
  await clickButton(browser, "Sign up", { timeoutMs: 30_000 });
  await waitFor(browser, `location.pathname.startsWith("/dashboard")`, {
    timeoutMs: 60_000,
    label: "signed-in owner dashboard",
  });

  await navigate(browser.client, `${den.ref.webUrl}/install`);
  await waitFor(
    browser,
    `location.pathname === "/install"
      && location.search === ""
      && Boolean(document.querySelector('[data-testid="install-guide"]'))
      && !document.body.textContent?.includes("Loading your install link")`,
    { timeoutMs: 60_000, label: "clean authenticated Enterprise install guide" },
  );

  const rawGuide = await evalIn(browser, `(async () => {
    const headers = new Headers({ Accept: "application/json" });
    const storedToken = localStorage.getItem("openwork:web:auth-token")?.trim();
    if (storedToken) headers.set("Authorization", "Bearer " + storedToken);
    const response = await fetch("/api/den/v1/me/install-config", { credentials: "include", headers });
    const config = await response.json();
    const steps = [...document.querySelectorAll('[data-testid="install-guide"] > li')]
      .map((step) => step.querySelector("button > span.grow")?.textContent?.trim() ?? "");
    const resources = performance.getEntriesByType("resource").map((entry) => entry.name);
    return JSON.stringify({
      status: response.status,
      distribution: config?.distribution,
      steps,
      fourthStep: Boolean(document.querySelector('[data-testid="install-guide"] > li:nth-child(4)')),
      cloudReturnControl: [...document.querySelectorAll("a")]
        .some((anchor) => (anchor.textContent ?? "").trim() === "I already installed OpenWork"),
      mintedToken: resources.some((url) => url.includes("/install-links") || url.includes("/v1/install-config?token=")),
    });
  })()`, { awaitPromise: true });
  const guide: unknown = JSON.parse(String(rawGuide));
  if (!isRecord(guide) || !Array.isArray(guide.steps) || !guide.steps.every((step) => typeof step === "string")) {
    throw new Error(`Install guide facts had an unexpected shape: ${JSON.stringify(guide)}`);
  }
  expect(guide.status).toBe(200);
  expect(guide.distribution).toBe("enterprise");
  expect(guide.steps).toEqual(["Download", "Install and open it", "Connect"]);
  expect(guide.fourthStep).toBe(false);
  expect(guide.cloudReturnControl).toBe(false);
  expect(guide.mintedToken).toBe(false);

  const advanced = await evalIn(browser, `(() => {
    const skip = document.querySelector('[data-testid="install-skip-download"]');
    if (!(skip instanceof HTMLButtonElement)) return false;
    skip.click();
    return true;
  })()`);
  expect(advanced).toBe(true);
  await waitFor(browser, `Boolean(document.querySelector('[data-testid="install-workspace-address"] input'))`, {
    timeoutMs: 30_000,
    label: "Enterprise connect step",
  });
  const workspaceAddress = String(await evalIn(
    browser,
    `document.querySelector('[data-testid="install-workspace-address"] input')?.value ?? ""`,
  ));
  expect(workspaceAddress).toBe(den.ref.webUrl);
  expect(new URL(workspaceAddress).search).toBe("");
  expect(new URL(workspaceAddress).hash).toBe("");
  expect(workspaceAddress).not.toMatch(/token|credential|grant/i);

  await screenshot(browser);
  evidence.recordAssertionEvidence(
    "Single-org Den serves the token-free Enterprise three-step guide",
    `The authenticated config reported enterprise; the only steps were Download, Install and open it, and Connect; step 3 showed exactly ${workspaceAddress} with no query, fragment, token, credential, or grant.`,
    guide.distribution === "enterprise" && workspaceAddress === den.ref.webUrl,
  );
});
