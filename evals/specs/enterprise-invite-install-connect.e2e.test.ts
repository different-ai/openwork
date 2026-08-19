import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
import { denFetch, evalIn, signIn, waitFor } from "@openwork/behaviors";
import { attachSurface, navigate } from "@openwork/cdp";
import { screenshot, validate } from "@openwork/test-evidence";
import { chrome, localHost } from "@openwork/hosts";
import { startEgressLab } from "@openwork/labs";
import { needs, server, test, unmetNeeds } from "@openwork/testkit";
import { resolveSystemCaEnv } from "../../apps/desktop/electron/runtime.mjs";
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

const chainErrorPattern = /UNABLE_TO_VERIFY_LEAF_SIGNATURE|unable to verify the first certificate|unable to get local issuer/i;

// Async spawn on purpose: the egress lab's TLS and AIA servers run inside this
// vitest process, so a sync spawn would deadlock the child's TLS handshake.
async function fetchLabInChild(url: string, env: NodeJS.ProcessEnv): Promise<{ status: number | null; output: string }> {
  const script = `
    fetch(${JSON.stringify(url)}).then(async (response) => {
      console.log(JSON.stringify({ ok: response.ok, status: response.status }));
      process.exit(response.ok ? 0 : 1);
    }).catch((error) => {
      console.log(JSON.stringify({ ok: false, message: error?.message ?? String(error), causeCode: error?.cause?.code ?? null }));
      process.exit(1);
    });
  `;
  const child = spawn(process.execPath, ["--eval", script], { env });
  const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    output += chunk;
  });
  const status = await new Promise<number | null>((resolve) => {
    child.on("error", () => resolve(null));
    child.on("close", (code) => resolve(code));
  });
  clearTimeout(timer);
  return { status, output: output.trim() };
}

// Exactly the record the enterprise gate stamps after a confirmed exchange
// (enterprise-activation-gate.tsx, exchangeConfirmedGrant).
async function writeStampedBootstrap(denBaseUrl: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "openwork-invite-connect-activation-"));
  const bootstrapPath = join(dir, "desktop-bootstrap.json");
  const stamped = {
    baseUrl: denBaseUrl,
    requireSignin: true,
    enterpriseActivation: { activatedAt: new Date().toISOString(), denBaseUrl },
  };
  await writeFile(bootstrapPath, `${JSON.stringify(stamped, null, 2)}\n`, "utf8");
  return bootstrapPath;
}

async function resolveCaEnvFromRecord(options: {
  bootstrapPath: string;
  rootPem: string;
}): Promise<{ caEnv: NodeJS.ProcessEnv; logs: string[] }> {
  const userDataDir = await mkdtemp(join(tmpdir(), "openwork-invite-connect-chain-"));
  const logs: string[] = [];
  const caEnv: NodeJS.ProcessEnv = await resolveSystemCaEnv({
    tlsModule: { getCACertificates: () => [] },
    userDataDir,
    parentEnv: {},
    logInfo(message: unknown) {
      logs.push(String(message));
    },
    loadPlatformCertificates: async () => [options.rootPem],
    platformSourceName: "egress-lab-root",
    chainRepair: {
      bootstrapPath: options.bootstrapPath,
      rootsProvider: () => [options.rootPem],
    },
  });
  return { caEnv, logs };
}

async function reserveClosedPort(): Promise<number> {
  const srv = net.createServer();
  const port = await new Promise<number>((resolve, reject) => {
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address();
      if (!address || typeof address === "string") {
        reject(new Error("port reservation did not bind to a TCP port"));
        return;
      }
      resolve(address.port);
    });
  });
  await new Promise<void>((resolve) => srv.close(() => resolve()));
  return port;
}

