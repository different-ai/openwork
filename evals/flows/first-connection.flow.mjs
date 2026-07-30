import { execSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { connect, debuggerUrlFor, listTargets } from "../runner/cdp.mjs";
import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

// Narration is loaded from the approved script (evals/voiceovers/first-connection.md).
// The runner fails this flow if the narration drifts from that script.
const vo = await loadVoiceoverParagraphs("first-connection");

const DEN_API_URL = cleanBaseUrl(process.env.OPENWORK_EVAL_DEN_API_URL);
const DEN_WEB_URL = cleanBaseUrl(process.env.OPENWORK_EVAL_DEN_WEB_URL);
const ADMIN_CDP_URL = cleanBaseUrl(process.env.OPENWORK_EVAL_WEB_CDP_ADMIN);
const INVITEE_CDP_URL = cleanBaseUrl(process.env.OPENWORK_EVAL_WEB_CDP_INVITEE);
const MARK_VERIFIED_CMD = process.env.OPENWORK_EVAL_MARK_VERIFIED_CMD?.trim() || "";
const ADMIN_EMAIL = process.env.OPENWORK_EVAL_DEMO_EMAIL?.trim() || "alex@acme.test";
const ADMIN_PASSWORD = process.env.OPENWORK_EVAL_DEMO_PASSWORD?.trim() || "OpenWorkDemo123!";
const RUN_TAG = Date.now().toString(36);
const MEMBER_EMAIL = process.env.OPENWORK_EVAL_MEMBER_EMAIL?.trim() || `riley.first.connection+${RUN_TAG}@acme.test`;
const MEMBER_PASSWORD = process.env.OPENWORK_EVAL_MEMBER_PASSWORD?.trim() || "OpenWorkDemo123!";
const BOOTSTRAP_PATH = process.env.OPENWORK_EVAL_BOOTSTRAP_PATH?.trim()
  || path.join(makeTempDir("openwork-first-connection-bootstrap-"), "desktop-bootstrap.json");

const state = {
  desktopClient: null,
  originalDesktopBootstrapConfig: null,
  adminToken: null,
  orgId: null,
  installLink: null,
  installPageUrl: null,
  installToken: null,
  installConfig: null,
  installPageTargetId: null,
  authTargetId: null,
  frame3DownloadRedirect: null,
  memberSetup: null,
  browserSignInUrl: null,
  copiedDesktopUrl: null,
  copiedDesktopGrant: null,
  usedInstallPageReload: false,
};

export default {
  id: "first-connection",
  title: "An invited teammate follows one Acme install link from dashboard copy to verified desktop connection",
  kind: "user-facing",
  requiredEnv: [
    "OPENWORK_EVAL_DEN_API_URL",
    "OPENWORK_EVAL_DEN_TOKEN",
    "OPENWORK_EVAL_DEN_WEB_URL",
    "OPENWORK_EVAL_WEB_CDP_ADMIN",
    "OPENWORK_EVAL_WEB_CDP_INVITEE",
    "OPENWORK_EVAL_MARK_VERIFIED_CMD",
  ],
  steps: [
    {
      name: "Frame 1",
      run: async (ctx) => {
        rememberDesktopClient(ctx);
        await withClient(ctx, ADMIN_CDP_URL, async () => {
          await ctx.prove("Alex copies a workspace install link from the dashboard and the token resolves to Acme's required sign-in config", {
            voiceover: vo[0],
            // "On the OpenWork dashboard home, the admin clicks Download for this workspace"
            action: async () => {
              await ensureAdminToken(ctx);
              await ensureOrgId(ctx);
              await signInToDenWeb(ctx, ADMIN_EMAIL, ADMIN_PASSWORD);
              await goToDenWeb(ctx, "/dashboard");
              await ctx.waitFor("Boolean(document.querySelector('[data-testid=\"workspace-install-card\"]'))", {
                timeoutMs: 45_000,
                label: "workspace install card",
              });
              await stubInstallLinkClipboardCapture(ctx);
              await clickSelector(ctx, '[data-testid="workspace-install-copy"]', "workspace install copy button");
              state.installLink = await ctx.waitFor(
                "typeof window.__capturedInstallLink === 'string' && window.__capturedInstallLink.includes('/install?token=') && window.__capturedInstallLink",
                { timeoutMs: 30_000, label: "captured dashboard install link" },
              );
              await ctx.waitFor(
                "document.querySelector('[data-testid=\"workspace-install-copy\"]')?.textContent?.trim() === 'Copy install link'",
                { timeoutMs: 8_000, label: "workspace copy button restored" },
              );
              state.installPageUrl = installPageUrlForBrowser(requireStateValue(state.installLink, "install link"));
              state.installToken = extractInstallToken(requireStateValue(state.installLink, "install link"), ctx);
            },
            assert: async () => {
              const installLink = requireStateValue(state.installLink, "install link");
              const parsed = new URL(installLink);
              witness(ctx, parsed.pathname === "/install" && Boolean(parsed.searchParams.get("token")), "The copied link is an /install?token= URL", installLink);

              const config = await fetchInstallConfig(ctx, requireStateValue(state.installToken, "install token"));
              witness(ctx, config.clientName === "Acme Robotics", "The install token resolves to Acme Robotics", config);
              witness(ctx, config.requireSignin === true, "The install token requires normal sign-in", config);
              state.installConfig = config;
              ctx.output("dashboard-install-link", JSON.stringify({ installLink, browserInstallPageUrl: state.installPageUrl, config }, null, 2));

              await ctx.expectText("Download for this workspace");
              await ctx.expectText("Copy install link");
            },
            screenshot: {
              name: "dashboard-workspace-install-card",
              requireText: ["Download for this workspace", "Copy install link"],
              rejectText: ["Could not copy the workspace install link"],
            },
          });
        });
      },
    },
    {
      name: "Frame 2",
      run: async (ctx) => {
        state.installPageTargetId = state.installPageTargetId ?? (await newPageTarget(INVITEE_CDP_URL)).id;
        await withClient(ctx, INVITEE_CDP_URL, async () => {
          await ctx.prove("Riley opens the install link and sees Acme's three-step checklist with the same link pinned for installer fallback", {
            voiceover: vo[1],
            // "The invitee opens that link and sees a three-step checklist — download, open"
            action: async () => {
              await clearDenWebSession(ctx);
              await navigateToAbsolute(ctx, requireStateValue(state.installPageUrl, "install page URL"));
              await ctx.waitFor("Boolean(document.querySelector('[data-testid=\"install-page\"]'))", {
                timeoutMs: 45_000,
                label: "install page",
              });
              await ctx.waitFor("Boolean(document.querySelector('[data-testid=\"install-guide\"]'))", {
                timeoutMs: 45_000,
                label: "install guide checklist",
              });
            },
            assert: async () => {
              await ctx.expectText("Download OpenWork for Acme Robotics");
              await ctx.expectText("Apple Silicon (M1+)");
              await ctx.expectText("Download the OpenWork installer");
              await ctx.expectText("Open the installer and paste this link:");
              await ctx.expectText("Sign in");
              await ctx.expectText("Waiting for sign-in");
              const checklist = await ctx.eval(`(() => ({
                download: Boolean(document.querySelector('[data-testid="install-guide-step-download"]')),
                open: Boolean(document.querySelector('[data-testid="install-guide-step-open"]')),
                signin: Boolean(document.querySelector('[data-testid="install-guide-step-signin"]')),
                copyValue: document.querySelector('[data-testid="install-copy-link"] input')?.value ?? '',
                heading: document.querySelector('h1')?.textContent ?? '',
                waiting: document.querySelector('[data-testid="install-guide-step-signin"]')?.textContent ?? '',
              }))()`);
              witness(ctx, checklist.download && checklist.open && checklist.signin, "The install page renders all three checklist steps", checklist);
              witness(ctx, checklist.copyValue === requireStateValue(state.installPageUrl, "install page URL"), "The copy box pins the current install page URL", checklist.copyValue);
              witness(ctx, String(checklist.heading).includes("Acme Robotics"), "The install page heading names Acme Robotics", checklist.heading);
              witness(ctx, String(checklist.waiting).includes("Waiting for sign-in"), "Step three starts in the waiting-for-sign-in state", checklist.waiting);
            },
            screenshot: {
              name: "invitee-acme-install-checklist",
              requireText: ["Download OpenWork for Acme Robotics", "Download the OpenWork installer", "Open the installer and paste this link:", "Waiting for sign-in"],
            },
          });
        }, { targetId: state.installPageTargetId });
      },
    },
    {
      name: "Frame 3",
      run: async (ctx) => {
        await withClient(ctx, INVITEE_CDP_URL, async () => {
          await ctx.prove("The Acme install download redirects to the standard desktop release asset", {
            voiceover: vo[2],
            // "The download itself is just the standard desktop app for the org-approved version"
            action: async () => {
              state.frame3DownloadRedirect = await fetchAndVerifyMacInstallerRedirect(ctx);
              ctx.output("mac-desktop-download-redirect", JSON.stringify(state.frame3DownloadRedirect, null, 2));
            },
            assert: async () => {
              const redirect = requireRedirectWitness(state.frame3DownloadRedirect);
              witness(ctx, redirect.status === 302, "The macOS desktop download returns a redirect instead of mutating the artifact", redirect);
              witness(ctx, redirect.location === redirect.expectedLocation, "The redirect Location is the exact standard macOS desktop release asset", redirect);
              await ctx.expectText("Download OpenWork for Acme Robotics");
              await ctx.expectText("Open the installer and paste this link:");
            },
            screenshot: {
              name: "standard-desktop-download-redirect",
              requireText: ["Download OpenWork for Acme Robotics", "Open the installer and paste this link:", "Waiting for sign-in"],
            },
          });
        }, { targetId: state.installPageTargetId });
      },
    },
    {
      name: "Frame 4",
      run: async (ctx) => {
        useDesktopClient(ctx);
        await ctx.prove("A plain first-run desktop asks whether to use OpenWork Cloud or join an organization, and pasting Acme's link binds it to Acme's server", {
          voiceover: vo[3],
          // "Suppose someone skips all that and installs the plain OpenWork app instead: "
          action: async () => {
            await ensureDesktopReady(ctx);
            await captureOriginalDesktopBootstrap(ctx);
            await resetDesktopToDefaultBootstrap(ctx);
            await ctx.eval(`(() => {
              const raw = localStorage.getItem('openwork.preferences');
              const prefs = raw ? JSON.parse(raw) : {};
              prefs.hasCompletedOnboarding = false;
              localStorage.setItem('openwork.preferences', JSON.stringify(prefs));
              location.hash = '#/welcome';
              location.reload();
              return true;
            })()`);
            await ensureDesktopReady(ctx);
            await ctx.waitForText("Use OpenWork Cloud", { timeoutMs: 45_000 });
            await ctx.waitFor("Boolean(document.querySelector('[data-testid=\"welcome-join-org\"]'))", {
              timeoutMs: 30_000,
              label: "welcome join organization fork",
            });
            await ctx.expectText("Use OpenWork Cloud");
            await ctx.expectText("Join your organization");
            await clickSelector(ctx, '[data-testid="welcome-join-org"]', "join organization fork");
            await ctx.waitForText("Join your organization", { timeoutMs: 20_000 });
            await ctx.fill("#join-organization-input", requireStateValue(state.installPageUrl, "install page URL"));
            await clickExactText(ctx, "Connect", "button");
            await ctx.waitForText(`Connected to ${new URL(state.installConfig.webUrl).host}`, { timeoutMs: 30_000 });
            await ctx.waitForText("Sign in to OpenWork", { timeoutMs: 60_000 });
          },
          assert: async () => {
            await ctx.expectText("Sign in to OpenWork");
            const bootstrap = await invokeDesktop(ctx, "getDesktopBootstrapConfig");
            witness(ctx, bootstrap?.requireSignin === true, "Pasting the install link writes a required sign-in bootstrap", bootstrap);
            witness(ctx, cleanBaseUrl(bootstrap?.baseUrl) === cleanBaseUrl(state.installConfig.webUrl), "The desktop bootstrap points at Acme's web server", bootstrap);
            const serverHost = new URL(state.installConfig.webUrl).host;
            const serverText = await ctx.eval("document.body.innerText");
            witness(ctx, String(serverText).includes(serverHost), "The forced sign-in surface shows Acme's organization server", serverText);
            ctx.output("desktop-bootstrap-after-welcome-paste", JSON.stringify(bootstrap, null, 2));
            await ctx.screenshot("plain-desktop-join-org-paste-forced-signin", {
              claim: "A plain first-run desktop asks whether to use OpenWork Cloud or join an organization, and pasting Acme's link binds it to Acme's server.",
              voiceover: vo[4],
              requireText: ["Welcome to OpenWork", "Sign in to OpenWork", `Connected to ${serverHost}`],
              rejectText: ["Pick a folder"],
            });
          },
        });
      },
    },
    {
      name: "Frame 5",
      run: async (ctx) => {
        useDesktopClient(ctx);
        await ctx.prove("Desktop sign-in completes through Acme's browser handoff, while a later sign-in link for another server asks before switching", {
          voiceover: vo[4],
          // "The desktop opens sign-in for Acme Robotics with the browser handling the ha"
          action: async () => {
            await ensureDesktopReady(ctx);
            await ctx.waitForText("Sign in to OpenWork", { timeoutMs: 60_000 });
            await stubDesktopExternalOpenCapture(ctx);
            await clickExactText(ctx, "Sign in to OpenWork", "button");
            state.browserSignInUrl = await ctx.waitFor(
              `(() => {
                const captured = typeof window.__capturedBrowserSigninUrl === 'string'
                  ? window.__capturedBrowserSigninUrl
                  : '';
                if (captured.includes('desktopAuth=1')) return captured;
                return Array.from(document.querySelectorAll('a[href*="desktopAuth=1"]'))
                  .map((link) => link.href)
                  .find(Boolean) || '';
              })()`,
              { timeoutMs: 20_000, label: "captured or visible desktop browser sign-in URL" },
            );

            await ensureMemberAccount(ctx);
            state.authTargetId = state.authTargetId ?? (await newPageTarget(INVITEE_CDP_URL)).id;
            await withClient(ctx, INVITEE_CDP_URL, async () => {
              await clearDenWebSession(ctx);
              await navigateToAbsolute(ctx, requireStateValue(state.browserSignInUrl, "browser sign-in URL"));
              await signInOnCurrentDenWebPage(ctx, MEMBER_EMAIL, MEMBER_PASSWORD, { captureDesktopHandoff: true });
              state.copiedDesktopUrl = await ctx.waitFor(
                "typeof window.__capturedSignin === 'string' && window.__capturedSignin.startsWith('openwork://den-auth') && window.__capturedSignin",
                { timeoutMs: 45_000, label: "captured browser-minted OpenWork sign-in link" },
              );
              state.copiedDesktopGrant = new URL(state.copiedDesktopUrl).searchParams.get("grant") ?? "";
              witness(ctx, state.copiedDesktopGrant.length > 0, "The browser-minted OpenWork URL carries a handoff grant", redactUrlParam(state.copiedDesktopUrl, "grant"));
            }, { targetId: state.authTargetId });

            useDesktopClient(ctx);
            await deliverDeepLinkToDesktop(ctx, requireStateValue(state.copiedDesktopUrl, "browser-minted OpenWork sign-in URL"));
            await ctx.waitFor("(localStorage.getItem('openwork.den.activeOrgName') ?? '').includes('Acme Robotics')", {
              timeoutMs: 60_000,
              label: "desktop signed into Acme",
            });
            await completeDesktopSignedInJourney(ctx);

            const beforeMismatchBootstrap = await invokeDesktop(ctx, "getDesktopBootstrapConfig");
            const mismatchUrl = buildMismatchedDenAuthUrl();
            await deliverDeepLinkToDesktop(ctx, mismatchUrl);
            await ctx.waitForText("Switch organization server?", { timeoutMs: 20_000 });
            state.beforeMismatchBootstrap = beforeMismatchBootstrap;
          },
          assert: async () => {
            await ctx.expectText("Switch organization server?");
            await ctx.expectText("other-server.example");
            await ctx.expectText("Cancel");
            await ctx.expectText("Switch & sign in");
            const bootstrapWhilePrompted = await invokeDesktop(ctx, "getDesktopBootstrapConfig");
            witness(ctx, cleanBaseUrl(bootstrapWhilePrompted?.baseUrl) === cleanBaseUrl(state.installConfig.webUrl), "The mismatched link prompts before changing the Acme bootstrap", bootstrapWhilePrompted);
            await ctx.screenshot("desktop-server-switch-confirmation", {
              claim: "A mismatched sign-in link asks before switching organization servers.",
              voiceover: vo[5],
              requireText: ["Switch organization server?", "other-server.example", "Cancel"],
            });
            await clickExactText(ctx, "Cancel", "button");
            await ctx.waitFor("!document.body.innerText.includes('Switch organization server?')", {
              timeoutMs: 10_000,
              label: "server switch dialog dismissed",
            });
            const afterMismatchBootstrap = await invokeDesktop(ctx, "getDesktopBootstrapConfig");
            witness(ctx, cleanBaseUrl(afterMismatchBootstrap?.baseUrl) === cleanBaseUrl(state.installConfig.webUrl), "Cancel leaves the desktop bootstrap on Acme's server", afterMismatchBootstrap);
            witness(ctx, (await ctx.eval("localStorage.getItem('openwork.den.activeOrgName') ?? ''")).includes("Acme Robotics"), "Cancel leaves the active organization as Acme Robotics", await ctx.eval("localStorage.getItem('openwork.den.activeOrgName') ?? ''"));
            ctx.output("desktop-signin-and-mismatch-guard", JSON.stringify({
              browserSignInUrl: state.browserSignInUrl,
              copiedDesktopUrl: redactUrlParam(state.copiedDesktopUrl, "grant"),
              beforeMismatchBootstrap: state.beforeMismatchBootstrap,
              afterMismatchBootstrap,
            }, null, 2));
          },
          screenshot: {
            name: "desktop-stays-on-acme-after-cancel",
            requireText: ["OpenWork Cloud", "Acme Robotics", "Sign out"],
            rejectText: ["Switch organization server?", "Something went wrong"],
          },
        });
      },
    },
    {
      name: "Frame 6",
      run: async (ctx) => {
        await withClient(ctx, INVITEE_CDP_URL, async () => {
          await ctx.prove("The browser handoff and original install page both flip to Connected for Acme Robotics", {
            voiceover: vo[5],
            // "Back on the install page, step three flips to Connected — OpenWork is set up"
            action: async () => {
              await withClient(ctx, INVITEE_CDP_URL, async () => {
                await ctx.waitFor("Boolean(document.querySelector('[data-testid=\"desktop-connected\"]'))", {
                  timeoutMs: 60_000,
                  label: "browser handoff connected state",
                });
                await ctx.waitForText("Connected", { timeoutMs: 10_000 });
              }, { targetId: state.authTargetId });

              await waitForInstallPageConnected(ctx);
            },
            assert: async () => {
              await ctx.expectText("Connected");
              await ctx.expectText("OpenWork is set up for Acme Robotics");
              const connected = await ctx.eval("document.querySelector('[data-testid=\"install-connected\"]')?.textContent ?? ''");
              witness(ctx, String(connected).includes("Connected") && String(connected).includes("Acme Robotics"), "Step three on the install page reports Connected for Acme Robotics", connected);
              ctx.output("desktop-handoff-status", JSON.stringify({ grant: state.copiedDesktopGrant ? "[captured]" : "", installPageReloaded: state.usedInstallPageReload }, null, 2));
            },
            screenshot: {
              name: "install-page-connected-to-acme",
              requireText: ["Download the OpenWork installer", "Open the installer and paste this link:", "Connected", "OpenWork is set up for Acme Robotics"],
            },
          });
        }, { targetId: state.installPageTargetId });
      },
    },
  ],
};

function cleanBaseUrl(value) {
  return (value ?? "").trim().replace(/\/+$/, "");
}

function witness(ctx, condition, assertion, actual) {
  ctx.recordEvidence({
    type: "assertion",
    status: condition ? "passed" : "failed",
    assertion,
    actual: actual === undefined ? undefined : typeof actual === "string" ? actual.slice(0, 900) : JSON.stringify(actual).slice(0, 900),
  });
  ctx.assert(condition, assertion + (actual === undefined ? "" : ` (actual: ${JSON.stringify(actual).slice(0, 500)})`));
}

function rememberDesktopClient(ctx) {
  if (!state.desktopClient) {
    state.desktopClient = ctx.client;
  }
}

function useDesktopClient(ctx) {
  rememberDesktopClient(ctx);
  ctx.client = state.desktopClient;
}

function requireStateValue(value, label) {
  if (typeof value === "string" && value.trim()) {
    return value;
  }
  throw new Error(`${label} was not prepared by an earlier frame.`);
}

function requireRedirectWitness(value) {
  if (value && typeof value === "object" && typeof value.status === "number" && typeof value.location === "string" && typeof value.expectedLocation === "string") {
    return value;
  }
  throw new Error("Installer redirect witness was not prepared.");
}

async function withClient(ctx, cdpBaseUrl, fn, options = {}) {
  const previous = ctx.client;
  const target = options.targetId
    ? await targetById(cdpBaseUrl, options.targetId)
    : options.newPage
      ? await newPageTarget(cdpBaseUrl)
      : await firstPageTarget(cdpBaseUrl);
  const client = await connect(debuggerUrlFor(cdpBaseUrl, target));
  await client.send("Page.enable").catch(() => undefined);
  await activateTarget(cdpBaseUrl, target.id);
  ctx.client = client;
  try {
    return await fn();
  } finally {
    ctx.client = previous;
    try {
      client.close();
    } catch {
      // Socket already gone.
    }
  }
}

async function firstPageTarget(cdpBaseUrl) {
  const existing = await listTargets(cdpBaseUrl);
  const page = existing.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
  if (page) return page;
  return newPageTarget(cdpBaseUrl);
}

async function targetById(cdpBaseUrl, targetId) {
  const targets = await listTargets(cdpBaseUrl);
  const target = targets.find((entry) => entry.id === targetId && entry.type === "page" && entry.webSocketDebuggerUrl);
  if (!target) {
    throw new Error(`No page target ${targetId} available at ${cdpBaseUrl}.`);
  }
  return target;
}

async function newPageTarget(cdpBaseUrl, url = "about:blank") {
  const base = cdpBaseUrl.replace(/\/+$/, "");
  let response = await fetch(`${base}/json/new?${encodeURIComponent(url)}`, { method: "PUT" });
  if (!response.ok) {
    response = await fetch(`${base}/json/new?${encodeURIComponent(url)}`);
  }
  if (!response.ok) {
    throw new Error(`Could not create a page target at ${cdpBaseUrl}: ${response.status}`);
  }
  const created = await response.json();
  if (created?.type === "page" && created.webSocketDebuggerUrl) {
    return created;
  }
  const targets = await listTargets(cdpBaseUrl);
  const nextPage = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
  if (!nextPage) {
    throw new Error(`No page target available at ${cdpBaseUrl}.`);
  }
  return nextPage;
}

async function activateTarget(cdpBaseUrl, targetId) {
  if (!targetId) return;
  const base = cdpBaseUrl.replace(/\/+$/, "");
  await fetch(`${base}/json/activate/${encodeURIComponent(targetId)}`).catch(() => undefined);
}

async function closeTarget(cdpBaseUrl, targetId) {
  if (!targetId) return;
  const base = cdpBaseUrl.replace(/\/+$/, "");
  await fetch(`${base}/json/close/${encodeURIComponent(targetId)}`).catch(() => undefined);
}

async function denApiFetch(pathname, options = {}) {
  const response = await fetch(`${DEN_API_URL}${pathname}`, {
    ...options,
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      origin: DEN_WEB_URL || DEN_API_URL,
      ...(options.headers ?? {}),
    },
  });
  const text = await response.text();
  let body = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { response, body, text };
}

