import { expect } from "vitest";
import { denFetch, evalIn, signIn, waitFor } from "@openwork/behaviors";
import { attachSurface, callFunctionOnSurface, navigate } from "@openwork/cdp";
import { screenshot, validate } from "@openwork/test-evidence";
import { chrome, localHost } from "@openwork/hosts";
import { needs, server, test, unmetNeeds } from "@openwork/testkit";
import type { TestNeeds } from "@openwork/testkit";

const requirements: TestNeeds = {
  optIn: ["OPENWORK_EVAL_E2E_TESTS"],
};
const missingRequirements = unmetNeeds(requirements, process.env);
const title = missingRequirements.length > 0
  ? `enterprise invite→install→connect skipped — needs: ${missingRequirements.join(", ")}`
  : "an invited teammate signs up, reaches the token-free install guide, and links the enterprise desktop by workspace address";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: unknown, key: string): string | null {
  if (!isRecord(value)) return null;
  const field = value[key];
  return typeof field === "string" ? field : null;
}

/**
 * The whole new journey in one tape: an admin invites a teammate; the teammate
 * creates the account THROUGH the invite (never a sign-in against a
 * nonexistent account), lands on the clean authenticated /install guide with
 * no installer token anywhere, and links a real blank-slate Enterprise desktop
 * by typing the workspace address the guide showed — with the pasted
 * openwork:// URL as the same field's silent recovery. The one-time grant dies
 * after use.
 */
