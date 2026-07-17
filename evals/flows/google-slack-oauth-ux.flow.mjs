import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";
import { denApiFetch, openAdminConnections } from "./lib/den-web.mjs";

const FLOW_ID = "google-slack-oauth-ux";

// Narration is loaded from the approved script (evals/voiceovers/google-slack-oauth-ux.md).
// The runner fails this flow if the narration drifts from that script.
const vo = await loadVoiceoverParagraphs(FLOW_ID);
const execFileAsync = promisify(execFile);

const ADMIN_EMAIL = process.env.OPENWORK_EVAL_DEMO_EMAIL?.trim() || "alex@acme.test";
const MOCK_SERVER_URL = (process.env.MOCK_DCRLESS_MCP_URL ?? "http://127.0.0.1:3979").trim().replace(/\/+$/, "");
const MOCK_CLIENT_ID = process.env.MOCK_CLIENT_ID || "mock-preregistered-client";
const MOCK_CLIENT_SECRET = process.env.MOCK_CLIENT_SECRET || "mock-preregistered-secret";
const RUN_TAG = Date.now();
const GOOGLE_CLIENT_ID = `google-oauth-ux-client-${RUN_TAG}.apps.googleusercontent.com`;
const GOOGLE_CLIENT_SECRET = `google-oauth-ux-secret-${RUN_TAG}`;
const DEFAULT_GOOGLE_FEATURES = ["calendarRead", "gmailDraft", "driveFile"];
const PERMISSIONS_ONLY_FEATURES = ["calendarRead", "gmailDraft", "driveFile", "gmailRead"];
const GOOGLE_WORKSPACE_CALLBACK_PATH = "/v1/oauth-providers/google-workspace/connect/callback";
const CONNECTION_PREFIX = "slack-oauth-ux-";
const CONNECTION_NAME = `${CONNECTION_PREFIX}${RUN_TAG}`;
const SECURITY_MESSAGE = "For security, confirm it's you before changing workspace settings.";