async function ensureAdminToken(ctx) {
  if (state.adminToken) return state.adminToken;
  const signedIn = await denApiFetch("/api/auth/sign-in/email", {
    method: "POST",
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  });
  if (signedIn.response.ok && typeof signedIn.body?.token === "string") {
    state.adminToken = signedIn.body.token;
    return state.adminToken;
  }
  const token = process.env.OPENWORK_EVAL_DEN_TOKEN?.trim() ?? "";
  ctx.assert(token.length > 0, `Admin sign-in failed and OPENWORK_EVAL_DEN_TOKEN is missing: ${signedIn.response.status}`);
  state.adminToken = token;
  return token;
}

async function ensureOrgId(ctx) {
  if (state.orgId) return state.orgId;
  const token = await ensureAdminToken(ctx);
  const org = await denApiFetch("/v1/org", {
    method: "GET",
    headers: { authorization: `Bearer ${token}` },
  });
  ctx.assert(org.response.ok, `Could not load ${ADMIN_EMAIL}'s organization: ${org.response.status} ${org.text.slice(0, 300)}`);
  const organization = org.body?.organization;
  ctx.assert(typeof organization?.id === "string", "Organization payload was missing id.");
  state.orgId = organization.id;
  return state.orgId;
}

async function mintInstallLink(ctx, { rotate = false } = {}) {
  const token = await ensureAdminToken(ctx);
  const orgId = await ensureOrgId(ctx);
  const result = await denApiFetch(`/v1/orgs/${orgId}/install-links`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ rotate }),
  });
  ctx.assert(result.response.ok, `Install-link mint failed: ${result.response.status} ${result.text.slice(0, 300)}`);
  ctx.assert(typeof result.body?.installPageUrl === "string", "Install-link mint did not return installPageUrl.");
  ctx.assert(typeof result.body?.token === "string", "Install-link mint did not return token.");
  return { installPageUrl: result.body.installPageUrl, token: result.body.token };
}

