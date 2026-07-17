import { execSync } from "node:child_process";
import { connect, debuggerUrlFor, listTargets } from "../runner/cdp.mjs";
import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";
import { denApiFetch, denApiUrl, denWebUrl } from "./lib/den-web.mjs";

// Narration is loaded from the approved script (evals/voiceovers/org-download-handoff.md).
// The runner fails this flow if the narration drifts from that script.
const vo = await loadVoiceoverParagraphs("org-download-handoff");

const FLOW_ID = "org-download-handoff";
const DEN_API_URL = denApiUrl();
const DEN_WEB_URL = denWebUrl();
const INVITEE_CDP_URL = cleanBaseUrl(process.env.OPENWORK_EVAL_WEB_CDP_INVITEE);
const DEN_TOKEN = process.env.OPENWORK_EVAL_DEN_TOKEN?.trim() || "";
const MARK_VERIFIED_CMD = process.env.OPENWORK_EVAL_MARK_VERIFIED_CMD?.trim() || "";
const RUN_TAG = Date.now().toString(36);
const MEMBER_EMAIL = `maya-download-${RUN_TAG}@acme.test`;
const MEMBER_PASSWORD = "OpenWorkDemo123!";
const ORG_NAME = "Acme Robotics";

const state = {
  desktopClient: null,
  originalDesktopBootstrapConfig: null,
  memberEmail: MEMBER_EMAIL,
  memberPassword: MEMBER_PASSWORD,
  memberBearer: "",
  inviteLink: "",
  inviteToken: "",
  invitationId: "",
  installToken: "",
  installPageUrl: "",
  connectUrl: "",
  recoveryConnectUrl: "",
  serverHost: "",
};

