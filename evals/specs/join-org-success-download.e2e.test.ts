import { expect } from "vitest";
import { denFetch, evalIn, signIn, waitFor } from "@openwork/behaviors";
import { navigate } from "@openwork/cdp";
import { screenshot, validate } from "@openwork/test-evidence";
import { chrome } from "@openwork/hosts";
import { needs, server, test, unmetNeeds } from "@openwork/testkit";
import type { TestNeeds } from "@openwork/testkit";

const requirements: TestNeeds = {
  optIn: ["OPENWORK_EVAL_E2E_TESTS"],
};
const missingRequirements = unmetNeeds(requirements, process.env);
const title = missingRequirements.length > 0
  ? `join success download skipped — needs: ${missingRequirements.join(", ")}`
  : "joining a workspace opens the clean authenticated install guide";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: unknown, key: string): string | null {
  if (!isRecord(value)) return null;
  const field = value[key];
  return typeof field === "string" ? field : null;
}

test(title, async ({ evidence, place }) => {
  needs(requirements);

  const runId = `${Date.now().toString(36)}${process.pid.toString(36)}`;
  const orgName = `Acme Robotics ${runId}`;
  const invitee = {
    email: `maya+${runId}@openwork.test`,
    name: "Maya Chen",
    password: "OpenWorkEval123!",
  };

  await using den = await server({
    place,
    org: {
      name: orgName,
      admin: { name: "Jordan Chen" },
    },
  });

  const invitation = await denFetch(den.ref, "/v1/invitations", {
    method: "POST",
    headers: { authorization: `Bearer ${den.admin.token}` },
    body: JSON.stringify({ email: invitee.email, role: "member" }),
  });
  const inviteToken = stringField(invitation.body, "inviteToken");
  if (!invitation.response.ok || !inviteToken) {
    throw new Error(`Invitation failed: HTTP ${invitation.response.status} ${invitation.text.slice(0, 500)}`);
  }

  const signUp = await denFetch(den.ref, "/api/auth/sign-up/email", {
    method: "POST",
    body: JSON.stringify(invitee),
  });
  if (!signUp.response.ok) {
    throw new Error(`Invitee sign-up failed: HTTP ${signUp.response.status} ${signUp.text.slice(0, 500)}`);
  }
  const member = await signIn(den.ref, { email: invitee.email, password: invitee.password });

  await using browser = await chrome({
    name: "join-org-success-download",
    startUrl: den.ref.webUrl,
    headless: true,
    host: place.host(),
  });
  await browser.client.send("Emulation.setDeviceMetricsOverride", {
    width: 1280,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await waitFor(browser, `location.href.startsWith(${JSON.stringify(den.ref.webUrl)}) && document.readyState === "complete"`, {
    timeoutMs: 60_000,
    label: "Den Web origin before invitee auth token handoff",
  });

  const tokenStored = await evalIn(browser, `(() => {
    localStorage.setItem("openwork:web:auth-token", ${JSON.stringify(member.token)});
    return localStorage.getItem("openwork:web:auth-token") === ${JSON.stringify(member.token)};
  })()`);
  expect(tokenStored).toBe(true);

  const inviteUrl = `${den.ref.webUrl}/join-org?invite=${encodeURIComponent(inviteToken)}`;
  await navigate(browser.client, inviteUrl);
  await waitFor(
    browser,
    `Boolean(document.querySelector('[data-testid="join-org-invitation-details"]'))
      && [...document.querySelectorAll("button")].some((button) => (button.textContent ?? "").trim() === ${JSON.stringify(`Join ${orgName}`)} && !button.disabled)`,
    { timeoutMs: 45_000, label: "signed-in invite accept step" },
  );

  const joined = await evalIn(browser, `(() => {
    const button = [...document.querySelectorAll("button")]
      .find((candidate) => (candidate.textContent ?? "").trim() === ${JSON.stringify(`Join ${orgName}`)} && !candidate.disabled);
    if (!(button instanceof HTMLButtonElement)) return false;
    button.scrollIntoView({ block: "center" });
    button.click();
    return true;
  })()`);
  expect(joined).toBe(true);

  await waitFor(
    browser,
    `location.pathname === "/install"
      && location.search === ""
      && Boolean(document.querySelector('[data-testid="install-page"]'))
      && !document.body.textContent?.includes("Loading your install link")`,
    { timeoutMs: 60_000, label: "clean authenticated install guide after join" },
  );

  const install = await evalIn(browser, `(() => {
    const resources = performance.getEntriesByType("resource").map((entry) => entry.name);
    const hrefs = [...document.querySelectorAll("a[href]")].map((anchor) => anchor.href);
    return {
      pathname: location.pathname,
      search: location.search,
      configLoaded: resources.some((url) => url.includes("/v1/me/install-config")),
      mintedToken: resources.some((url) => url.includes("/install-links") || url.includes("/v1/install-config?token=")),
      downloadHref: hrefs.find((href) => href.includes("/v1/me/install/")) || "",
      clipboardGuide: Boolean(document.querySelector('[data-testid="install-connect-copy"]')),
    };
  })()`);
  if (!isRecord(install) || typeof install.pathname !== "string" || typeof install.search !== "string" || typeof install.downloadHref !== "string") {
    throw new Error(`Authenticated install facts had an unexpected shape: ${JSON.stringify(install)}`);
  }

  expect(install.pathname).toBe("/install");
  expect(install.search).toBe("");
  expect(install.configLoaded).toBe(true);
  expect(install.mintedToken).toBe(false);
  expect(install.downloadHref).toContain("/v1/me/install/");
  expect(install.downloadHref).not.toContain("token=");
  evidence.recordAssertionEvidence(
    "Joining opens clean authenticated installation without minting an installer token",
    `url=${install.pathname}${install.search}; configLoaded=${String(install.configLoaded)}; download=${install.downloadHref}`,
    install.pathname === "/install"
      && install.search === ""
      && install.configLoaded === true
      && install.mintedToken === false
      && install.downloadHref.includes("/v1/me/install/")
      && !install.downloadHref.includes("token="),
  );

  const shot = await screenshot(browser);
  const seen = await validate(shot, [
    "The page is an OpenWork download or install guide",
    "The page offers downloads for desktop computers",
  ]);
  expect(seen.ok, seen.why).toBe(true);
});