async function createInvitation(ctx, email) {
  const token = await ensureAdminToken(ctx);
  const invitation = await denApiFetch("/v1/invitations", {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ email, role: "member" }),
  });
  ctx.assert(
    invitation.response.ok,
    `Invitation failed for ${email}: ${invitation.response.status} ${JSON.stringify(invitation.body).slice(0, 300)}`,
  );
  ctx.assert(typeof invitation.body?.invitationId === "string", `Invitation response for ${email} did not include invitationId.`);
  return invitation.body;
}

async function ensureMemberAccount(ctx) {
  if (state.memberSetup) return state.memberSetup;

  const invitation = await createInvitation(ctx, MEMBER_EMAIL);
  const signup = await denApiFetch("/api/auth/sign-up/email", {
    method: "POST",
    body: JSON.stringify({ name: "Riley First Connection", email: MEMBER_EMAIL, password: MEMBER_PASSWORD }),
  });
  const signupAccepted = signup.response.ok || [400, 403, 409, 422].includes(signup.response.status);
  ctx.assert(signupAccepted, `Sign-up failed for ${MEMBER_EMAIL}: ${signup.response.status} ${signup.text.slice(0, 300)}`);
  markEmailVerified(ctx, MEMBER_EMAIL);

  const signedIn = await denApiFetch("/api/auth/sign-in/email", {
    method: "POST",
    body: JSON.stringify({ email: MEMBER_EMAIL, password: MEMBER_PASSWORD }),
  });
  ctx.assert(
    signedIn.response.ok && typeof signedIn.body?.token === "string",
    `Member sign-in failed for ${MEMBER_EMAIL}: ${signedIn.response.status} ${signedIn.text.slice(0, 300)}`,
  );

  const accepted = await denApiFetch("/v1/orgs/invitations/accept", {
    method: "POST",
    headers: { authorization: `Bearer ${signedIn.body.token}` },
    body: JSON.stringify({ id: invitation.invitationId }),
  });
  ctx.assert(
    accepted.response.ok,
    `Invitation accept failed for ${MEMBER_EMAIL}: ${accepted.response.status} ${accepted.text.slice(0, 300)}`,
  );

  state.memberSetup = {
    email: MEMBER_EMAIL,
    invitationId: invitation.invitationId,
    signupStatus: signup.response.status,
    acceptStatus: accepted.response.status,
    organizationSlug: accepted.body?.organizationSlug ?? null,
  };
  ctx.output("teammate-account-setup", JSON.stringify(state.memberSetup, null, 2));
  return state.memberSetup;
}

