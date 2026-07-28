import { execSync } from "node:child_process";
import { connect, listTargets, type CdpTarget } from "../runner/cdp.ts";
import { defineFlow, type FlowContext } from "../runner/flow.ts";
import { loadVoiceoverParagraphs } from "../runner/voiceover.ts";
import { denApiFetch, denApiUrl, denWebUrl } from "./lib/den-web.mjs";

const FLOW_ID = "org-install-activation";
const INVITE_PASSWORD = "OpenWorkDemo!123";
const BROWSER_TIMEOUT_MS = 20_000;
const vo = await loadVoiceoverParagraphs(FLOW_ID);

if (!vo) throw new Error(`Missing approved voice-over script for ${FLOW_ID}.`);

interface ActivationFlowState {
  desktopClient: FlowContext["client"];
  originalDesktopBootstrapConfig: unknown;
  desktopConfigured: boolean;
  inviteeEmail: string;
  invitationId: string;
  invitationToken: string;
  memberBearer: string;
  installLink: string;
  activationUrl: string;
  connectUrl: string;
  webTargetId: string;
}

const state: ActivationFlowState = {
  desktopClient: null,
  originalDesktopBootstrapConfig: null,
  desktopConfigured: false,
  inviteeEmail: "",
  invitationId: "",
  invitationToken: "",
  memberBearer: "",
  installLink: "",
  activationUrl: "",
  connectUrl: "",
  webTargetId: "",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getDenStackUrls(): { apiBaseUrl: string; webBaseUrl: string } {
  return {
    apiBaseUrl: requiredString(denApiUrl(), "OPENWORK_EVAL_DEN_API_URL"),
    webBaseUrl: requiredString(denWebUrl(), "OPENWORK_EVAL_DEN_WEB_URL"),
  };
}

function evalToken(ctx: FlowContext): string {
  return requiredString(ctx.env.OPENWORK_EVAL_DEN_TOKEN, "OPENWORK_EVAL_DEN_TOKEN");
}

function randomInviteeEmail(ctx: FlowContext): string {
  const domain = requiredString(ctx.env.OPENWORK_EVAL_ORG_DOMAIN, "OPENWORK_EVAL_ORG_DOMAIN");
  return `maya-activation-${Date.now().toString(36)}@${domain}`;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value.trim();
}

function exactTextClickExpression(label: string): string {
  return `(() => {
    const expected = ${JSON.stringify(label)};
    const normalize = (value) => String(value || "").replace(/\\s+/g, " ").trim();
    const element = [...document.querySelectorAll("button, a")]
      .find((candidate) => normalize(candidate.textContent) === expected);
    if (!(element instanceof HTMLElement)) {
      throw new Error("Missing exact control: " + expected);
    }
    element.click();
    return true;
  })()`;
}

async function clickExactText(ctx: FlowContext, label: string): Promise<void> {
  await ctx.eval(exactTextClickExpression(label));
}

async function firstPageTarget(cdpBaseUrl: string): Promise<CdpTarget> {
  const existing = await listTargets(cdpBaseUrl);
  const remembered = existing.find(
    (target) => target.id === state.webTargetId && target.type === "page" && target.webSocketDebuggerUrl,
  );
  if (remembered) return remembered;
  const available = existing.find(
    (target) => target.type === "page" && target.webSocketDebuggerUrl && target.url !== "about:blank",
  ) ?? existing.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
  if (available) {
    state.webTargetId = available.id;
    return available;
  }

  try {
    const response = await fetch(`${cdpBaseUrl}/json/new?about:blank`, { method: "PUT" });
    if (response.ok) {
      const created: unknown = await response.json();
      if (
        isRecord(created)
        && created.type === "page"
        && typeof created.id === "string"
        && typeof created.webSocketDebuggerUrl === "string"
      ) {
        const target = {
          id: created.id,
          type: "page",
          title: typeof created.title === "string" ? created.title : "",
          url: typeof created.url === "string" ? created.url : "about:blank",
          webSocketDebuggerUrl: created.webSocketDebuggerUrl,
        };
        state.webTargetId = target.id;
        return target;
      }
    }
  } catch {
    // Fall back to a page that is already available.
  }

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const targets = await listTargets(cdpBaseUrl);
    const page = targets.find((target) => target.type === "page");
    if (page) {
      state.webTargetId = page.id;
      return page;
    }
    await wait(250);
  }
  throw new Error(`No browser page target found at ${cdpBaseUrl}.`);
}