export default {
  id: FLOW_ID,
  title: "An invited member gets Acme's guided install, connects the app, signs in, and has a copy-link recovery",
  kind: "user-facing",
  requiredEnv: [
    "OPENWORK_EVAL_DEN_API_URL",
    "OPENWORK_EVAL_DEN_TOKEN",
    "OPENWORK_EVAL_DEN_WEB_URL",
    "OPENWORK_EVAL_WEB_CDP_INVITEE",
    "OPENWORK_EVAL_MARK_VERIFIED_CMD",
  ],
  steps: [
    {
      name: "Frame 1",
      run: async (ctx) => {
        rememberDesktop(ctx);
        await withWeb(ctx, async () => ctx.prove("Maya joins Acme and sees one clear desktop-app next step", {
          voiceover: vo[0],
          action: async () => {
            await createInvitation(ctx);
            if (state.inviteToken) {
              state.inviteLink = new URL(`/join-org?invite=${encodeURIComponent(state.inviteToken)}`, DEN_WEB_URL).toString();
            } else {
              const { html } = await getLatestInviteEmail(ctx);
              const invite = extractInviteFromHtml(html, ctx);
              state.inviteToken = invite.token;
              state.inviteLink = rewriteInviteLink(invite.link);
            }
            await clearDenWebSession(ctx);
            await navigateToAbsolute(ctx, requireStateValue(state.inviteLink, "invite link"));
            await completeInviteSignup(ctx);
          },
          assert: async () => {
            await ctx.waitFor("Boolean(document.querySelector('[data-testid=join-org-success]'))", { timeoutMs: 45_000, label: "join-org success" });
            await ctx.expectText("You're in, welcome to Acme Robotics");
            const ctaText = await ctx.eval("document.querySelector('[data-testid=join-org-get-app]')?.textContent?.replace(/\\s+/g, ' ').trim() ?? ''");
            witness(ctx, ctaText === "Get the desktop app", "The join success primary CTA is the guided install button", ctaText);
            await ctx.expectNoText("Copy sign-in link");
            const oldOpenButtonVisible = await ctx.eval(`(() => {
              const oldTestId = document.querySelector('[data-testid=join-org-open-openwork]');
              const exactButton = [...document.querySelectorAll('button')]
                .find((button) => (button.textContent ?? '').replace(/\\s+/g, ' ').trim() === 'Open OpenWork');
              return Boolean(oldTestId || exactButton);
            })()`);
            witness(ctx, !oldOpenButtonVisible, "The old Open OpenWork button is gone from the join success layout", oldOpenButtonVisible);
          },
          screenshot: {
            name: "join-success-one-clear-next-step",
            requireText: ["You're in", "Get the desktop app"],
            rejectText: ["Copy sign-in link"],
          },
        }));
      },
    },
    {
      name: "Frame 2",
      run: async (ctx) => {
        await withWeb(ctx, async () => ctx.prove("The join CTA opens Acme's guided setup and the org-served installer endpoint", {
          voiceover: vo[1],
          action: async () => {
            await clickSelector(ctx, "[data-testid=join-org-get-app]", "guided install CTA");
            await ctx.waitFor("location.pathname === '/install'", { timeoutMs: 30_000, label: "install page navigation" });
            const installHref = await ctx.eval("location.href");
            state.installToken = extractInstallToken(installHref, ctx);
            // The eval stack mints install links on the den-proxy origin; the
            // guide page lives on den-web, so rebuild before asserting it
            // (idempotent on deployments whose first trusted origin is den-web).
            state.installPageUrl = new URL(`/install?token=${encodeURIComponent(state.installToken)}`, DEN_WEB_URL).toString();
            await navigateToAbsolute(ctx, state.installPageUrl);
            await ctx.waitFor("Boolean(document.querySelector('[data-testid=install-guide]'))", { timeoutMs: 30_000, label: "guided installer" });
          },
          assert: async () => {
            await ctx.expectText("Download and install");
            await ctx.expectText("Open OpenWork");
            await ctx.expectText("Sign in");

            const href = await ctx.eval("document.querySelector('[data-testid=install-download-primary]')?.href ?? ''");
            const download = parseInstallDownloadHref(href, ctx);
            const expectedHref = appendApiPath(DEN_API_URL, `/v1/install/${download.platform}`, { token: state.installToken });
            witness(ctx, href === expectedHref, "The primary download link points at den-api with the organization token", { href, expectedHref });

            const macDownloadUrl = appendApiPath(DEN_API_URL, "/v1/install/mac-arm64", { token: state.installToken });
            const response = await fetch(macDownloadUrl, { redirect: "manual" });
            const location = response.headers.get("location") ?? "";
            witness(ctx, response.status === 302 || response.status === 200, "The org-served macOS download returns a redirect or configured artifact stream", {
              status: response.status,
              location,
              contentType: response.headers.get("content-type"),
            });
            if (response.status === 302) {
              witness(ctx, isWellFormedReleaseAssetUrl(location), "The redirect location is a well-formed release-asset URL", location);
            }
            ctx.output("org-served-download", JSON.stringify({ href, macDownloadUrl, status: response.status, location }, null, 2));
          },
          screenshot: {
            name: "guided-setup-org-served-download",
            requireText: ["Download and install", "Open OpenWork", "Sign in"],
          },
        }));
      },
    },
    {
      name: "Frame 3",
      run: async (ctx) => {
        await withWeb(ctx, async () => ctx.prove("The guide waits for installation and has an already-installed escape hatch", {
          voiceover: vo[2],
          action: async () => {
            await navigateToAbsolute(ctx, requireStateValue(state.installPageUrl, "install page URL"));
            await ctx.waitFor("Boolean(document.querySelector('[data-testid=install-guide]'))", { timeoutMs: 30_000, label: "guided installer" });
            // Both narrated beats: the wait-gate copy, then the one-click
            // "I already have it" affirmation that advances the guide.
            await ctx.expectText("Only continue once OpenWork is installed and running on this computer.");
            await ctx.expectText("I already have OpenWork");
            await clickSelector(ctx, "[data-testid=install-skip-download]", "already have app button");
          },
          assert: async () => {
            await ctx.waitFor("document.querySelector('[data-testid=install-guide-step-open]')?.dataset.state === 'active'", { timeoutMs: 20_000, label: "open step active" });
            await ctx.expectText("Open the app and confirm that you want to connect it to Acme Robotics.");
            witness(ctx, await ctx.eval("Boolean(document.querySelector('[data-testid=install-connect-open]'))"), "The guide exposes the Open OpenWork action after the affirmation", "install-connect-open");
          },
          screenshot: {
            name: "install-wait-gate-copy",
            requireText: ["Open OpenWork", "Open the app and confirm that you want to connect it to Acme Robotics."],
          },
        }));
      },
    },
    {
      name: "Frame 4",
      run: async (ctx) => {
        await ctx.prove("Open OpenWork shows Acme and its server before anything changes", {
          voiceover: vo[3],
          action: async () => {
            await withWeb(ctx, async () => {
              // Frame 3 left the guide on the active open step; continue on
              // the same page so the affirmation is not reset by a reload.
              await ctx.waitFor("Boolean(document.querySelector('[data-testid=install-connect-open]'))", { timeoutMs: 30_000, label: "open app action" });
              const initialConfig = await fetchInstallConfig(ctx);
              state.serverHost = new URL(initialConfig.webUrl || DEN_WEB_URL).host;
              await installConnectFetchCapture(ctx);
              await clickSelector(ctx, "[data-testid=install-connect-open]", "open app button");
              state.connectUrl = await ctx.waitFor(`(() => {
                const url = window.__keylessConnectCapture?.connectUrl ?? '';
                if (!url.startsWith('openwork://connect')) return null;
                try {
                  return new URL(url).searchParams.get('code') ? url : null;
                } catch {
                  return null;
                }
              })()`, { timeoutMs: 30_000, label: "fresh click-time connection link" });
              const parsed = new URL(state.connectUrl);
              witness(ctx, Boolean(parsed.searchParams.get("code")), "The Open button minted a keyless connect link with a one-time code", redactUrlParam(state.connectUrl, "code"));
            });

            useDesktop(ctx);
            await resetDesktopSession(ctx);
            await deliverDeepLinkToDesktop(ctx, requireStateValue(state.connectUrl, "connect URL"));
          },
          assert: async () => {
            useDesktop(ctx);
            await ctx.waitFor("Boolean(document.querySelector('[data-testid=connect-confirm-dialog]'))", { timeoutMs: 30_000, label: "connection confirmation" });
            await ctx.expectText(ORG_NAME);
            await ctx.expectText(requireStateValue(state.serverHost, "server host"));
            await ctx.expectText("Nothing has been changed yet.");
          },
          screenshot: {
            name: "desktop-connect-confirmation-before-change",
            requireText: ["Acme Robotics", "Nothing has been changed yet", "Connect"],
          },
        });
      },
    },
    {
      name: "Frame 5",
      run: async (ctx) => {
        useDesktop(ctx);
        await ctx.prove("Connect turns the app into Acme's forced sign-in surface", {
          voiceover: vo[4],
          action: async () => {
            await captureOriginalDesktopBootstrap(ctx);
            await clickSelector(ctx, "[data-testid=connect-confirm-accept]", "connect confirmation button");
          },
          assert: async () => {
            await ctx.waitForText("Welcome to OpenWork", { timeoutMs: 45_000 });
            await ctx.expectText("Sign in to OpenWork");
            const persisted = await invokeDesktop(ctx, "getDesktopBootstrapConfig");
            witness(ctx, persisted?.requireSignin === true, "The accepted connect link persisted a required sign-in gate", persisted);
            witness(ctx, cleanBaseUrl(persisted?.baseUrl) === DEN_WEB_URL, "The desktop bootstrap baseUrl points at the Den deployment", persisted?.baseUrl);
          },
          screenshot: {
            name: "desktop-forced-signin-after-connect",
            requireText: ["Welcome to OpenWork", "Sign in to OpenWork"],
          },
        });
      },
    },
    {
      name: "Frame 6",
      run: async (ctx) => {
        useDesktop(ctx);
        await ctx.prove("Maya signs in and lands in Acme's workspace without typing a server URL", {
          voiceover: vo[5],
          action: async () => {
            await signInMemberViaApi(ctx);
            const handoff = await denApiFetch("/v1/auth/desktop-handoff", {
              method: "POST",
              headers: { authorization: `Bearer ${requireStateValue(state.memberBearer, "member bearer token")}` },
              body: JSON.stringify({ desktopScheme: "openwork" }),
            });
            witness(ctx, handoff.response.ok && typeof handoff.body?.openworkUrl === "string", "The member session minted a desktop auth handoff", {
              status: handoff.response.status,
              hasOpenworkUrl: typeof handoff.body?.openworkUrl === "string",
            });
            await deliverDeepLinkToDesktop(ctx, handoff.body.openworkUrl);
          },
          assert: async () => {
            await ctx.waitFor("Boolean((localStorage.getItem('openwork.den.authToken') ?? '').trim())", { timeoutMs: 60_000, label: "persisted Den auth token" });
            await ctx.waitFor("(localStorage.getItem('openwork.den.activeOrgName') ?? '').includes('Acme')", { timeoutMs: 60_000, label: "Acme active org" });
            await completeDesktopSignedInJourney(ctx);
            await ctx.expectText("Acme Robotics", { timeoutMs: 45_000 });
            await ctx.expectText(state.memberEmail, { timeoutMs: 45_000 });
          },
          screenshot: {
            name: "desktop-signed-into-acme-from-join-download",
            requireText: ["Acme", state.memberEmail],
          },
        });
      },
    },
    {
      name: "Frame 7",
      run: async (ctx) => {
        try {
          await ctx.prove("The guide recovery copy mints a fresh connection link that opens the same confirmation", {
            voiceover: vo[6],
            action: async () => {
              await withWeb(ctx, async () => {
                await navigateToAbsolute(ctx, `${requireStateValue(state.installPageUrl, "install page URL")}&step=2`);
                await ctx.waitFor("Boolean(document.querySelector('[data-testid=install-connect-recovery]'))", { timeoutMs: 30_000, label: "connection recovery button" });
                await clickSelector(ctx, "[data-testid=install-connect-recovery]", "connection recovery button");
                await ctx.waitForText("Copy a fresh connection link and open it anywhere links work", { timeoutMs: 20_000 });
                await stubConnectionClipboardCapture(ctx);
                await clickSelector(ctx, "[data-testid=install-connect-copy]", "copy connection link button");
                state.recoveryConnectUrl = await ctx.waitFor(`(() => {
                  const url = window.__capturedConnectLink ?? '';
                  if (!url.startsWith('openwork://connect')) return null;
                  try {
                    return new URL(url).searchParams.get('code') ? url : null;
                  } catch {
                    return null;
                  }
                })()`, { timeoutMs: 30_000, label: "captured recovery connection link" });
                witness(ctx, state.recoveryConnectUrl !== state.connectUrl, "The recovery affordance minted a fresh connection link", {
                  original: redactUrlParam(state.connectUrl, "code"),
                  recovery: redactUrlParam(state.recoveryConnectUrl, "code"),
                });
              });

              useDesktop(ctx);
              await deliverDeepLinkToDesktop(ctx, requireStateValue(state.recoveryConnectUrl, "recovery connect URL"));
            },
            assert: async () => {
              useDesktop(ctx);
              await ctx.waitFor("Boolean(document.querySelector('[data-testid=connect-confirm-dialog]'))", { timeoutMs: 30_000, label: "recovery connection confirmation" });
              await ctx.expectText(ORG_NAME);
              await ctx.expectText("Nothing has been changed yet.");
            },
            screenshot: {
              name: "desktop-recovery-connect-confirmation",
              requireText: ["Acme Robotics", "Nothing has been changed yet"],
            },
          });
        } finally {
          useDesktop(ctx);
          await restoreDesktopAfterFlow(ctx);
        }
      },
    },
  ],
};