function markEmailVerified(ctx, email) {
  ctx.assert(
    MARK_VERIFIED_CMD.length > 0,
    "Invitation acceptance requires a verified email; set OPENWORK_EVAL_MARK_VERIFIED_CMD (shell template with {email}).",
  );
  execSync(MARK_VERIFIED_CMD.replaceAll("{email}", email), { stdio: "ignore" });
}

async function fetchInstallConfig(ctx, token) {
  const configResult = await denApiFetch(`/v1/install-config?token=${encodeURIComponent(token)}`, { method: "GET" });
  ctx.assert(configResult.response.ok, `Install config fetch failed: ${configResult.response.status} ${configResult.text.slice(0, 300)}`);
  ctx.assert(isRecord(configResult.body), "Install config response was not a JSON object.");
  return configResult.body;
}

async function goToDenWeb(ctx, pathname) {
  await navigateToAbsolute(ctx, `${DEN_WEB_URL}${pathname}`);
  await ctx.waitFor("document.readyState === 'complete'", { timeoutMs: 30_000, label: `load ${pathname}` });
}

async function navigateToAbsolute(ctx, url) {
  await ctx.eval(`(() => { location.assign(${JSON.stringify(url)}); return true; })()`);
  await ctx.waitFor("document.readyState === 'complete'", { timeoutMs: 45_000, label: `load ${url}` });
}