async function withWeb(ctx: FlowContext, run: () => Promise<void>): Promise<void> {
  const webCdpBaseUrl = requiredString(ctx.env.OPENWORK_EVAL_WEB_CDP_INVITEE, "OPENWORK_EVAL_WEB_CDP_INVITEE");
  const previousClient = ctx.client;
  const target = await firstPageTarget(webCdpBaseUrl);
  const webClient = await connect(requiredString(target.webSocketDebuggerUrl, "web CDP debugger URL"));
  ctx.client = webClient;
  try {
    await run();
  } finally {
    ctx.client = previousClient;
    webClient.close();
  }
}

async function navigate(ctx: FlowContext, url: string): Promise<void> {
  if (!ctx.client) throw new Error("A CDP client is required.");
  await ctx.client.send("Page.navigate", { url });
  await ctx.waitFor("document.readyState === 'complete'", { timeoutMs: 30_000, label: `load ${url}` });
}

async function invokeDesktop(ctx: FlowContext, command: string, input?: unknown): Promise<unknown> {
  await ctx.waitFor("Boolean(window.__OPENWORK_ELECTRON__?.invokeDesktop)", {
    timeoutMs: 60_000,
    label: "desktop bridge",
  });
  return ctx.eval(
    `window.__OPENWORK_ELECTRON__.invokeDesktop(${JSON.stringify(command)}, ${JSON.stringify(input)})`,
    { awaitPromise: true },
  );
}

async function captureOriginalDesktopBootstrap(ctx: FlowContext): Promise<void> {
  if (state.desktopConfigured) return;
  state.originalDesktopBootstrapConfig = await invokeDesktop(ctx, "getDesktopBootstrapConfig");
  state.desktopConfigured = true;
}

async function restoreDesktopBootstrap(ctx: FlowContext): Promise<void> {
  if (!state.desktopConfigured) return;
  try {
    await invokeDesktop(ctx, "setDesktopBootstrapConfig", state.originalDesktopBootstrapConfig);
  } finally {
    state.desktopConfigured = false;
    state.originalDesktopBootstrapConfig = null;
  }
}

function markInviteeVerified(ctx: FlowContext, email: string): void {
  const commandTemplate = requiredString(
    ctx.env.OPENWORK_EVAL_MARK_VERIFIED_CMD,
    "OPENWORK_EVAL_MARK_VERIFIED_CMD",
  );
  execSync(commandTemplate.replaceAll("{email}", email), {
    cwd: new URL("../../", import.meta.url),
    env: ctx.env,
    stdio: "ignore",
  });
}