function cleanBaseUrl(value) {
  return (value ?? "").trim().replace(/\/+$/, "");
}

function witness(ctx, condition, assertion, actual) {
  ctx.recordEvidence({ type: "assertion", status: condition ? "passed" : "failed", assertion, actual });
  ctx.assert(condition, `${assertion}. Actual: ${JSON.stringify(actual)}`);
}

function rememberDesktop(ctx) {
  if (!state.desktopClient) {
    state.desktopClient = ctx.client;
  }
}

function useDesktop(ctx) {
  if (!state.desktopClient) {
    throw new Error("Desktop CDP client was not captured.");
  }
  ctx.client = state.desktopClient;
}

function requireStateValue(value, label) {
  if (typeof value === "string" && value.trim()) {
    return value;
  }
  throw new Error(`${label} was not prepared by an earlier frame.`);
}

async function firstPageTarget(cdpBaseUrl) {
  const existing = await listTargets(cdpBaseUrl);
  const page = existing.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
  if (page) {
    return page;
  }

  const base = cdpBaseUrl.replace(/\/+$/, "");
  let response = await fetch(`${base}/json/new?about:blank`, { method: "PUT" });
  if (!response.ok) {
    response = await fetch(`${base}/json/new?about:blank`);
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

async function withWeb(ctx, fn) {
  const previous = ctx.client;
  const target = await firstPageTarget(INVITEE_CDP_URL);
  const client = await connect(debuggerUrlFor(INVITEE_CDP_URL, target));
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

async function navigateToAbsolute(ctx, url) {
  await ctx.eval(`(() => { location.assign(${JSON.stringify(url)}); return true; })()`);
  await ctx.waitFor("document.readyState === 'complete'", { timeoutMs: 30_000, label: `load ${url}` });
}

async function clearDenWebSession(ctx) {
  await navigateToAbsolute(ctx, DEN_WEB_URL);
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

async function createInvitation(ctx) {
  const invitation = await denApiFetch("/v1/invitations", {
    method: "POST",
    headers: { authorization: `Bearer ${DEN_TOKEN}` },
    body: JSON.stringify({ email: state.memberEmail, role: "member" }),
  });
  witness(ctx, invitation.response.ok, "Admin API created a fresh Acme invitation", {
    status: invitation.response.status,
    email: state.memberEmail,
  });
  if (typeof invitation.body?.invitationId === "string") {
    state.invitationId = invitation.body.invitationId;
  }
  if (typeof invitation.body?.inviteToken === "string") {
    state.inviteToken = invitation.body.inviteToken;
  }
  return invitation.body;
}

async function getLatestInviteEmail(ctx) {
  const response = await fetch(appendApiPath(DEN_API_URL, "/v1/dev/emails/last", { template: "organizationInvite" }));
  const html = await response.text();
  witness(ctx, response.ok && html.includes(state.memberEmail), "The dev email inbox returned Maya's latest organization invite", {
    status: response.status,
    email: state.memberEmail,
  });
  return { html };
}

function decodeHtmlAttribute(value) {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&#x2F;", "/")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'");
}

function extractInviteFromHtml(html, ctx) {
  const absoluteMatch = html.match(/https?:\/\/[^"'<>\s]+\/join-org\?invite=[^"'<>\s]+/);
  const relativeMatch = html.match(/\/join-org\?invite=[^"'<>\s]+/);
  const rawLink = absoluteMatch?.[0] ?? relativeMatch?.[0] ?? "";
  const link = decodeHtmlAttribute(rawLink);
  ctx.assert(link.length > 0, "Invite email did not contain a /join-org?invite= link.");
  const parsed = new URL(link, DEN_WEB_URL);
  const token = parsed.searchParams.get("invite")?.trim() ?? "";
  ctx.assert(token.length > 0, `Invite link did not include an invite token: ${link}`);
  return { link: parsed.toString(), token };
}

function rewriteInviteLink(inviteLink) {
  const parsed = new URL(inviteLink, DEN_WEB_URL);
  return new URL(`${parsed.pathname}${parsed.search}${parsed.hash}`, DEN_WEB_URL).toString();
}

async function completeInviteSignup(ctx) {
  await ctx.waitFor("Boolean(document.querySelector('input[type=\"password\"]'))", { timeoutMs: 30_000, label: "invite password field" });
  await ctx.fill('input[type="password"]', state.memberPassword);
  await clickExactText(ctx, "Join Acme Robotics", "button");
  await ctx.waitFor(
    `document.body.innerText.includes("You're one click away from the team workspace.") || Boolean(document.querySelector('[data-testid="join-org-success"]'))`,
    { timeoutMs: 45_000, label: "signed-in invite accept step" },
  );
  const alreadySuccess = await ctx.eval("Boolean(document.querySelector('[data-testid=\"join-org-success\"]'))");
  if (!alreadySuccess) {
    await ctx.expectText(state.memberEmail, { timeoutMs: 20_000 });
    markEmailVerified(ctx, state.memberEmail);
    await clickExactText(ctx, "Join Acme Robotics", "button");
  }
  await ctx.waitFor("Boolean(document.querySelector('[data-testid=\"join-org-success\"]'))", { timeoutMs: 45_000, label: "join-org success" });
}

function markEmailVerified(ctx, email) {
  ctx.assert(
    MARK_VERIFIED_CMD.length > 0,
    "Invitation acceptance requires a verified email; set OPENWORK_EVAL_MARK_VERIFIED_CMD (shell template with {email}).",
  );
  execSync(MARK_VERIFIED_CMD.replaceAll("{email}", email), { stdio: "ignore" });
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

async function clickSelector(ctx, selector, label) {
  await ctx.waitFor(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    element?.scrollIntoView({ block: 'center' });
    element?.click();
    return Boolean(element);
  })()`, { timeoutMs: 20_000, label });
}

function appendApiPath(baseUrl, pathname, params = {}) {
  const url = new URL(baseUrl);
  const basePath = url.pathname.replace(/\/+$/, "");
  url.pathname = `${basePath}${pathname.startsWith("/") ? pathname : `/${pathname}`}`.replace(/\/+/g, "/");
  url.search = "";
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, String(value));
  }
  url.hash = "";
  return url.toString();
}

function extractInstallToken(installLink, ctx) {
  const parsed = new URL(installLink, DEN_WEB_URL);
  const token = parsed.searchParams.get("token")?.trim() ?? "";
  ctx.assert(token.length > 0, `Install link did not include a token: ${installLink}`);
  return token;
}

function parseInstallDownloadHref(href, ctx) {
  const parsed = new URL(href);
  const match = parsed.pathname.match(/\/v1\/install\/([^/]+)$/);
  const token = parsed.searchParams.get("token")?.trim() ?? "";
  ctx.assert(Boolean(match?.[1]), `Download href did not include /v1/install/:platform: ${href}`);
  ctx.assert(token === state.installToken, "Download href did not preserve the install token.");
  return { platform: match[1] };
}

function isWellFormedReleaseAssetUrl(value) {
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && Boolean(url.host) && url.pathname.length > 1;
  } catch {
    return false;
  }
}

async function fetchInstallConfig(ctx) {
  const result = await denApiFetch(`/v1/install-config?token=${encodeURIComponent(requireStateValue(state.installToken, "install token"))}`, { method: "GET" });
  witness(ctx, result.response.ok && typeof result.body?.webUrl === "string", "The install token resolves to Acme's install config", {
    status: result.response.status,
    clientName: result.body?.clientName,
    webUrl: result.body?.webUrl,
  });
  return result.body;
}

async function installConnectFetchCapture(ctx) {
  await ctx.eval(`(() => {
    const originalFetch = window.fetch.bind(window);
    window.__keylessConnectCapture = null;
    window.fetch = async (...args) => {
      const response = await originalFetch(...args);
      const input = args[0];
      const requestUrl = typeof input === 'string' ? input : input?.url ?? String(input);
      if (requestUrl.includes('/v1/install-config')) {
        try {
          const payload = await response.clone().json();
          window.__keylessConnectCapture = payload;
        } catch {}
      }
      return response;
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
    window.dispatchEvent(new CustomEvent('openwork:deep-link', { detail: { urls: [url] } }));
    return true;
  })()`);
}

async function invokeDesktop(ctx, command, input) {
  await ctx.waitFor("Boolean(window.__OPENWORK_ELECTRON__?.invokeDesktop)", { timeoutMs: 60_000, label: "desktop bridge" });
  return ctx.eval(`window.__OPENWORK_ELECTRON__.invokeDesktop(${JSON.stringify(command)}, ${JSON.stringify(input)})`, { awaitPromise: true });
}

async function captureOriginalDesktopBootstrap(ctx) {
  if (state.originalDesktopBootstrapConfig) {
    return;
  }
  state.originalDesktopBootstrapConfig = await invokeDesktop(ctx, "getDesktopBootstrapConfig");
}

async function resetDesktopSession(ctx) {
  await ctx.waitFor("Boolean(window.__openworkControl)", { timeoutMs: 60_000, label: "desktop ready" });
  await captureOriginalDesktopBootstrap(ctx);
  await ctx.eval(`(() => {
    document.querySelector('[data-testid=connect-confirm-cancel]')?.click();
    document.querySelector('[data-testid=connect-error-dismiss]')?.click();
    for (const key of [
      'openwork.den.authToken',
      'openwork.den.activeOrgId',
      'openwork.den.activeOrgSlug',
      'openwork.den.activeOrgName',
    ]) localStorage.removeItem(key);
    window.dispatchEvent(new CustomEvent('openwork-den-session-updated', { detail: { status: 'signed_out' } }));
    return true;
  })()`);
}

async function signInMemberViaApi(ctx) {
  if (state.memberBearer) {
    return state.memberBearer;
  }
  const signedIn = await denApiFetch("/api/auth/sign-in/email", {
    method: "POST",
    body: JSON.stringify({ email: state.memberEmail, password: state.memberPassword }),
  });
  witness(ctx, signedIn.response.ok && typeof signedIn.body?.token === "string", "Maya can sign in to Den by API after accepting the invite", {
    status: signedIn.response.status,
    email: state.memberEmail,
  });
  state.memberBearer = signedIn.body.token;
  return state.memberBearer;
}

async function hasText(ctx, text) {
  return Boolean(await ctx.eval(`document.body.innerText.includes(${JSON.stringify(text)})`));
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
}

async function stubConnectionClipboardCapture(ctx) {
  await ctx.eval(`(() => {
    window.__capturedConnectLink = '';
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText(value) {
          window.__capturedConnectLink = String(value);
          return Promise.resolve();
        },
      },
    });
    return true;
  })()`);
}

async function restoreDesktopAfterFlow(ctx) {
  await ctx.waitFor("Boolean(window.__openworkControl)", { timeoutMs: 60_000, label: "desktop ready for cleanup" }).catch(() => null);
  await ctx.eval(`(() => {
    document.querySelector('[data-testid=connect-confirm-cancel]')?.click();
    document.querySelector('[data-testid=connect-error-dismiss]')?.click();
    for (const key of [
      'openwork.den.authToken',
      'openwork.den.activeOrgId',
      'openwork.den.activeOrgSlug',
      'openwork.den.activeOrgName',
    ]) localStorage.removeItem(key);
    window.dispatchEvent(new CustomEvent('openwork-den-session-updated', { detail: { status: 'signed_out' } }));
    return true;
  })()`).catch(() => null);
  if (state.originalDesktopBootstrapConfig) {
    await invokeDesktop(ctx, "setDesktopBootstrapConfig", state.originalDesktopBootstrapConfig).catch(() => null);
    await ctx.eval("location.reload()").catch(() => null);
    await ctx.waitFor("Boolean(window.__openworkControl)", { timeoutMs: 60_000, label: "desktop ready after cleanup reload" }).catch(() => null);
  }
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