test(title, { timeout: 1_800_000 }, async ({ evidence, place }) => {
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
    org: { name: orgName, admin: { name: "Jordan Chen" } },
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

  // localhost instead of 127.0.0.1 so the Better-Auth session cookie set at
  // sign-up is host-only on "localhost" and therefore travels to the Den API
  // origin too (cookies ignore ports), which the authenticated download needs.
  const webOrigin = den.ref.webUrl.replace("127.0.0.1", "localhost");
  const apiOrigin = den.ref.apiUrl.replace("127.0.0.1", "localhost");

  await using browser = await chrome({
    name: "enterprise-invite-install-connect",
    startUrl: webOrigin,
    headless: true,
  });
  await browser.client.send("Emulation.setDeviceMetricsOverride", {
    width: 1280,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });

  // ── Frame 1: the invite signs the newcomer UP, never IN ──────────────────
  await navigate(browser.client, `${webOrigin}/join-org?invite=${encodeURIComponent(inviteToken)}`);
  await waitFor(
    browser,
    `Boolean(document.querySelector('[data-testid="join-org-auth"] input[type="password"]'))
      && [...document.querySelectorAll("button")].some((button) => (button.textContent ?? "").trim() === "Create account")`,
    { timeoutMs: 180_000, label: "invite sign-up form with Create account" },
  );
  await screenshot(browser);

  const authCaptureReady = await evalIn(browser, `(() => {
    window.__authCalls = [];
    const original = window.fetch.bind(window);
    window.fetch = async (...args) => {
      const input = args[0];
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/api/auth/")) window.__authCalls.push(url);
      return original(...args);
    };
    return true;
  })()`);
  expect(authCaptureReady).toBe(true);

  const submitted = await callFunctionOnSurface(browser, `function (nameValue, passwordValue) {
    const scope = document.querySelector('[data-testid="join-org-auth"]');
    if (!scope) return "no auth scope";
    const inputs = [...scope.querySelectorAll("input")];
    const name = inputs.find((input) => input.type === "text");
    const password = inputs.find((input) => input.type === "password");
    if (!name || !password) return "missing fields";
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setValue.call(name, nameValue);
    name.dispatchEvent(new Event("input", { bubbles: true }));
    setValue.call(password, passwordValue);
    password.dispatchEvent(new Event("input", { bubbles: true }));
    password.closest("form")?.requestSubmit();
    return "submitted";
  }`, [invitee.name, invitee.password]);
  expect(submitted).toBe("submitted");

  const joinLabel = `Join ${orgName}`;
  await expect.poll(
    () => callFunctionOnSurface(browser, `function (expectedLabel) {
      return [...document.querySelectorAll("button")]
        .some((button) => (button.textContent ?? "").trim() === expectedLabel && !button.disabled);
    }`, [joinLabel]),
    {
      message: "signed-in one-click join step did not appear after in-invite sign-up",
      timeout: 90_000,
      interval: 250,
    },
  ).toBe(true);

  const authCalls: unknown = await evalIn(browser, "JSON.stringify(window.__authCalls ?? [])");
  const calls: string[] = JSON.parse(String(authCalls)) as string[];
  const signUpCall = calls.find((url) => url.includes("/api/auth/sign-up/email"));
  expect(signUpCall ?? "").toContain("invite=");
  expect(calls.some((url) => url.includes("/api/auth/sign-in/email"))).toBe(false);
  evidence.recordAssertionEvidence(
    "The invite creates the account instead of demanding a sign-in",
    `Captured auth calls ${JSON.stringify(calls)}: the form posted /api/auth/sign-up/email carrying the invite and never touched /api/auth/sign-in/email for the not-yet-existing account.`,
    Boolean(signUpCall?.includes("invite=")) && !calls.some((url) => url.includes("/api/auth/sign-in/email")),
  );

  // ── Frame 2: joining lands on the clean token-free install guide ─────────
  const joined = await callFunctionOnSurface(browser, `function (expectedLabel) {
    const button = [...document.querySelectorAll("button")]
      .find((candidate) => (candidate.textContent ?? "").trim() === expectedLabel && !candidate.disabled);
    if (!(button instanceof HTMLButtonElement)) return false;
    button.click();
    return true;
  }`, [joinLabel]);
  expect(joined).toBe(true);

  await waitFor(
    browser,
    `location.pathname === "/install"
      && location.search === ""
      && Boolean(document.querySelector('[data-testid="install-page"]'))
      && !document.body.textContent?.includes("Loading your install link")`,
    { timeoutMs: 90_000, label: "clean authenticated /install after joining" },
  );
  await screenshot(browser);
  const member = await signIn(den.ref, { email: invitee.email, password: invitee.password });
  const installTokenStored = await evalIn(browser, `(() => {
    localStorage.setItem("openwork:web:auth-token", ${JSON.stringify(member.token)});
    return localStorage.getItem("openwork:web:auth-token") === ${JSON.stringify(member.token)};
  })()`);
  expect(installTokenStored).toBe(true);
  const memberConfig = await denFetch(den.ref, "/v1/me/install-config", {
    headers: { authorization: `Bearer ${member.token}` },
  });
  expect(memberConfig.response.status).toBe(200);

  const rawInstall = await evalIn(browser, `(() => {
    const resources = performance.getEntriesByType("resource").map((entry) => entry.name);
    const hrefs = [...document.querySelectorAll("a[href]")].map((anchor) => anchor.href);
    return JSON.stringify({
      search: location.search,
      configLoaded: resources.some((url) => url.includes("/v1/me/install-config")),
      mintedToken: resources.some((url) => url.includes("/install-links") || url.includes("/v1/install-config?token=")),
      downloadHrefs: hrefs.filter((href) => href.includes("/v1/me/install/")),
      cloudDownloadSurface: [...document.querySelectorAll("h1")]
        .some((heading) => (heading.textContent ?? "").trim() === "Download OpenWork"),
      cloudReturnControl: [...document.querySelectorAll("a")]
        .some((anchor) => (anchor.textContent ?? "").trim() === "I already installed OpenWork"),
      enterpriseGuide: Boolean(document.querySelector('[data-testid="install-guide"]')),
      guideSteps: [...document.querySelectorAll('[data-testid="install-guide"] > li')]
        .map((step) => step.querySelector("button > span.grow")?.textContent?.trim() ?? ""),
      fourthGuideStep: Boolean(document.querySelector('[data-testid="install-guide"] > li:nth-child(4)')),
      skipControl: Boolean(document.querySelector('[data-testid="install-skip-download"]')),
      workspaceControl: Boolean(document.querySelector('[data-testid="install-workspace-address"]')),
      text: document.body.innerText.replace(/\\s+/g, " ").slice(0, 400),
    });
  })()`);
  const install: unknown = JSON.parse(String(rawInstall));
  if (
    !isRecord(install)
    || !Array.isArray(install.downloadHrefs)
    || !install.downloadHrefs.every((href) => typeof href === "string")
    || !Array.isArray(install.guideSteps)
    || !install.guideSteps.every((step) => typeof step === "string")
  ) {
    throw new Error(`Install facts had an unexpected shape: ${JSON.stringify(install)}`);
  }
  const distribution = stringField(memberConfig.body, "distribution");
  if (distribution !== "cloud" && distribution !== "enterprise") {
    throw new Error(`Install config returned an invalid distribution: ${JSON.stringify(memberConfig.body)}`);
  }
  const downloadHref = install.downloadHrefs[0];
  if (typeof downloadHref !== "string") throw new Error("Install page exposed no authenticated download link");
  expect(install.search).toBe("");
  expect(install.configLoaded).toBe(true);
  expect(install.mintedToken).toBe(false);
  expect(install.downloadHrefs.length).toBeGreaterThan(0);
  for (const href of install.downloadHrefs) {
    expect(href).toContain("/v1/me/install/");
    expect(href).not.toContain("token=");
  }

  if (distribution === "cloud") {
    expect(install.cloudDownloadSurface).toBe(true);
    expect(install.cloudReturnControl).toBe(true);
    expect(install.enterpriseGuide).toBe(false);
    expect(install.skipControl).toBe(false);
    expect(install.workspaceControl).toBe(false);
  } else {
    expect(install.enterpriseGuide).toBe(true);
    expect(install.guideSteps).toEqual(["Download", "Install and open it", "Connect"]);
    expect(install.fourthGuideStep).toBe(false);
    expect(install.skipControl).toBe(true);
    expect(install.cloudReturnControl).toBe(false);
  }

  // Daytona preview duplicates CORS headers on Origin-bearing responses; top-level downloads bypass CORS, so probe through the session directly.
  const downloadPath = new URL(downloadHref).pathname;
  const authedDownload = await denFetch(den.ref, downloadPath, {
    headers: { authorization: `Bearer ${member.token}` },
    redirect: "manual",
  });
  const anonymousDownload = await denFetch(den.ref, downloadPath, { redirect: "manual" });
  expect([200, 302], `authenticated download answered HTTP ${authedDownload.response.status}`).toContain(authedDownload.response.status);
  expect(anonymousDownload.response.ok).toBe(false);
  expect([401, 403]).toContain(anonymousDownload.response.status);
  evidence.recordAssertionEvidence(
    "The install guide is authenticated and token-free end to end",
    `URL stayed /install with empty search; authenticated config reported ${distribution}; no /install-links mint and no ?token= anywhere; the session-scoped download path ${downloadPath} answered ${authedDownload.response.status} and the same URL without a session was rejected with ${anonymousDownload.response.status}.`,
    true,
  );

  // ── Frame 3: the guide hands over the workspace address ──────────────────
  if (distribution === "enterprise") {
    const skipped = await evalIn(browser, `(() => {
      const skip = document.querySelector('[data-testid="install-skip-download"]');
      if (!(skip instanceof HTMLButtonElement)) return false;
      skip.click();
      return true;
    })()`);
    expect(skipped).toBe(true);
    await waitFor(
      browser,
      `Boolean(document.querySelector('[data-testid="install-workspace-address"] input'))`,
      { timeoutMs: 30_000, label: "connect step showing the workspace address" },
    );
    const shownAddress = String(await evalIn(
      browser,
      `document.querySelector('[data-testid="install-workspace-address"] input')?.value ?? ""`,
    ));
    expect(shownAddress).toBe(webOrigin);
    expect(new URL(shownAddress).search).toBe("");
    expect(new URL(shownAddress).hash).toBe("");
    expect(shownAddress).not.toMatch(/token|credential|grant/i);
    evidence.recordAssertionEvidence(
      "The three-step Enterprise guide hands the member the exact token-free workspace address",
      `The only steps were Download, Install and open it, and Connect; step 3 showed ${shownAddress}, exactly the Den web origin with no query, fragment, token, credential, or grant, and there was no I already installed control.`,
      shownAddress === webOrigin
        && install.guideSteps.join(",") === "Download,Install and open it,Connect"
        && install.fourthGuideStep === false
        && install.cloudReturnControl === false,
    );
  }

  // ── Frames 4-5: the real blank-slate Enterprise desktop links by address ──
  const handoff = await denFetch(den.ref, "/v1/auth/desktop-handoff", {
    method: "POST",
    headers: { authorization: `Bearer ${member.token}` },
    body: JSON.stringify({ desktopScheme: "openwork" }),
  });
  const openworkUrl = stringField(handoff.body, "openworkUrl");
  const grant = stringField(handoff.body, "grant");
  if (!handoff.response.ok || !openworkUrl || !grant) {
    throw new Error(`Desktop handoff mint failed: HTTP ${handoff.response.status} ${handoff.text.slice(0, 400)}`);
  }

  const placedHost = place.host();
  await using localElectronHost = placedHost ? undefined : localHost();
  const host = placedHost ?? localElectronHost;
  if (!host) throw new Error("No Electron host: neither placement host nor local fallback is available.");
  const handle = await host.spawnElectron("enterprise-invite-connect", {
    profile: "fresh",
    env: { OPENWORK_DESKTOP_DISTRIBUTION: "enterprise" },
  });
  const desktopSurface = await attachSurface(handle, { timeoutMs: 240_000 });
  try {
    await waitFor(
      desktopSurface,
      `Boolean(document.querySelector('[data-testid="enterprise-activation-root"]'))`,
      { timeoutMs: 240_000, label: "blank-slate enterprise gate" },
    );
    await screenshot(desktopSurface);

    const gate: unknown = JSON.parse(String(await evalIn(desktopSurface, `(() => {
      const text = document.body.innerText;
      return JSON.stringify({
        heading: text.includes("Link this app to your organization"),
        serverField: Boolean(document.querySelector('#organization-server-input')),
        linkField: Boolean(document.querySelector('#enterprise-openwork-link')),
        methodToggle: Boolean(document.querySelector('[data-testid="enterprise-connection-method-toggle"]')),
      });
    })()`)));
    expect(isRecord(gate) && gate.heading === true).toBe(true);
    expect(isRecord(gate) && gate.serverField === true).toBe(true);
    expect(isRecord(gate) && gate.linkField === false).toBe(true);
    expect(isRecord(gate) && gate.methodToggle === false).toBe(true);
    evidence.recordAssertionEvidence(
      "The enterprise blank slate asks one question: the workspace address",
      "The packaged-policy gate renders Link this app to your organization with only the organization-server-input form; no OpenWork link field and no method toggle exist.",
      true,
    );

    const typeIntoGate = (value: string) => callFunctionOnSurface(desktopSurface, `function (inputValue) {
      const input = document.querySelector('#organization-server-input');
      if (!(input instanceof HTMLInputElement)) return "no input";
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
      setValue.call(input, inputValue);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.closest("form")?.requestSubmit();
      return "submitted";
    }`, [value]);

    // Server-first path up to the browser handoff: typing the address reaches
    // the explicit origin-naming confirmation with Continue in browser.
    expect(await typeIntoGate(webOrigin)).toBe("submitted");
    await expect.poll(
      () => callFunctionOnSurface(desktopSurface, `function (expectedOrigin) {
        return Boolean(document.querySelector('[data-testid="organization-server-confirm"]'))
          && document.body.innerText.includes(expectedOrigin)
          && document.body.innerText.includes("Continue in browser");
      }`, [webOrigin]),
      {
        message: "origin-naming confirmation did not appear for the typed address",
        timeout: 30_000,
        interval: 250,
      },
    ).toBe(true);
    await screenshot(desktopSurface);
    evidence.recordAssertionEvidence(
      "Typing the workspace address reaches the named-origin confirmation",
      `The gate names ${webOrigin} and offers Continue in browser before anything is persisted or exchanged; the headless run stops short of the OS browser round trip on purpose.`,
      true,
    );

    const wentBack = await evalIn(desktopSurface, `(() => {
      const back = [...document.querySelectorAll("button")].find((button) => (button.textContent ?? "").trim() === "Back");
      if (!(back instanceof HTMLButtonElement)) return false;
      back.click();
      return true;
    })()`);
    expect(wentBack).toBe(true);

    // Recovery seam of the SAME field: a pasted openwork:// URL carries the
    // origin and one-time grant, still passes the named confirmation, and
    // signs the desktop in — sign-in IS activation.
    expect(await typeIntoGate(openworkUrl)).toBe("submitted");
    await waitFor(
      desktopSurface,
      `Boolean(document.querySelector('[data-testid="organization-server-confirm"]'))
        && document.body.innerText.includes("Confirm and finish sign-in")`,
      { timeoutMs: 30_000, label: "manual confirmation for the pasted openwork:// URL" },
    );
    const confirmed = await evalIn(desktopSurface, `(() => {
      const confirm = document.querySelector('[data-testid="organization-server-confirm"]');
      if (!(confirm instanceof HTMLButtonElement)) return false;
      confirm.click();
      return true;
    })()`);
    expect(confirmed).toBe(true);

    await waitFor(
      desktopSurface,
      `!document.querySelector('[data-testid="enterprise-activation-root"]')`,
      { timeoutMs: 120_000, label: "gate unmounts after the confirmed exchange" },
    );
    await screenshot(desktopSurface);

    const reused = await denFetch(den.ref, "/v1/auth/desktop-handoff/exchange", {
      method: "POST",
      body: JSON.stringify({ grant }),
    });
    expect(reused.response.ok).toBe(false);
    evidence.recordAssertionEvidence(
      "Pasting the complete OpenWork URL signs the desktop in exactly once",
      `After confirming ${webOrigin} the enterprise gate unmounted (sign-in is activation), and replaying the same grant against /v1/auth/desktop-handoff/exchange failed with HTTP ${reused.response.status}: the credential is single-use.`,
      !reused.response.ok,
    );
  } finally {
    await desktopSurface.stop().catch(() => undefined);
    await host.disposeSurface(handle).catch(() => undefined);
  }

  const finalShot = await screenshot(browser);
  const seen = await validate(finalShot, distribution === "cloud"
    ? [
        "The page is an OpenWork download guide",
        "Desktop download choices are visible",
      ]
    : [
        "The page is an OpenWork install or setup guide",
        "A step mentions connecting or a workspace address",
      ]);
  expect(seen.ok, seen.why).toBe(true);
});