async function signInToDenWeb(ctx, email, password) {
  await clearDenWebSession(ctx);
  await goToDenWeb(ctx, "/");
  await signInOnCurrentDenWebPage(ctx, email, password);
  await ctx.waitFor("location.pathname.startsWith('/dashboard')", { timeoutMs: 45_000, label: "dashboard after sign-in" });
}

async function signInOnCurrentDenWebPage(ctx, email, password, { captureDesktopHandoff = false } = {}) {
  await ctx.waitFor(
    `document.body.innerText.includes('Sign in')
      || document.body.innerText.includes('Start using OpenWork')
      || Boolean(document.querySelector('input[type="email"], input[name="email"]'))`,
    { timeoutMs: 45_000, label: "sign-in screen" },
  );
  const hasInitialAuthInput = await ctx.eval(
    `Boolean(document.querySelector('input[type="email"], input[name="email"]'))
      || Boolean(document.querySelector('input[type="password"]'))`,
  );
  if (!hasInitialAuthInput) {
    await clickTextIfPresent(ctx, "Sign in", "button, a");
  }
  await ctx.waitFor(
    `Boolean(document.querySelector('input[type="email"], input[name="email"]'))
      || Boolean(document.querySelector('input[type="password"]'))`,
    { timeoutMs: 30_000, label: "auth input" },
  );
  const hasEmailInput = await ctx.eval("Boolean(document.querySelector('input[type=\"email\"], input[name=\"email\"]'))");
  const hasPasswordInput = await ctx.eval("Boolean(document.querySelector('input[type=\"password\"]'))");
  if (hasEmailInput) {
    await ctx.fill('input[type="email"], input[name="email"]', email);
  }
  if (hasEmailInput && !hasPasswordInput) {
    await clickLastExactText(ctx, "Next", "button");
    await ctx.waitFor("Boolean(document.querySelector('input[type=\"password\"]'))", { timeoutMs: 30_000, label: "password input" });
  }
  await ctx.fill('input[type="password"]', password);
  if (captureDesktopHandoff) {
    await stubDesktopHandoffFetchCapture(ctx);
  }
  await clickLastExactText(ctx, "Sign in", "button");
  if (captureDesktopHandoff) {
    await ctx.waitFor(
      "typeof window.__capturedSignin === 'string' && window.__capturedSignin.startsWith('openwork://den-auth')",
      { timeoutMs: 45_000, label: "desktop handoff URL captured" },
    );
  }
}