const state = {
  adminSession: null,
  orgId: null,
  orgName: null,
  authProviders: [],
  browserSessionId: null,
  callbackUrl: null,
  connectionId: null,
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sqlString(value) {
  return `'${String(value).replaceAll("\\", "\\\\").replaceAll("'", "''")}'`;
}

function denWebUrl(ctx, path = "/") {
  const base = ctx.env.OPENWORK_EVAL_DEN_WEB_URL.trim().replace(/\/+$/, "");
  ctx.assert(base.length > 0, "OPENWORK_EVAL_DEN_WEB_URL was empty.");
  if (path.startsWith("http")) return path;
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}

function adminSessionToken(ctx) {
  const token = ctx.env.OPENWORK_EVAL_DEN_TOKEN.trim();
  ctx.assert(token.length > 0, "OPENWORK_EVAL_DEN_TOKEN was empty.");
  return token;
}

function mysqlContainer(ctx) {
  return ctx.env.OPENWORK_EVAL_DEN_MYSQL_CONTAINER || "openwork-web-local-mysql";
}

function orgHeaders(session) {
  if (!session) throw new Error("Missing session for org-scoped API call.");
  if (!state.orgId) throw new Error("Missing pinned organization id for org-scoped API call.");
  return { authorization: `Bearer ${session}`, "x-openwork-legacy-org-id": state.orgId };
}

async function runMysql(ctx, sql) {
  const { stdout, stderr } = await execFileAsync("docker", [
    "exec",
    mysqlContainer(ctx),
    "mysql",
    "-uroot",
    "-ppassword",
    "openwork_den",
    "-e",
    sql,
  ]);
  if (stderr.trim()) ctx.log(`mysql stderr: ${stderr.trim()}`);
  return stdout;
}

async function refreshAdminSession(ctx) {
  state.adminSession = adminSessionToken(ctx);
  return state.adminSession;
}

async function selectAdminOrganization(ctx) {
  const listed = await denApiFetch("/v1/me/orgs", {
    headers: { authorization: `Bearer ${state.adminSession}` },
  });
  ctx.assert(listed.response.ok, `Admin org list failed: ${listed.response.status} ${JSON.stringify(listed.body).slice(0, 200)}`);
  const orgs = Array.isArray(listed.body.orgs) ? listed.body.orgs : [];
  const acme = orgs.find((org) => org.slug === "acme-robotics-demo");
  const adminOrg = orgs.find((org) => ["owner", "admin"].includes(String(org.role ?? "").toLowerCase()));
  const selected = acme ?? adminOrg;
  ctx.assert(
    selected && typeof selected.id === "string",
    `Admin ${ADMIN_EMAIL} is not in acme-robotics-demo and has no owner/admin org. Orgs: ${JSON.stringify(orgs)}`,
  );
  state.orgId = selected.id;
  state.orgName = typeof selected.name === "string" && selected.name ? selected.name : selected.slug ?? selected.id;
}

async function setBrowserActiveOrg(ctx) {
  const session = state.adminSession ?? (await refreshAdminSession(ctx));
  const ok = await ctx.eval(`fetch('/api/den/v1/me/active-organization', { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json', authorization: ${JSON.stringify(`Bearer ${session}`)} }, body: JSON.stringify({ organizationId: ${JSON.stringify(state.orgId)} }) }).then((response) => response.ok)`, { awaitPromise: true });
  ctx.assert(ok, `Could not set the browser active org to ${state.orgName} (${state.orgId}).`);
}

async function goToDenWeb(ctx, path) {
  await ctx.eval(`(() => { window.location.assign(${JSON.stringify(denWebUrl(ctx, path))}); return true; })()`);
  await ctx.waitFor("document.readyState === 'complete'", { timeoutMs: 30_000, label: `den-web loaded ${path}` });
}

async function installDenWebBrowserAuthShim(ctx, token) {
  if (!ctx.client?.send) return;
  const bearer = `Bearer ${token}`;
  await ctx.client.send("Network.enable");
  await ctx.client.send("Network.setExtraHTTPHeaders", {
    headers: { Authorization: bearer },
  });
  await ctx.client.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `(() => {
      const bearer = ${JSON.stringify(bearer)};
      const originalFetch = window.fetch;
      const shouldAuthorize = (input) => {
        try {
          const rawUrl = input instanceof Request ? input.url : String(input);
          const url = new URL(rawUrl, window.location.href);
          return url.origin === window.location.origin && url.pathname.startsWith('/api/den');
        } catch {
          return false;
        }
      };
      const headersWithAuth = (input, init) => {
        const headers = new Headers(input instanceof Request ? input.headers : undefined);
        if (init?.headers) {
          new Headers(init.headers).forEach((value, key) => headers.set(key, value));
        }
        if (!headers.has('authorization')) headers.set('authorization', bearer);
        return headers;
      };
      window.fetch = (input, init) => {
        if (!shouldAuthorize(input)) return originalFetch.call(window, input, init);
        const headers = headersWithAuth(input, init);
        if (input instanceof Request && init === undefined) {
          return originalFetch.call(window, new Request(input, { headers }));
        }
        return originalFetch.call(window, input, init === undefined ? { headers } : { ...init, headers });
      };
    })();`,
  });
}

async function waitForDenConnectionsUi(ctx) {
  const loadedState = await ctx.waitFor(`(() => {
    const text = document.body.innerText;
    if (text.toLowerCase().includes('unauthorized')) return 'unauthorized';
    return location.pathname.includes('/dashboard/mcp-connections')
      && text.includes('Connections')
      && text.toLowerCase().includes('quick add')
      && text.includes('Google Workspace')
      ? 'connections'
      : '';
  })()`, { timeoutMs: 45_000, label: "den-web Connections UI after CDP bearer auth" });
  if (loadedState !== "connections") {
    const bodyText = await ctx.eval("document.body.innerText");
    ctx.assert(false, `Den-web Connections UI did not authenticate with the CDP Authorization header. Body: ${String(bodyText).slice(0, 1000)}`);
  }
}

async function signInAdminBrowserWithToken(ctx) {
  const token = await refreshAdminSession(ctx);
  await installDenWebBrowserAuthShim(ctx, token);
  await goToDenWeb(ctx, "/");
  await ctx.eval(`(() => {
    const token = ${JSON.stringify(token)};
    document.cookie = 'better-auth.session_token=; Max-Age=0; Path=/; SameSite=Lax';
    document.cookie = 'better-auth.session_token=' + token + '; Path=/; SameSite=Lax';
    localStorage.setItem('openwork:web:auth-token', token);
    sessionStorage.clear();
    return true;
  })()`);
  await goToDenWeb(ctx, "/dashboard/mcp-connections");
  await waitForDenConnectionsUi(ctx);
}