async function createInvitation(ctx: FlowContext): Promise<void> {
  state.inviteeEmail = randomInviteeEmail(ctx);
  const created = await denApiFetch("/v1/invitations", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${evalToken(ctx)}`,
    },
    body: JSON.stringify({ email: state.inviteeEmail, role: "member" }),
  });
  ctx.output("create-invitation", JSON.stringify({
    status: created.response.status,
    email: state.inviteeEmail,
  }, null, 2));
  ctx.assert(created.response.ok, `invitation creation failed (${created.response.status})`);
  ctx.assert(isRecord(created.body), "invitation response must be an object");
  if (!isRecord(created.body)) return;
  state.invitationId = requiredString(created.body.invitationId, "invitation id");
  state.invitationToken = requiredString(created.body.inviteToken, "invitation token");
}

async function clearDenWebSession(ctx: FlowContext): Promise<void> {
  const { webBaseUrl } = getDenStackUrls();
  await navigate(ctx, webBaseUrl);
  await ctx.eval(
    `Promise.allSettled([
      fetch('/api/den/api/auth/sign-out', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }),
      fetch('/api/auth/sign-out', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }),
    ]).then(() => {
      localStorage.clear();
      sessionStorage.clear();
      return true;
    })`,
    { awaitPromise: true },
  );
  if (!ctx.client) throw new Error("A CDP client is required.");
  await ctx.client.send("Network.clearBrowserCookies", {});
}

async function acceptInvitationAndOpenWelcome(ctx: FlowContext): Promise<void> {
  const { webBaseUrl } = getDenStackUrls();
  await clearDenWebSession(ctx);
  const invitationUrl = new URL(
    `/join-org?invite=${encodeURIComponent(state.invitationToken)}`,
    webBaseUrl,
  ).toString();
  await navigate(ctx, invitationUrl);
  await ctx.waitFor("Boolean(document.querySelector('input[type=\"password\"]'))", {
    timeoutMs: 30_000,
    label: "invite password field",
  });
  await ctx.fill('input[type="password"]', INVITE_PASSWORD);
  const joinLabel = `Join ${requiredString(ctx.env.OPENWORK_EVAL_ORG_NAME, "OPENWORK_EVAL_ORG_NAME")}`;
  await clickExactText(ctx, joinLabel);
  await ctx.waitFor(
    `document.body.innerText.includes("You're one click away from the team workspace.")
      || Boolean(document.querySelector('[data-testid="join-org-success"]'))`,
    { timeoutMs: 45_000, label: "signed-in invite accept step" },
  );
  const alreadySuccess = await ctx.eval("Boolean(document.querySelector('[data-testid=\"join-org-success\"]'))");
  if (!alreadySuccess) {
    markInviteeVerified(ctx, state.inviteeEmail);
    await clickExactText(ctx, joinLabel);
  }
  await ctx.waitFor("Boolean(document.querySelector('[data-testid=\"join-org-success\"]'))", {
    timeoutMs: 45_000,
    label: "join-org success",
  });
}

async function openInstallGuide(ctx: FlowContext): Promise<void> {
  await ctx.trustedClick("[data-testid=join-org-get-app]");
  await ctx.waitForText("Download the OpenWork installer", { timeoutMs: BROWSER_TIMEOUT_MS });
  const href = await ctx.eval(`window.location.href`);
  state.installLink = requiredString(href, "install link");
}

function extractInstallToken(installLink: string): string {
  const token = new URL(installLink).searchParams.get("token")?.trim() ?? "";
  return requiredString(token, "install token");
}

async function loadActivationHandoff(ctx: FlowContext): Promise<void> {
  if (state.activationUrl && state.connectUrl) return;
  const token = extractInstallToken(state.installLink);
  const config = await denApiFetch(`/v1/install-config?token=${encodeURIComponent(token)}`);
  ctx.assert(config.response.ok && isRecord(config.body), `install config failed (${config.response.status})`);
  if (!isRecord(config.body)) return;
  state.activationUrl = requiredString(config.body.activationUrl, "activation URL");
  state.connectUrl = requiredString(config.body.connectUrl, "OpenWork connect URL");
}

async function startDownloadWithoutFetchingAsset(ctx: FlowContext): Promise<void> {
  const recommendation = await ctx.eval(`(() => {
    const grid = document.querySelector('[data-testid="download-platform-grid"]');
    const primary = document.querySelector('[data-testid="install-download-primary"]');
    return {
      detectedOs: grid?.getAttribute("data-detected-os") ?? "",
      detectedArch: grid?.getAttribute("data-detected-arch") ?? "",
      recommended: primary?.getAttribute("data-recommended") === "true",
    };
  })()`);
  ctx.assert(
    isRecord(recommendation)
      && typeof recommendation.detectedOs === "string"
      && recommendation.detectedOs.length > 0
      && recommendation.recommended === true,
    "the guide must detect this computer and mark one installer as recommended",
  );
  await ctx.eval(`(() => {
    document.addEventListener("click", (event) => {
      const target = event.target instanceof Element ? event.target.closest("a") : null;
      if (target?.matches('[data-testid="install-download-primary"]')) event.preventDefault();
    }, { capture: true, once: true });
  })()`);
  await ctx.trustedClick('[data-testid="install-download-primary"]');
  await ctx.waitForText("Continue on your computer", { timeoutMs: BROWSER_TIMEOUT_MS });
  await ctx.waitFor("document.querySelector('[data-testid=install-guide-step-download]')?.dataset.state === 'complete'", {
    timeoutMs: BROWSER_TIMEOUT_MS,
    label: "download step complete",
  });
}

async function showAlreadyInstalledRecoveryLink(ctx: FlowContext): Promise<void> {
  await ctx.waitFor("Boolean(document.querySelector('[data-testid=install-copy-link] input'))", {
    timeoutMs: BROWSER_TIMEOUT_MS,
    label: "organization install link",
  });
  await ctx.eval(`(() => {
    const disclosure = document.querySelector('[data-testid=install-copy-link]')?.closest('details');
    if (disclosure instanceof HTMLDetailsElement) disclosure.open = true;
    return true;
  })()`);
  await ctx.waitForText("Paste this link into", { timeoutMs: BROWSER_TIMEOUT_MS });
}

async function useDesktop(ctx: FlowContext): Promise<void> {
  if (!state.desktopClient) throw new Error("Desktop CDP client was not captured.");
  ctx.client = state.desktopClient;
}

async function resetDesktopSession(ctx: FlowContext): Promise<void> {
  await ctx.waitFor("Boolean(window.__openworkControl)", { timeoutMs: 60_000, label: "desktop ready" });
  await captureOriginalDesktopBootstrap(ctx);
  await ctx.eval(`(() => {
    document.querySelector('[data-testid=connect-confirm-cancel]')?.click();
    document.querySelector('[data-testid=connect-error-dismiss]')?.click();
    for (const key of [
      "openwork.den.authToken",
      "openwork.den.activeOrgId",
      "openwork.den.activeOrgSlug",
      "openwork.den.activeOrgName",
    ]) localStorage.removeItem(key);
    window.dispatchEvent(new CustomEvent("openwork-den-session-updated", { detail: { status: "signed_out" } }));
    return true;
  })()`);
}

async function deliverConnectLinkToDesktop(ctx: FlowContext): Promise<void> {
  await deliverDeepLinkToDesktop(ctx, state.connectUrl);
  await ctx.waitFor("Boolean(document.querySelector('[data-testid=connect-confirm-dialog]'))", {
    timeoutMs: 30_000,
    label: "connection confirmation",
  });
}

async function acceptDesktopConnection(ctx: FlowContext): Promise<void> {
  await ctx.trustedClick("[data-testid=connect-confirm-accept]");
  await ctx.waitForText("Welcome to OpenWork", { timeoutMs: 45_000 });
}

async function signInInvitee(ctx: FlowContext): Promise<void> {
  const signIn = await denApiFetch("/api/auth/sign-in/email", {
    method: "POST",
    body: JSON.stringify({ email: state.inviteeEmail, password: INVITE_PASSWORD }),
  });
  ctx.assert(signIn.response.ok && isRecord(signIn.body), `invitee sign in failed (${signIn.response.status})`);
  if (!isRecord(signIn.body)) return;
  state.memberBearer = requiredString(signIn.body.token, "member bearer");
  const handoff = await denApiFetch("/v1/auth/desktop-handoff", {
    method: "POST",
    headers: { Authorization: `Bearer ${state.memberBearer}` },
    body: JSON.stringify({ desktopScheme: "openwork" }),
  });
  ctx.assert(handoff.response.ok && isRecord(handoff.body), `desktop handoff failed (${handoff.response.status})`);
  if (!isRecord(handoff.body)) return;
  const openworkUrl = requiredString(handoff.body.openworkUrl, "desktop handoff URL");
  await deliverDeepLinkToDesktop(ctx, openworkUrl);
  await ctx.waitFor("Boolean((localStorage.getItem('openwork.den.authToken') ?? '').trim())", {
    timeoutMs: 60_000,
    label: "persisted Den auth token",
  });
  await completeDesktopSignedInJourney(ctx);
}

async function deliverDeepLinkToDesktop(ctx: FlowContext, openworkUrl: string): Promise<void> {
  await ctx.eval(`(() => {
    const url = ${JSON.stringify(openworkUrl)};
    window.__OPENWORK__ = window.__OPENWORK__ || {};
    const pending = window.__OPENWORK__.deepLinks || [];
    window.__OPENWORK__.deepLinks = [...pending, url];
    window.dispatchEvent(new CustomEvent("openwork:deep-link", { detail: { urls: [url] } }));
    return true;
  })()`);
}

async function completeDesktopSignedInJourney(ctx: FlowContext): Promise<void> {
  await ctx.waitFor(
    `document.body.innerText.includes("Choose your organization")
      || document.body.innerText.includes("You have access to the following resources.")
      || document.body.innerText.includes("No resources have been configured for this organization yet.")
      || location.hash.includes("/session")
      || location.hash.includes("/workspace/")
      || document.body.innerText.includes("OpenWork Cloud")`,
    { timeoutMs: 60_000, label: "post-sign-in desktop surface" },
  );

  if (await ctx.hasText("Choose your organization")) {
    await clickExactText(ctx, "Continue with organization");
    await ctx.waitFor(
      `document.body.innerText.includes("You have access to the following resources.")
        || document.body.innerText.includes("No resources have been configured for this organization yet.")`,
      { timeoutMs: 45_000, label: "organization resources step" },
    );
  }
  if (await ctx.hasText("You have access to the following resources.")) {
    await clickExactText(ctx, "Continue to workspace");
  } else if (await ctx.hasText("No resources have been configured for this organization yet.")) {
    await clickExactText(ctx, "Continue");
  }
  await ctx.waitFor("location.hash.includes('/session') || location.hash.includes('/workspace/')", {
    timeoutMs: 45_000,
    label: "workspace route",
  });
  await ctx.navigateHash("/settings/cloud-account");
  await ctx.waitForText("OpenWork Cloud", { timeoutMs: 45_000 });
  await ctx.waitForText("Sign out", { timeoutMs: 45_000 });
}

async function cleanupDesktopSession(ctx: FlowContext): Promise<void> {
  try {
    await ctx.eval(`(() => {
      document.querySelector('[data-testid=connect-confirm-cancel]')?.click();
      document.querySelector('[data-testid=connect-error-dismiss]')?.click();
      for (const key of [
        "openwork.den.authToken",
        "openwork.den.activeOrgId",
        "openwork.den.activeOrgSlug",
        "openwork.den.activeOrgName",
      ]) localStorage.removeItem(key);
      window.dispatchEvent(new CustomEvent("openwork-den-session-updated", { detail: { status: "signed_out" } }));
      return true;
    })()`);
  } catch {
    // Continue restoring the original bootstrap.
  }
  await restoreDesktopBootstrap(ctx);
}

async function prepareFlow(ctx: FlowContext): Promise<void> {
  state.desktopClient = ctx.client;
  await createInvitation(ctx);
}

async function assertBrandedWelcome(ctx: FlowContext): Promise<void> {
  await ctx.expectText("You're in, welcome to");
  await ctx.expectText(requiredString(ctx.env.OPENWORK_EVAL_ORG_NAME, "OPENWORK_EVAL_ORG_NAME"));
  await ctx.expectText("Get the desktop app");
  await ctx.expectText("Continue in the browser");
}

async function assertInstallRecommendation(ctx: FlowContext): Promise<void> {
  await ctx.expectText("Download the OpenWork installer");
  await ctx.expectText("For your device");
  await ctx.expectText("Continue on your computer");
}

async function assertAlreadyInstalledContinuation(ctx: FlowContext): Promise<void> {
  await ctx.expectText("Continue on your computer");
  await ctx.expectText("Open the file you just downloaded");
  await ctx.expectText("Already have");
  await ctx.expectText("Paste this link into");
}

async function assertDesktopConfirmation(ctx: FlowContext): Promise<void> {
  await ctx.expectText("Nothing has been changed yet.");
  await ctx.expectText(requiredString(ctx.env.OPENWORK_EVAL_ORG_NAME, "OPENWORK_EVAL_ORG_NAME"));
  await ctx.expectText(new URL(getDenStackUrls().webBaseUrl).host);
  await ctx.expectText("Connect");
}

async function assertBrowserConnected(ctx: FlowContext): Promise<void> {
  const orgName = requiredString(ctx.env.OPENWORK_EVAL_ORG_NAME, "OPENWORK_EVAL_ORG_NAME");
  await ctx.expectText(`Connected to ${orgName}`);
  await ctx.expectText(`${orgName}'s setup and branding are ready`);
  await ctx.expectText("Return to OpenWork");
  await ctx.expectText("Copy this OpenWork link");
}