async function clearDenWebSession(ctx) {
  await goToDenWeb(ctx, "/");
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
  await ctx.client.send("Network.clearBrowserCookies", {});
}

async function clickTextIfPresent(ctx, text, selector) {
  await ctx.eval(`(() => {
    const candidates = [...document.querySelectorAll(${JSON.stringify(selector)})];
    const element = candidates.find((candidate) => (candidate.textContent ?? '').trim() === ${JSON.stringify(text)} && !candidate.disabled);
    element?.scrollIntoView({ block: 'center' });
    element?.click();
    return true;
  })()`);
}

async function clickExactText(ctx, text, selector) {
  return ctx.waitFor(`(() => {
    const candidates = [...document.querySelectorAll(${JSON.stringify(selector)})];
    const element = candidates.find((candidate) => (candidate.textContent ?? '').replace(/\\s+/g, ' ').trim() === ${JSON.stringify(text)} && !candidate.disabled);
    element?.scrollIntoView({ block: 'center' });
    element?.click();
    return Boolean(element);
  })()`, { timeoutMs: 20_000, label: `click exact text ${text}` });
}

async function clickLastExactText(ctx, text, selector) {
  return ctx.waitFor(`(() => {
    const candidates = [...document.querySelectorAll(${JSON.stringify(selector)})]
      .filter((candidate) => (candidate.textContent ?? '').replace(/\\s+/g, ' ').trim() === ${JSON.stringify(text)} && !candidate.disabled);
    const element = candidates[candidates.length - 1];
    element?.scrollIntoView({ block: 'center' });
    element?.click();
    return Boolean(element);
  })()`, { timeoutMs: 20_000, label: `click last exact text ${text}` });
}