async function loadAuthProviders(ctx) {
  const me = await denApiFetch("/v1/me", {
    headers: { authorization: `Bearer ${state.adminSession}` },
  });
  ctx.assert(me.response.ok, `Loading current user failed: ${me.response.status} ${JSON.stringify(me.body).slice(0, 200)}`);
  state.authProviders = Array.isArray(me.body.user?.authProviders) ? me.body.user.authProviders : [];
}

async function saveGoogleClient(ctx, features) {
  await refreshAdminSession(ctx);
  const saved = await denApiFetch("/v1/oauth-providers/google-workspace/client", {
    method: "POST",
    headers: orgHeaders(state.adminSession),
    body: JSON.stringify({
      clientId: GOOGLE_CLIENT_ID,
      clientSecret: GOOGLE_CLIENT_SECRET,
      features,
    }),
  });
  ctx.assert(saved.response.ok, `Saving Google Workspace client failed: ${saved.response.status} ${JSON.stringify(saved.body).slice(0, 200)}`);
}

async function loadGoogleClientConfig(ctx) {
  let config = await denApiFetch("/v1/oauth-providers/google-workspace/client", {
    headers: orgHeaders(state.adminSession),
  });
  if (config.response.status === 403 && config.body?.error === "reauth") {
    await refreshAdminSession(ctx);
    config = await denApiFetch("/v1/oauth-providers/google-workspace/client", {
      headers: orgHeaders(state.adminSession),
    });
  }
  ctx.assert(config.response.ok, `Google Workspace client config failed: ${config.response.status} ${JSON.stringify(config.body).slice(0, 200)}`);
  return config.body;
}

async function waitForGoogleFeatures(ctx, expectedFeatures) {
  let features = [];
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const config = await loadGoogleClientConfig(ctx);
    features = Array.isArray(config.features) ? config.features : [];
    const sameLength = features.length === expectedFeatures.length;
    if (sameLength && expectedFeatures.every((feature) => features.includes(feature))) return features;
    await sleep(500);
  }
  ctx.assert(false, `Google Workspace features never matched ${JSON.stringify(expectedFeatures)}. Last seen ${JSON.stringify(features)}.`);
  return features;
}

async function cleanupTestConnections(ctx) {
  const existing = await denApiFetch("/v1/mcp-connections?scope=manageable", {
    headers: orgHeaders(state.adminSession),
  });
  ctx.assert(existing.response.ok, `Listing manageable connections failed: ${existing.response.status} ${JSON.stringify(existing.body).slice(0, 200)}`);
  for (const connection of existing.body.connections ?? []) {
    if (connection.name?.startsWith?.(CONNECTION_PREFIX) || connection.name?.startsWith?.("slack-style-")) {
      const removed = await denApiFetch(`/v1/mcp-connections/${connection.id}`, {
        method: "DELETE",
        headers: orgHeaders(state.adminSession),
      });
      ctx.assert(removed.response.ok, `Cleanup delete failed for leftover ${connection.id}: ${removed.response.status}`);
    }
  }
}

function clickGoogleQuickAddScript() {
  return `(() => {
    const card = [...document.querySelectorAll('button')].find((button) => {
      const text = button.textContent ?? '';
      return text.includes('Google Workspace') && (text.includes('Tap to set up') || text.includes('Configured'));
    });
    card?.scrollIntoView({ block: 'center' });
    card?.click();
    return Boolean(card);
  })()`;
}

function clickSlackCardScript() {
  return `(() => {
    const button = [...document.querySelectorAll('button')].find((entry) => {
      const text = entry.textContent ?? '';
      return text.includes('Slack') && text.includes('Tap to add');
    });
    button?.scrollIntoView({ block: 'center' });
    button?.click();
    return Boolean(button);
  })()`;
}

function clickCustomMcpCardScript() {
  return `(() => {
    const button = [...document.querySelectorAll('button')].find((entry) => {
      const text = entry.textContent ?? '';
      return text.includes('MCP server') || text.includes('Add Custom') || text.includes('Connect one remote MCP server by URL');
    });
    button?.scrollIntoView({ block: 'center' });
    button?.click();
    return Boolean(button);
  })()`;
}

function googleSetupVisibleScript() {
  return `(() => {
    const dialog = document.querySelector('[role="dialog"]') ?? document.querySelector('.fixed.inset-0 > div');
    const text = dialog?.textContent ?? document.body.innerText;
    const titleOk = text.includes('Set up Google Workspace') || text.includes('Update Google Workspace');
    return titleOk
      && text.includes('Add this exact authorized redirect URI')
      && text.includes(${JSON.stringify(GOOGLE_WORKSPACE_CALLBACK_PATH)})
      && text.includes('Copy')
      && text.includes('Open Google Cloud Console')
      && text.includes('Open API library');
  })()`;
}