async function assertSignedInDesktop(ctx: FlowContext): Promise<void> {
  await ctx.expectText(state.inviteeEmail);
  const orgName = requiredString(ctx.env.OPENWORK_EVAL_ORG_NAME, "OPENWORK_EVAL_ORG_NAME");
  await ctx.expectText(orgName);
  const activeOrgName = await ctx.eval("localStorage.getItem('openwork.den.activeOrgName') ?? ''");
  ctx.assert(activeOrgName === orgName, "desktop must retain the active organization name");
  const bootstrap = await invokeDesktop(ctx, "getDesktopBootstrapConfig");
  ctx.assert(
    isRecord(bootstrap) && bootstrap.requireSignin === true,
    "desktop bootstrap must retain the organization's required sign-in policy",
  );
}

const flow = defineFlow({
  id: FLOW_ID,
  title: "Join an organization and reach a confirmed, branded desktop",
  kind: "user-facing",
  spec: "evals/voiceovers/org-install-activation.md",
  requiredEnv: [
    "OPENWORK_EVAL_DEN_API_URL",
    "OPENWORK_EVAL_DEN_WEB_URL",
    "OPENWORK_EVAL_DEN_TOKEN",
    "OPENWORK_EVAL_MARK_VERIFIED_CMD",
    "OPENWORK_EVAL_WEB_CDP_INVITEE",
    "OPENWORK_EVAL_ORG_NAME",
    "OPENWORK_EVAL_ORG_DOMAIN",
  ],
  steps: [
    {
      name: "Frame 1",
      run: async (ctx) => {
        await prepareFlow(ctx);
        await withWeb(ctx, async () => {
          await ctx.prove("Branded organization welcome", {
            voiceover: vo[0],
            action: async () => acceptInvitationAndOpenWelcome(ctx),
            assert: async () => assertBrandedWelcome(ctx),
            screenshot: {
              name: "branded-organization-welcome",
              requireText: ["You're in, welcome to", "Get the desktop app", "Continue in the browser"],
            },
          });
        });
      },
    },
    {
      name: "Frame 2",
      run: async (ctx) => {
        await withWeb(ctx, async () => {
          await ctx.prove("Platform-aware install recommendation", {
            voiceover: vo[1],
            action: async () => {
              await openInstallGuide(ctx);
              await startDownloadWithoutFetchingAsset(ctx);
            },
            assert: async () => assertInstallRecommendation(ctx),
            screenshot: {
              name: "platform-aware-install-recommendation",
              requireText: ["Download the OpenWork installer", "For your device", "Continue on your computer"],
            },
          });
        });
      },
    },
    {
      name: "Frame 3",
      run: async (ctx) => {
        await withWeb(ctx, async () => {
          await ctx.prove("Already-installed recovery path", {
            voiceover: vo[2],
            action: async () => showAlreadyInstalledRecoveryLink(ctx),
            assert: async () => assertAlreadyInstalledContinuation(ctx),
            screenshot: {
              name: "already-installed-recovery-path",
              requireText: ["Continue on your computer", "Open the file you just downloaded", "Paste this link into"],
            },
          });
        });
      },
    },
    {
      name: "Frame 4",
      run: async (ctx) => {
        await ctx.prove("Desktop connection confirmation", {
          voiceover: vo[3],
          action: async () => {
            await withWeb(ctx, async () => {
              await loadActivationHandoff(ctx);
              await navigate(ctx, state.activationUrl);
              await ctx.waitForText("Open OpenWork", { timeoutMs: BROWSER_TIMEOUT_MS });
              await ctx.expectText(requiredString(ctx.env.OPENWORK_EVAL_ORG_NAME, "OPENWORK_EVAL_ORG_NAME"));
            });
            await useDesktop(ctx);
            await resetDesktopSession(ctx);
            await deliverConnectLinkToDesktop(ctx);
          },
          assert: async () => assertDesktopConfirmation(ctx),
          screenshot: {
            name: "desktop-connection-confirmation",
            requireText: ["Nothing has been changed yet", "Connect"],
          },
        });
      },
    },
    {
      name: "Frame 5",
      run: async (ctx) => {
        await withWeb(ctx, async () => {
          const webClient = ctx.client;
          await ctx.prove("Connected browser status", {
            voiceover: vo[4],
            action: async () => {
              await useDesktop(ctx);
              await acceptDesktopConnection(ctx);
              ctx.client = webClient;
              await ctx.waitForText(
                `Connected to ${requiredString(ctx.env.OPENWORK_EVAL_ORG_NAME, "OPENWORK_EVAL_ORG_NAME")}`,
                { timeoutMs: BROWSER_TIMEOUT_MS },
              );
            },
            assert: async () => assertBrowserConnected(ctx),
            screenshot: {
              name: "connected-browser-status",
              requireText: ["Connected to", "Return to OpenWork", "Copy this OpenWork link"],
            },
          });
        });
      },
    },
    {
      name: "Frame 6",
      run: async (ctx) => {
        try {
          await useDesktop(ctx);
          await ctx.prove("Signed-in branded desktop", {
            voiceover: vo[5],
            action: async () => signInInvitee(ctx),
            assert: async () => assertSignedInDesktop(ctx),
            screenshot: {
              name: "signed-in-branded-desktop",
              requireText: ["OpenWork Cloud", state.inviteeEmail, "Sign out"],
            },
          });
        } finally {
          await cleanupDesktopSession(ctx);
        }
      },
    },
  ],
});

export default flow;
