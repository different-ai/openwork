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
  ? `member dashboard download skipped — needs: ${missingRequirements.join(", ")}`
  : "the member dashboard opens the clean authenticated install guide";

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
  const invitationId = stringField(invitation.body, "invitationId");
  if (!invitation.response.ok || !invitationId) {
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

  const accepted = await denFetch(den.ref, "/v1/orgs/invitations/accept", {
    method: "POST",
    headers: { authorization: `Bearer ${member.token}` },
    body: JSON.stringify({ id: invitationId }),
  });
  if (!accepted.response.ok) {
    throw new Error(`Invitation accept failed: HTTP ${accepted.response.status} ${accepted.text.slice(0, 500)}`);
  }

  await using browser = await chrome({
    name: "member-dashboard-os-download",
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
    label: "Den Web origin before member auth token handoff",
  });

  const tokenStored = await evalIn(browser, `(() => {
    localStorage.setItem("openwork:web:auth-token", ${JSON.stringify(member.token)});
    return localStorage.getItem("openwork:web:auth-token") === ${JSON.stringify(member.token)};
  })()`);
  expect(tokenStored).toBe(true);

  await navigate(browser.client, `${den.ref.webUrl}/dashboard`);
  await waitFor(
    browser,
    `Boolean(document.querySelector('[data-testid="member-dashboard"]'))
      && Boolean(document.querySelector('[data-testid="member-download-app"]'))`,
    { timeoutMs: 60_000, label: "member dashboard install CTA" },
  );

  const dashboard = await evalIn(browser, `(() => {
    const cta = document.querySelector('[data-testid="member-download-app"]');
    return {
      pathname: location.pathname,
      cta: (cta?.textContent ?? "").replace(/\\s+/g, " ").trim(),
    };
  })()`);
  if (!isRecord(dashboard) || typeof dashboard.pathname !== "string" || typeof dashboard.cta !== "string") {
    throw new Error(`Member dashboard facts had an unexpected shape: ${JSON.stringify(dashboard)}`);
  }

  expect(dashboard.pathname).toBe("/dashboard");
  expect(dashboard.cta).toBe("Get OpenWork");
  evidence.recordAssertionEvidence(
    "The member dashboard offers the authenticated install guide",
    `pathname=${dashboard.pathname}; cta=${dashboard.cta}`,
    dashboard.pathname === "/dashboard" && dashboard.cta === "Get OpenWork",
  );

  {
    const shot = await screenshot(browser);
    const seen = await validate(shot, [
      "The heading says the workspace is set up for you",
      "The primary button says Get OpenWork",
    ]);
    expect(seen.ok, seen.why).toBe(true);
  }

  const openedInstall = await evalIn(browser, `(() => {
    const button = document.querySelector('[data-testid="member-download-app"]');
    if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
    button.scrollIntoView({ block: "center" });
    button.click();
    return true;
  })()`);
  expect(openedInstall).toBe(true);

  await waitFor(
    browser,
    `location.pathname === "/install" && location.search === ""
      && Boolean(document.querySelector('[data-testid="install-page"]'))
      && !document.body.textContent?.includes("Loading your install link")`,
    { timeoutMs: 60_000, label: "clean authenticated install guide from member dashboard" },
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
    };
  })()`);
  if (!isRecord(install) || typeof install.pathname !== "string" || typeof install.search !== "string" || typeof install.downloadHref !== "string") {
    throw new Error(`Install guide facts had an unexpected shape: ${JSON.stringify(install)}`);
  }

  expect(install.pathname).toBe("/install");
  expect(install.search).toBe("");
  expect(install.configLoaded).toBe(true);
  expect(install.mintedToken).toBe(false);
  expect(install.downloadHref).toContain("/v1/me/install/");
  expect(install.downloadHref).not.toContain("token=");
  evidence.recordAssertionEvidence(
    "The member CTA opens clean authenticated installation without minting an installer token",
    `url=${install.pathname}${install.search}; configLoaded=${String(install.configLoaded)}; download=${install.downloadHref}`,
    install.pathname === "/install"
      && install.search === ""
      && install.configLoaded === true
      && install.mintedToken === false
      && install.downloadHref.includes("/v1/me/install/")
      && !install.downloadHref.includes("token="),
  );
});