function displayedGoogleRedirectUriScript() {
  return `(() => (document.querySelector('[data-google-redirect-uri]')?.textContent ?? '').trim())()`;
}

function setFeatureCheckedScript(featureKey, checked) {
  return `(() => {
    const input = [...document.querySelectorAll('input[type="checkbox"][data-feature]')].find((entry) => entry.dataset.feature === ${JSON.stringify(featureKey)});
    if (!input || input.disabled) return { ok: false, checked: false };
    input.scrollIntoView({ block: 'center' });
    if (input.checked !== ${JSON.stringify(checked)}) input.click();
    return { ok: input.checked === ${JSON.stringify(checked)}, checked: input.checked };
  })()`;
}

function googleSavedCredentialsVisibleScript() {
  return `(() => {
    const dialog = document.querySelector('[role="dialog"]') ?? document.querySelector('.fixed.inset-0 > div');
    const text = dialog?.textContent ?? '';
    const exactCredentialInput = [...document.querySelectorAll('label')]
      .some((label) => (label.textContent ?? '').trim() === 'Client ID' && Boolean(label.parentElement?.querySelector('input')));
    return {
      ok: text.includes('Credentials saved')
        && text.includes('Saved client ID')
        && text.includes(${JSON.stringify(GOOGLE_CLIENT_ID)})
        && text.includes('Save permissions')
        && !text.includes('Google OAuth credentials')
        && exactCredentialInput === false,
      text,
      exactCredentialInput,
    };
  })()`;
}

function googleReplaceCredentialsVisibleScript() {
  return `(() => {
    const text = document.body.innerText;
    const labels = [...document.querySelectorAll('label')].map((label) => (label.textContent ?? '').trim());
    const saveButton = [...document.querySelectorAll('button')].find((entry) => (entry.textContent ?? '').trim() === 'Save new credentials');
    return {
      text,
      hasGoogleOAuthCredentials: text.includes('Google OAuth credentials'),
      hasClientIdLabel: labels.includes('Client ID'),
      hasClientSecretLabel: labels.includes('Client secret'),
      saveDisabled: Boolean(saveButton?.disabled),
      hasKeepSavedCredentials: text.includes('Keep saved credentials'),
    };
  })()`;
}

function exactEnabledButtonScript(text) {
  return `(() => {
    const button = [...document.querySelectorAll('button')].find((entry) => (entry.textContent ?? '').trim() === ${JSON.stringify(text)} && !entry.disabled);
    button?.scrollIntoView({ block: 'center' });
    button?.click();
    return Boolean(button);
  })()`;
}

function reauthReadyScript() {
  const expectsGoogle = state.authProviders.includes("google");
  return `(() => {
    const dialog = document.querySelector('[role="dialog"]');
    const text = dialog?.textContent ?? '';
    const helperOk = text.includes('OpenWork retries the pending action automatically');
    const hasGoogle = text.includes('Continue with Google');
    const hasPassword = text.includes('Verify password');
    const hasSso = text.includes('Continue with organization SSO');
    return Boolean(dialog)
      && text.includes(${JSON.stringify(SECURITY_MESSAGE)})
      && helperOk
      && (${JSON.stringify(expectsGoogle)} ? hasGoogle : (hasGoogle || hasPassword || hasSso));
  })()`;
}

function reauthDialogStateScript() {
  return `(() => {
    const dialog = document.querySelector('[role="dialog"]');
    const text = dialog?.textContent ?? '';
    return {
      visible: Boolean(dialog),
      text,
      hasGoogle: text.includes('Continue with Google'),
      hasPassword: text.includes('Verify password'),
      hasSso: text.includes('Continue with organization SSO'),
      nonce: dialog?.getAttribute('data-reauth-nonce') ?? null,
    };
  })()`;
}

function callbackUrlScript() {
  return `(() => {
    const elements = [...document.querySelectorAll('*')];
    return elements.find((entry) => (entry.textContent ?? '').includes('/connect/callback'))?.textContent?.trim() ?? null;
  })()`;
}