/**
 * The whole new journey in one tape: an admin invites a teammate; the teammate
 * creates the account THROUGH the invite (never a sign-in against a
 * nonexistent account), lands on the clean authenticated /install guide with
 * no installer token anywhere, and links a real blank-slate Enterprise desktop
 * by typing the workspace address the guide showed — with the pasted
 * openwork:// URL as the same field's silent recovery. The one-time grant dies
 * after use, and the activation record this flow stamps is exactly what the
 * TLS chain-repair seam consumes, unlocking only the stamped origin on a
 * broken-chain, semi-airgapped network.
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

  const submitted = await evalIn(browser, `(() => {
    const scope = document.querySelector('[data-testid="join-org-auth"]');
    if (!scope) return "no auth scope";
    const inputs = [...scope.querySelectorAll("input")];
    const name = inputs.find((input) => input.type === "text");
    const password = inputs.find((input) => input.type === "password");
    if (!name || !password) return "missing fields";
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setValue.call(name, ${JSON.stringify(invitee.name)});
    name.dispatchEvent(new Event("input", { bubbles: true }));
    setValue.call(password, ${JSON.stringify(invitee.password)});
    password.dispatchEvent(new Event("input", { bubbles: true }));
    password.closest("form")?.requestSubmit();
    return "submitted";
  })()`);
  expect(submitted).toBe("submitted");

  await waitFor(
    browser,
    `[...document.querySelectorAll("button")].some((button) => (button.textContent ?? "").trim() === ${JSON.stringify(`Join ${orgName}`)} && !button.disabled)`,
    { timeoutMs: 90_000, label: "signed-in one-click join step after in-invite sign-up" },
  );

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
  const joined = await evalIn(browser, `(() => {
    const button = [...document.querySelectorAll("button")]
      .find((candidate) => (candidate.textContent ?? "").trim() === ${JSON.stringify(`Join ${orgName}`)} && !candidate.disabled);
    if (!(button instanceof HTMLButtonElement)) return false;
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
    { timeoutMs: 90_000, label: "clean authenticated /install after joining" },
  );
  await screenshot(browser);

  const rawInstall = await evalIn(browser, `(async () => {
    const resources = performance.getEntriesByType("resource").map((entry) => entry.name);
    const hrefs = [...document.querySelectorAll("a[href]")].map((anchor) => anchor.href);
    const headers = new Headers({ Accept: "application/json" });
    const storedToken = localStorage.getItem("openwork:web:auth-token")?.trim();
    if (storedToken) headers.set("Authorization", "Bearer " + storedToken);
    const configResponse = await fetch("/api/den/v1/me/install-config", {
      credentials: "include",
      headers,
    });
    const config = await configResponse.json();
    return JSON.stringify({
      search: location.search,
      configLoaded: resources.some((url) => url.includes("/v1/me/install-config")),
      mintedToken: resources.some((url) => url.includes("/install-links") || url.includes("/v1/install-config?token=")),
      configStatus: configResponse.status,
      distribution: config?.distribution,
      downloadHrefs: hrefs.filter((href) => href.includes("/v1/me/install/")),
      cloudDownloadSurface: [...document.querySelectorAll("h1")]
        .some((heading) => (heading.textContent ?? "").trim() === "Download OpenWork"),
      cloudReturnControl: [...document.querySelectorAll("a")]
        .some((anchor) => (anchor.textContent ?? "").trim() === "I already installed OpenWork"),
      enterpriseGuide: Boolean(document.querySelector('[data-testid="install-guide"]')),
      skipControl: Boolean(document.querySelector('[data-testid="install-skip-download"]')),
      workspaceControl: Boolean(document.querySelector('[data-testid="install-workspace-address"]')),
      text: document.body.innerText.replace(/\\s+/g, " ").slice(0, 400),
    });
  })()`, { awaitPromise: true });
  const install: unknown = JSON.parse(String(rawInstall));
  if (!isRecord(install) || !Array.isArray(install.downloadHrefs) || !install.downloadHrefs.every((href) => typeof href === "string")) {
    throw new Error(`Install facts had an unexpected shape: ${JSON.stringify(install)}`);
  }
  const distribution = install.distribution;
  if (distribution !== "cloud" && distribution !== "enterprise") {
    throw new Error(`Install config returned an invalid distribution: ${JSON.stringify(distribution)}`);
  }
  const downloadHref = install.downloadHrefs[0];
  if (typeof downloadHref !== "string") throw new Error("Install page exposed no authenticated download link");
  expect(install.search).toBe("");
  expect(install.configLoaded).toBe(true);
  expect(install.mintedToken).toBe(false);
  expect(install.configStatus).toBe(200);
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
    expect(install.skipControl).toBe(true);
    expect(install.cloudReturnControl).toBe(false);
  }

  const member = await signIn(den.ref, { email: invitee.email, password: invitee.password });
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
    evidence.recordAssertionEvidence(
      "Connect hands the member the exact workspace address",
      `Step 3 shows ${shownAddress}, exactly the Den web origin the browser is signed in on, with a copy control and no credential.`,
      shownAddress === webOrigin,
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

    const typeIntoGate = (value: string) => evalIn(desktopSurface, `(() => {
      const input = document.querySelector('#organization-server-input');
      if (!(input instanceof HTMLInputElement)) return "no input";
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
      setValue.call(input, ${JSON.stringify(value)});
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.closest("form")?.requestSubmit();
      return "submitted";
    })()`);

    // Server-first path up to the browser handoff: typing the address reaches
    // the explicit origin-naming confirmation with Continue in browser.
    expect(await typeIntoGate(webOrigin)).toBe("submitted");
    await waitFor(
      desktopSurface,
      `Boolean(document.querySelector('[data-testid="organization-server-confirm"]'))
        && document.body.innerText.includes(${JSON.stringify(webOrigin)})
        && document.body.innerText.includes("Continue in browser")`,
      { timeoutMs: 30_000, label: "origin-naming confirmation for the typed address" },
    );
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

  // ── Frame 6: the stamped record unlocks ONLY its origin on a broken-chain,
  //             semi-airgapped network ─────────────────────────────────────
  await using lab = await startEgressLab({ profile: "broken-chain" });
  if (!lab.caPath || !lab.rootPem) throw new Error("egress lab did not expose its private root material");
  const labOrigin = new URL(lab.url).origin;

  const before = await fetchLabInChild(lab.url, { ...process.env, NODE_EXTRA_CA_CERTS: lab.caPath });
  expect(before.status).not.toBe(0);
  expect(before.output).toMatch(chainErrorPattern);

  const repaired = await resolveCaEnvFromRecord({
    bootstrapPath: await writeStampedBootstrap(labOrigin),
    rootPem: lab.rootPem,
  });
  expect(repaired.logs.some((line) => line.includes(`chain repaired for ${labOrigin}`))).toBe(true);
  const healed = await fetchLabInChild(lab.url, { ...process.env, ...repaired.caEnv });
  expect(healed.status).toBe(0);

  const mismatchedOrigin = `https://127.0.0.1:${await reserveClosedPort()}`;
  const mismatched = await resolveCaEnvFromRecord({
    bootstrapPath: await writeStampedBootstrap(mismatchedOrigin),
    rootPem: lab.rootPem,
  });
  expect(mismatched.logs.some((line) => /chain repaired/.test(line))).toBe(false);
  const stillBroken = await fetchLabInChild(lab.url, { ...process.env, ...mismatched.caEnv });
  expect(stillBroken.status).not.toBe(0);
  expect(stillBroken.output).toMatch(chainErrorPattern);
  evidence.recordAssertionEvidence(
    "The activation record from this flow repairs TLS only for its own origin",
    `With the exact bootstrap shape the gate stamps, a leaf-only broken chain at ${labOrigin} failed (${chainErrorPattern.exec(before.output)?.[0] ?? "chain error"}), was repaired solely from the stamped origin (exit 0), and a record naming ${mismatchedOrigin} left the lab unreachable — the semi-airgapped network stays closed to everything but the stamped workspace.`,
    true,
  );

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