async function clickSelector(ctx, selector, label) {
  await ctx.waitFor(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (element instanceof HTMLButtonElement && element.disabled) return false;
    element?.scrollIntoView({ block: 'center' });
    element?.click();
    return Boolean(element);
  })()`, { timeoutMs: 20_000, label });
}

async function hasText(ctx, text) {
  return Boolean(await ctx.eval(`document.body.innerText.includes(${JSON.stringify(text)})`));
}

async function stubInstallLinkClipboardCapture(ctx) {
  await ctx.eval(`(() => {
    window.__capturedInstallLink = '';
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText(value) {
          window.__capturedInstallLink = String(value);
          return Promise.resolve();
        },
      },
    });
    return true;
  })()`);
}

async function stubDesktopHandoffFetchCapture(ctx) {
  await ctx.eval(`(() => {
    window.__capturedSignin = '';
    window.__capturedSigninPayload = null;
    window.__locationAssignPatchError = '';
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (...args) => {
      const response = await originalFetch(...args);
      const input = args[0];
      const requestUrl = typeof input === 'string' ? input : input?.url ?? String(input);
      if (requestUrl.includes('/v1/auth/desktop-handoff')) {
        try {
          const payload = await response.clone().json();
          window.__capturedSigninPayload = payload;
          if (typeof payload?.openworkUrl === 'string') window.__capturedSignin = payload.openworkUrl;
        } catch {}
      }
      return response;
    };
    try {
      const originalAssign = window.location.assign.bind(window.location);
      Object.defineProperty(window.location, 'assign', {
        configurable: true,
        value(url) {
          if (String(url).startsWith('openwork://')) {
            window.__capturedSignin = String(url);
            return undefined;
          }
          return originalAssign(url);
        },
      });
    } catch (error) {
      window.__locationAssignPatchError = error instanceof Error ? error.message : String(error);
    }
    return true;
  })()`);
}

async function ensureDesktopReady(ctx) {
  await ctx.waitFor("Boolean(window.__openworkControl)", { timeoutMs: 60_000, label: "desktop control API" });
  await ctx.waitFor("Boolean(window.__OPENWORK_ELECTRON__?.invokeDesktop)", { timeoutMs: 60_000, label: "desktop bridge" });
}

async function invokeDesktop(ctx, command, input) {
  await ensureDesktopReady(ctx);
  return ctx.eval(`window.__OPENWORK_ELECTRON__.invokeDesktop(${JSON.stringify(command)}, ${JSON.stringify(input ?? null)})`, { awaitPromise: true });
}

async function captureOriginalDesktopBootstrap(ctx) {
  if (state.originalDesktopBootstrapConfig) return;
  state.originalDesktopBootstrapConfig = await invokeDesktop(ctx, "getDesktopBootstrapConfig");
}

async function resetDesktopToDefaultBootstrap(ctx) {
  await invokeDesktop(ctx, "clearDesktopBootstrapConfig");
  await resetDesktopDenSession(ctx);
  await ctx.eval("location.reload(); true");
  await ensureDesktopReady(ctx);
  const bootstrap = await invokeDesktop(ctx, "getDesktopBootstrapConfig");
  witness(ctx, bootstrap?.fromFile === false, "The plain desktop run starts with default bootstrap settings, not an organization file", bootstrap);
}

async function resetDesktopDenSession(ctx) {
  await ctx.eval(`(() => {
    document.querySelector('[role="alertdialog"] button')?.click();
    for (const key of [
      'openwork.den.authToken',
      'openwork.den.activeOrgId',
      'openwork.den.activeOrgSlug',
      'openwork.den.activeOrgName',
    ]) {
      localStorage.removeItem(key);
    }
    window.dispatchEvent(new CustomEvent('openwork-den-session-updated', { detail: { status: 'signed_out' } }));
    return true;
  })()`);
}

async function stubDesktopExternalOpenCapture(ctx) {
  await ctx.eval(`(() => {
    window.__capturedBrowserSigninUrl = '';
    window.__OPENWORK_ELECTRON__ = window.__OPENWORK_ELECTRON__ || {};
    window.__OPENWORK_ELECTRON__.shell = window.__OPENWORK_ELECTRON__.shell || {};
    window.__OPENWORK_ELECTRON__.shell.openExternal = async (url) => {
      window.__capturedBrowserSigninUrl = String(url);
      return { ok: true };
    };
    return true;
  })()`);
}

async function deliverDeepLinkToDesktop(ctx, openworkUrl) {
  await ctx.eval(`(() => {
    const url = ${JSON.stringify(openworkUrl)};
    window.__OPENWORK__ = window.__OPENWORK__ || {};
    const pending = window.__OPENWORK__.deepLinks || [];
    window.__OPENWORK__.deepLinks = [...pending, url];
    window.dispatchEvent(new CustomEvent('openwork:deep-link-native', { detail: [url] }));
    window.dispatchEvent(new CustomEvent('openwork:deep-link', { detail: { urls: [url] } }));
    return true;
  })()`);
}

async function completeDesktopSignedInJourney(ctx) {
  await ctx.waitFor(
    `document.body.innerText.includes("Choose your organization")
      || document.body.innerText.includes("You have access to the following resources.")
      || document.body.innerText.includes("No resources have been configured for this organization yet.")
      || location.hash.includes('/session')
      || location.hash.includes('/workspace/')
      || document.body.innerText.includes("OpenWork Cloud")`,
    { timeoutMs: 60_000, label: "post-sign-in desktop surface" },
  );

  if (await hasText(ctx, "Choose your organization")) {
    await ctx.expectText("Acme Robotics");
    await clickExactText(ctx, "Continue with organization", "button");
    await ctx.waitFor(
      `document.body.innerText.includes("You have access to the following resources.")
        || document.body.innerText.includes("No resources have been configured for this organization yet.")`,
      { timeoutMs: 45_000, label: "organization resources step" },
    );
  }

  if (await hasText(ctx, "You have access to the following resources.")) {
    await clickExactText(ctx, "Continue to workspace", "button");
    await ctx.waitFor("location.hash.includes('/session') || location.hash.includes('/workspace/')", { timeoutMs: 45_000, label: "workspace route" });
  } else if (await hasText(ctx, "No resources have been configured for this organization yet.")) {
    await clickExactText(ctx, "Continue", "button");
    await ctx.waitFor("location.hash.includes('/session') || location.hash.includes('/workspace/')", { timeoutMs: 45_000, label: "workspace route" });
  }

  await ctx.navigateHash("/settings/cloud-account");
  await ctx.waitForText("OpenWork Cloud", { timeoutMs: 45_000 });
  await ctx.waitForText("Sign out", { timeoutMs: 45_000 });
  await ctx.expectText("Acme Robotics", { timeoutMs: 45_000 });
  await ctx.expectText(MEMBER_EMAIL, { timeoutMs: 45_000 });
}

function extractInstallToken(installLink, ctx) {
  const parsed = new URL(installLink);
  const token = parsed.searchParams.get("token")?.trim() ?? "";
  ctx.assert(token.length > 0, `Install link did not include a token: ${installLink}`);
  return token;
}

function installPageUrlForBrowser(installLink) {
  const parsed = new URL(installLink, DEN_WEB_URL);
  const web = new URL(DEN_WEB_URL);
  if (parsed.origin === web.origin) return parsed.toString();
  return new URL(`${parsed.pathname}${parsed.search}${parsed.hash}`, DEN_WEB_URL).toString();
}

async function fetchLatestSupportedAppVersion(ctx) {
  const version = await denApiFetch("/v1/app-version", { method: "GET" });
  ctx.assert(version.response.ok, `App-version fetch failed: ${version.response.status} ${version.text.slice(0, 300)}`);
  const latestAppVersion = typeof version.body?.latestAppVersion === "string" ? version.body.latestAppVersion.trim() : "";
  ctx.assert(latestAppVersion.length > 0, `App-version response did not include latestAppVersion: ${version.text.slice(0, 300)}`);
  return latestAppVersion;
}

function compareVersion(left, right) {
  const leftParts = left.split(".").map((part) => Number.parseInt(part, 10));
  const rightParts = right.split(".").map((part) => Number.parseInt(part, 10));
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftParts[index] || 0) - (rightParts[index] || 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

async function expectedInstallerReleaseTag(ctx) {
  const token = await ensureAdminToken(ctx);
  const org = await denApiFetch("/v1/org", {
    method: "GET",
    headers: { authorization: `Bearer ${token}` },
  });
  ctx.assert(org.response.ok, `Organization fetch failed: ${org.response.status} ${org.text.slice(0, 300)}`);
  const versions = org.body?.organization?.metadata?.allowedDesktopVersions;
  if (Array.isArray(versions)) {
    const allowed = versions
      .filter((version) => typeof version === "string" && version.trim())
      .map((version) => version.trim())
      .sort(compareVersion);
    const maxAllowed = allowed.at(-1);
    if (maxAllowed) return `v${maxAllowed}`;
  }
  return `v${await fetchLatestSupportedAppVersion(ctx)}`;
}

async function fetchAndVerifyMacInstallerRedirect(ctx) {
  const token = requireStateValue(state.installToken, "install token");
  const downloadUrl = `${DEN_API_URL}/v1/install/mac-arm64?token=${encodeURIComponent(token)}`;
  const response = await fetch(downloadUrl, {
    headers: { accept: "application/x-apple-diskimage" },
    redirect: "manual",
  });
  const location = response.headers.get("location") ?? "";
  const releaseTag = await expectedInstallerReleaseTag(ctx);
  const version = releaseTag.startsWith("v") ? releaseTag.slice(1) : releaseTag;
  const fileName = `openwork-mac-arm64-${version}.dmg`;
  const expectedLocation = `https://github.com/different-ai/openwork/releases/download/${encodeURIComponent(releaseTag)}/${encodeURIComponent(fileName)}`;
  const parsedLocation = location ? new URL(location) : null;

  return {
    downloadUrl,
    status: response.status,
    location,
    expectedLocation,
    releaseTag,
    fileName,
    githubReleaseAsset: parsedLocation
      ? {
          host: parsedLocation.host,
          pathname: parsedLocation.pathname,
        }
      : null,
  };
}