async function rememberBrowserSession(ctx) {
  const session = state.adminSession ?? (await refreshAdminSession(ctx));
  const sessionId = await ctx.eval(`fetch('/api/den/v1/me', { credentials: 'include', headers: { authorization: ${JSON.stringify(`Bearer ${session}`)} } })
    .then((response) => response.ok ? response.json() : null)
    .then((payload) => payload?.session?.id ?? null)`, { awaitPromise: true });
  if (typeof sessionId === "string" && sessionId.length > 0) {
    state.browserSessionId = sessionId;
    return;
  }

  const rows = await runMysql(ctx, `SELECT id FROM session WHERE token = ${sqlString(session)} LIMIT 1;`);
  const dbSessionId = rows.split(/\r?\n/).map((line) => line.trim()).find((line) => line && line !== "id") ?? null;
  ctx.assert(typeof dbSessionId === "string" && dbSessionId.length > 0, `Could not read browser session id from /api/den/v1/me or MySQL. API: ${sessionId}; MySQL: ${rows.slice(0, 200)}`);
  state.browserSessionId = dbSessionId;
}

async function staleBrowserSession(ctx) {
  await rememberBrowserSession(ctx);
  await runMysql(ctx, `UPDATE session SET created_at = DATE_SUB(NOW(3), INTERVAL 1 HOUR) WHERE id = ${sqlString(state.browserSessionId)};`);
}

async function makeBrowserSessionFreshInDb(ctx) {
  ctx.assert(typeof state.browserSessionId === "string" && state.browserSessionId.length > 0, "Missing browser session id to refresh.");
  await runMysql(ctx, `UPDATE session SET created_at = NOW(3) WHERE id = ${sqlString(state.browserSessionId)};`);
}

async function completeVisibleReauth(ctx) {
  const reauthState = await ctx.eval(reauthDialogStateScript());
  ctx.assert(reauthState?.visible, "Reauth dialog was not visible before completing it.");
  await makeBrowserSessionFreshInDb(ctx);
  ctx.assert(typeof reauthState.nonce === "string" && reauthState.nonce.length > 0, "Reauth nonce was missing for the completion seam.");
  await ctx.eval(`window.postMessage({ type: 'openwork:reauth-complete', nonce: ${JSON.stringify(reauthState.nonce)}, error: null }, window.location.origin); true`);
}

async function waitForNoModalCopy(ctx) {
  await ctx.waitFor(`(() => {
    const text = document.body.innerText;
    return !text.includes('Use one Google OAuth web app')
      && !text.includes('Add Slack')
      && !text.includes('Add a custom MCP server')
      && !text.includes('Almost done')
      && !text.includes('Google OAuth credentials');
  })()`, { timeoutMs: 30_000, label: "modal copy cleared" });
}

async function completeReauthAndWaitForGoogleSave(ctx) {
  await completeVisibleReauth(ctx);
  await ctx.waitFor(`(() => {
    const text = document.body.innerText;
    return !document.querySelector('[role="dialog"]')
      && !text.includes('Use one Google OAuth web app')
      && text.includes('Google Workspace')
      && text.includes('Configured');
  })()`, { timeoutMs: 45_000, label: "Google save retried and dialog closed" });
  ctx.recordEvidence({
    type: "assertion",
    status: "passed",
    assertion: "After reauth, the pending Google Workspace save retried and returned to the configured card.",
  });
}

async function waitForDialogClosed(ctx) {
  await waitForNoModalCopy(ctx);
}

async function openGoogleDialog(ctx) {
  await openAdminConnections(ctx);
  const clicked = await ctx.eval(clickGoogleQuickAddScript());
  ctx.assert(clicked, "Google Workspace quick-add card was not found.");
  await ctx.waitFor(googleSetupVisibleScript(), { timeoutMs: 20_000, label: "Google Workspace dialog" });
}

async function clickCreateConnectionAndHandleReauth(ctx) {
  const clicked = await ctx.eval(exactEnabledButtonScript("Create and show redirect URL"));
  ctx.assert(clicked, "Create and show redirect URL button was not enabled.");
  const stateName = await ctx.waitFor(`(() => {
    const text = document.body.innerText;
    if (text.includes('Almost done')) return 'created';
    if (text.includes(${JSON.stringify(SECURITY_MESSAGE)})) return 'reauth';
    return '';
  })()`, { timeoutMs: 30_000, label: "redirect handoff or reauth" });
  if (stateName === "reauth") {
    await completeVisibleReauth(ctx);
    await ctx.waitForText("Almost done", { timeoutMs: 45_000 });
  }
}