function readBootstrapConfig(ctx, bootstrapPath) {
  ctx.assert(existsSync(bootstrapPath), `Desktop bootstrap file does not exist: ${bootstrapPath}`);
  const raw = readFileSync(bootstrapPath, "utf8");
  const parsed = JSON.parse(raw);
  ctx.assert(isRecord(parsed), `Desktop bootstrap file was not a JSON object: ${bootstrapPath}`);
  return { raw, parsed };
}

function buildMismatchedDenAuthUrl() {
  const url = new URL("openwork://den-auth");
  url.searchParams.set("grant", `bogus-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);
  url.searchParams.set("denBaseUrl", "https://other-server.example/api/den");
  return url.toString();
}

async function waitForInstallPageConnected(ctx) {
  try {
    await ctx.waitFor("Boolean(document.querySelector('[data-testid=\"install-connected\"]'))", {
      timeoutMs: 30_000,
      label: "install page live connected state",
    });
    return;
  } catch (error) {
    state.usedInstallPageReload = true;
    ctx.output("install-page-connected-reload", `Live storage/polling did not flip before timeout (${error instanceof Error ? error.message : String(error)}). Reloading the still-open install tab to re-read the handoff grant from localStorage.`);
    await ctx.eval("location.reload(); true");
    await ctx.waitFor("Boolean(document.querySelector('[data-testid=\"install-connected\"]'))", {
      timeoutMs: 45_000,
      label: "install page connected state after reload",
    });
  }
}

function makeTempDir(prefix) {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

function redactUrlParam(rawUrl, param) {
  try {
    const url = new URL(rawUrl);
    if (url.searchParams.has(param)) {
      url.searchParams.set(param, "[redacted]");
    }
    return url.toString();
  } catch {
    return "invalid URL";
  }
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