export default {
  id: FLOW_ID,
  title: "Google and Slack OAuth setup tells admins exactly what to do next",
  kind: "user-facing",
  requiredEnv: ["OPENWORK_EVAL_DEN_API_URL", "OPENWORK_EVAL_DEN_TOKEN", "OPENWORK_EVAL_DEN_WEB_URL", "OPENWORK_EVAL_DEN_MYSQL_CONTAINER"],
  spec: "evals/voiceovers/google-slack-oauth-ux.md",
  steps: [
    {
      name: "Setup: admin session, Google client, and Slack-style cleanup are ready",
      run: async (ctx) => {
        const health = await fetch(`${MOCK_SERVER_URL}/health`).then((response) => response.json()).catch(() => null);
        ctx.assert(Boolean(health?.ok), `DCR-less mock OAuth+MCP server not reachable at ${MOCK_SERVER_URL}.`);
        ctx.assert(health.disableDcr === true, `Mock server at ${MOCK_SERVER_URL} must run with DISABLE_DCR=1.`);
        const metadata = await fetch(`${MOCK_SERVER_URL}/.well-known/oauth-authorization-server`).then((response) => response.json());
        ctx.assert(!("registration_endpoint" in metadata), "DCR-less mock metadata unexpectedly advertised registration_endpoint.");

        await refreshAdminSession(ctx);
        await selectAdminOrganization(ctx);
        await loadAuthProviders(ctx);
        await cleanupTestConnections(ctx);
        await saveGoogleClient(ctx, DEFAULT_GOOGLE_FEATURES);
      },
    },
    {
      name: "Frame 1",
      run: async (ctx) => {
        await ctx.prove("The Google Workspace dialog gives admins the exact OAuth setup instructions and redirect URI", {
          voiceover: vo[0],
          action: async () => {
            await signInAdminBrowserWithToken(ctx);
            await setBrowserActiveOrg(ctx);
            await openGoogleDialog(ctx);
          },
          assert: async () => {
            const config = await loadGoogleClientConfig(ctx);
            const displayedRedirectUri = await ctx.eval(displayedGoogleRedirectUriScript());
            ctx.assert(typeof config.redirectUri === "string" && config.redirectUri.includes(GOOGLE_WORKSPACE_CALLBACK_PATH), `API redirect URI was missing the Google callback path: ${JSON.stringify(config)}`);
            ctx.assert(displayedRedirectUri === config.redirectUri, `Displayed redirect URI did not match API config. Displayed: ${displayedRedirectUri}. API: ${config.redirectUri}.`);
            await ctx.waitFor(googleSetupVisibleScript(), { timeoutMs: 20_000, label: "Google setup copy" });
          },
          screenshot: {
            name: "google-workspace-oauth-setup-guide",
            claim: "The dialog includes the redirect URI, copy button, and Google Console/API instructions.",
            requireText: ["Google Workspace", "Add this exact authorized redirect URI", GOOGLE_WORKSPACE_CALLBACK_PATH, "Copy", "Open Google Cloud Console", "Open API library"],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
    {
      name: "Frame 2",
      run: async (ctx) => {
        await ctx.prove("A stale Google Workspace save opens the security check with a clear retry path", {
          voiceover: vo[1],
          action: async () => {
            await staleBrowserSession(ctx);
            const clicked = await ctx.eval(exactEnabledButtonScript("Save permissions"));
            ctx.assert(clicked, "Save permissions button was not enabled.");
            await ctx.waitFor(reauthReadyScript(), { timeoutMs: 30_000, label: "reauth dialog with available method" });
          },
          assert: async () => {
            const actual = await ctx.eval(reauthDialogStateScript());
            ctx.assert(actual.visible === true, "Reauth dialog should be visible.");
            ctx.assert(actual.text.includes(SECURITY_MESSAGE), `Reauth guidance missing: ${actual.text}`);
            ctx.assert(actual.text.includes("OpenWork retries the pending action automatically"), `Reauth helper missing automatic retry copy: ${actual.text}`);
            if (state.authProviders.includes("google")) {
              ctx.assert(actual.hasGoogle === true, `Seeded Google auth provider should expose Continue with Google. Providers: ${JSON.stringify(state.authProviders)}. Dialog: ${actual.text}`);
            } else {
              ctx.assert(actual.hasPassword || actual.hasSso || actual.hasGoogle, `Reauth dialog had no clear CTA. Providers: ${JSON.stringify(state.authProviders)}. Dialog: ${actual.text}`);
            }
          },
          screenshot: {
            name: "google-workspace-reauth-security-check",
            claim: "The security check explains why it appeared and gives a clear way to continue before retrying the save.",
            requireText: state.authProviders.includes("google")
              ? [SECURITY_MESSAGE, "SECURITY CHECK", "OpenWork retries the pending action automatically", "Continue with Google"]
              : [SECURITY_MESSAGE, "SECURITY CHECK", "OpenWork retries the pending action automatically"],
            rejectText: ["Confirm it's you to continue"],
          },
        });

        await completeReauthAndWaitForGoogleSave(ctx);
        await refreshAdminSession(ctx);
      },
    },
    {
      name: "Frame 3",
      run: async (ctx) => {
        await ctx.prove("Admins can make a permissions-only Google edit without re-entering saved credentials", {
          voiceover: vo[2],
          action: async () => {
            const config = await loadGoogleClientConfig(ctx);
            ctx.assert(config.configured === true, `Google Workspace should be configured before permissions-only edit: ${JSON.stringify(config)}`);
            await openGoogleDialog(ctx);
            const toggled = await ctx.eval(setFeatureCheckedScript("gmailRead", true));
            ctx.assert(toggled?.ok, `Could not turn on the Read Gmail permission: ${JSON.stringify(toggled)}`);
          },
          assert: async () => {
            const actual = await ctx.eval(googleSavedCredentialsVisibleScript());
            ctx.assert(actual.ok === true, `Saved credentials panel was not shown without credential inputs: ${JSON.stringify(actual)}`);
          },
          screenshot: {
            name: "google-workspace-permissions-only-save",
            claim: "The dialog shows saved credentials and the permissions-only save button without blank credential fields.",
            requireText: ["Credentials saved", "Saved client ID", GOOGLE_CLIENT_ID, "Save permissions", "Replace credentials"],
            rejectText: ["Google OAuth credentials", "Failed to save"],
          },
        });

        const clicked = await ctx.eval(exactEnabledButtonScript("Save permissions"));
        ctx.assert(clicked, "Save permissions button was not enabled for the permissions-only edit.");
        await waitForDialogClosed(ctx);
        await waitForGoogleFeatures(ctx, PERMISSIONS_ONLY_FEATURES);
      },
    },
    {
      name: "Frame 4",
      run: async (ctx) => {
        await ctx.prove("Google credential fields only become editable when the admin chooses Replace credentials", {
          voiceover: vo[3],
          action: async () => {
            await openGoogleDialog(ctx);
            const clicked = await ctx.eval(exactEnabledButtonScript("Replace credentials"));
            ctx.assert(clicked, "Replace credentials button was not available.");
            await ctx.waitFor("document.body.innerText.includes('Google OAuth credentials')", { timeoutMs: 10_000, label: "replacement credentials section" });
          },
          assert: async () => {
            const actual = await ctx.eval(googleReplaceCredentialsVisibleScript());
            ctx.assert(actual.hasGoogleOAuthCredentials === true, "Google OAuth credentials section should be visible after Replace credentials.");
            ctx.assert(actual.hasClientIdLabel === true, "Client ID field should be visible after Replace credentials.");
            ctx.assert(actual.hasClientSecretLabel === true, "Client secret field should be visible after Replace credentials.");
            ctx.assert(actual.saveDisabled === true, "Save new credentials should stay disabled until client ID and secret are present.");
            ctx.assert(actual.hasKeepSavedCredentials === true, "Keep saved credentials button should be available while replacing credentials.");
          },
          screenshot: {
            name: "google-workspace-replace-credentials",
            claim: "Replace credentials reveals the credential form and keeps saving disabled until both fields are filled.",
            requireText: ["Google OAuth credentials", "Client ID", "Client secret", "Save new credentials", "Keep saved credentials"],
            rejectText: ["Failed to save"],
          },
        });

        await ctx.clickText("Cancel", { timeoutMs: 10_000 });
        await waitForDialogClosed(ctx);
      },
    },
    {
      name: "Frame 5",
      run: async (ctx) => {
        await ctx.prove("The Slack quick-add explains the pre-registered Slack OAuth app requirement before creation", {
          voiceover: vo[4],
          action: async () => {
            await openAdminConnections(ctx);
            const clicked = await ctx.eval(clickSlackCardScript());
            ctx.assert(clicked, "Slack quick-add card with Tap to add was not found.");
            await ctx.waitForText("Add Slack", { timeoutMs: 10_000 });
          },
          assert: async () => {
            await ctx.expectText("Slack MCP");
            const serverUrl = await ctx.eval(`document.querySelector('input[placeholder="https://mcp.example.com/mcp"]')?.value ?? [...document.querySelectorAll('input')].map((input) => input.value).find((value) => value.includes('mcp.slack.com')) ?? ''`);
            ctx.assert(serverUrl.includes("https://mcp.slack.com/mcp"), `Slack MCP Server URL input should contain https://mcp.slack.com/mcp; saw ${JSON.stringify(serverUrl)}.`);
            await ctx.expectText("pre-registered Slack app");
            await ctx.expectText("automatic app registration");
            await ctx.expectText("Slack OAuth app");
            await ctx.expectText("Client ID");
            await ctx.expectText("Client secret");
          },
          screenshot: {
            name: "slack-quick-add-preregistered-oauth-copy",
            claim: "Slack quick-add names Slack MCP, the Slack app requirement, and the client ID/secret fields up front.",
            requireText: ["Add Slack", "Slack MCP", "pre-registered Slack app", "automatic app registration", "Slack OAuth app", "Client ID", "Client secret"],
            rejectText: ["Something went wrong"],
          },
        });

        await ctx.clickText("Cancel", { timeoutMs: 10_000 });
        await waitForDialogClosed(ctx);
      },
    },
    {
      name: "Frame 6",
      run: async (ctx) => {
        await ctx.prove("Creating a Slack-style OAuth-client connection shows the exact redirect URL handoff and Copy button", {
          voiceover: vo[5],
          action: async () => {
            const clicked = await ctx.eval(clickCustomMcpCardScript());
            ctx.assert(clicked, "Custom MCP server card was not found.");
            await ctx.waitFor("Boolean(document.querySelector('input[placeholder=\"notion\"]'))", { timeoutMs: 10_000, label: "custom MCP dialog" });
            await ctx.fill('input[placeholder="notion"]', CONNECTION_NAME);
            await ctx.fill('input[placeholder="https://mcp.example.com/mcp"]', `${MOCK_SERVER_URL}/mcp`);
            await ctx.clickText("This server needs a pre-registered OAuth app", { timeoutMs: 10_000 });
            await ctx.fill('input[placeholder="1234567890.1234567890123"]', MOCK_CLIENT_ID);
            await ctx.fill('input[placeholder="Client secret"]', MOCK_CLIENT_SECRET);
            await clickCreateConnectionAndHandleReauth(ctx);
            await ctx.waitForText("Almost done", { timeoutMs: 20_000 });
          },
          assert: async () => {
            await ctx.expectText("redirect URL");
            await ctx.expectText("/connect/callback");
            await ctx.expectText("Copy");
            state.callbackUrl = await ctx.eval(callbackUrlScript());
            ctx.assert(Boolean(state.callbackUrl), "The redirect URL handoff did not render a callback URL.");
            ctx.assert(state.callbackUrl.includes("/v1/mcp-connections/"), `Callback URL did not include the connection route: ${state.callbackUrl}`);

            await refreshAdminSession(ctx);
            const list = await denApiFetch("/v1/mcp-connections?scope=manageable", {
              headers: orgHeaders(state.adminSession),
            });
            ctx.assert(list.response.ok, `Listing manageable connections failed: ${list.response.status} ${JSON.stringify(list.body).slice(0, 200)}`);
            const connection = (list.body.connections ?? []).find((entry) => entry.name === CONNECTION_NAME);
            ctx.assert(Boolean(connection), `Created Slack-style connection ${CONNECTION_NAME} not found via API.`);
            state.connectionId = connection.id;
          },
          screenshot: {
            name: "slack-style-redirect-url-copy-handoff",
            claim: "After creation, OpenWork shows the exact redirect URL and a Copy button before teammates connect.",
            requireText: ["Almost done", "redirect URL", "/connect/callback", "Copy"],
            rejectText: ["Something went wrong", "Failed to add connection"],
          },
        });
      },
    },
    {
      name: "Cleanup: delete the Slack-style test connection",
      run: async (ctx) => {
        if (!state.connectionId) return;
        await refreshAdminSession(ctx);
        const removed = await denApiFetch(`/v1/mcp-connections/${state.connectionId}`, {
          method: "DELETE",
          headers: orgHeaders(state.adminSession),
        });
        ctx.assert(removed.response.ok, `Cleanup delete failed for ${state.connectionId}: ${removed.response.status}`);
      },
    },
  ],
};
