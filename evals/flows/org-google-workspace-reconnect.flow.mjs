import { execSync } from "node:child_process";
import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";
import { denApiFetch, denWebUrl, openYourConnections, signInApi, signInViaBrowser } from "./lib/den-web.mjs";

const vo = await loadVoiceoverParagraphs("org-google-workspace-reconnect");

const ADMIN_EMAIL = process.env.OPENWORK_EVAL_DEMO_EMAIL?.trim() || "alex@acme.test";
const ADMIN_PASSWORD = process.env.OPENWORK_EVAL_DEMO_PASSWORD?.trim() || "OpenWorkDemo123!";
const MEMBER_EMAIL = process.env.OPENWORK_EVAL_MEMBER_EMAIL?.trim() || "jordan.demo@acme.test";
const MEMBER_PASSWORD = process.env.OPENWORK_EVAL_MEMBER_PASSWORD?.trim() || "OpenWorkDemo123!";
const MARK_VERIFIED_CMD = process.env.OPENWORK_EVAL_MARK_VERIFIED_CMD?.trim() || "";
const MOCK_SERVER_URL = (process.env.MOCK_OAUTH_MCP_URL ?? "http://127.0.0.1:3978").trim().replace(/\/+$/, "");
const GOOGLE_CLIENT_ID = "google-client-id";
const GOOGLE_CLIENT_SECRET = "google-client-secret";
const IDENTITY_SCOPES = [
  "openid",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
];
const RECONNECT_FEATURES = ["gmailRead", "calendarWrite"];
const RECONNECT_SCOPES = [
  ...IDENTITY_SCOPES,
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/calendar.events",
];

const state = {
  adminSession: null,
  memberSession: null,
  orgId: null,
  orgName: null,
  reconnectAuthorizeUrl: null,
  reconnectAuthorizeScopes: [],
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRecord(value) {
  return typeof value === "object" && value !== null;
}

function orgHeaders(session) {
  if (!session) throw new Error("Missing session for org-scoped API call.");
  if (!state.orgId) throw new Error("Missing pinned organization id for org-scoped API call.");
  return { authorization: `Bearer ${session}`, "x-openwork-legacy-org-id": state.orgId };
}

function parseScopes(authorizeUrl) {
  return (new URL(authorizeUrl).searchParams.get("scope") ?? "").split(" ").filter(Boolean);
}

function consentAuthorizeUrl(authorizeUrl) {
  const url = new URL(authorizeUrl);
  const mockOrigin = new URL(MOCK_SERVER_URL).origin;
  if (url.origin === mockOrigin && url.pathname === "/authorize") {
    url.searchParams.set("force_consent", "1");
  }
  return url.toString();
}

function assertExactStringSet(ctx, actual, expected, label) {
  const actualValues = Array.isArray(actual) ? actual : [];
  const missing = expected.filter((value) => !actualValues.includes(value));
  const extra = actualValues.filter((value) => !expected.includes(value));
  ctx.assert(
    missing.length === 0 && extra.length === 0 && actualValues.length === expected.length,
    `${label} mismatch. Missing: ${missing.join(", ") || "none"}. Extra: ${extra.join(", ") || "none"}. Actual: ${JSON.stringify(actualValues)}`,
  );
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

async function ensureVerifiedUser(ctx, email, name, password) {
  let token = await signInApi(email, password);
  if (token) return token;

  const signUp = await denApiFetch("/api/auth/sign-up/email", {
    method: "POST",
    body: JSON.stringify({ email, name, password }),
  });
  ctx.assert(signUp.response.ok, `Sign-up failed for ${email}: ${signUp.response.status}`);
  ctx.assert(MARK_VERIFIED_CMD.length > 0, "Set OPENWORK_EVAL_MARK_VERIFIED_CMD to verify eval accounts.");
  execSync(MARK_VERIFIED_CMD.replaceAll("{email}", email), { stdio: "ignore" });
  token = await signInApi(email, password);
  ctx.assert(Boolean(token), `Sign-in still failing for ${email} after sign-up.`);
  return token;
}

async function memberBelongsToPinnedOrg(ctx) {
  const orgs = await denApiFetch("/v1/me/orgs", { headers: { authorization: `Bearer ${state.memberSession}` } });
  ctx.assert(orgs.response.ok, `Member org list failed: ${orgs.response.status} ${JSON.stringify(orgs.body).slice(0, 200)}`);
  return (orgs.body.orgs ?? []).some((org) => org.id === state.orgId);
}

async function ensureMember(ctx) {
  state.memberSession = await ensureVerifiedUser(ctx, MEMBER_EMAIL, "Jordan Demo", MEMBER_PASSWORD);
  if (await memberBelongsToPinnedOrg(ctx)) return;

  const invite = await denApiFetch("/v1/invitations", {
    method: "POST",
    headers: orgHeaders(state.adminSession),
    body: JSON.stringify({ email: MEMBER_EMAIL, role: "member" }),
  });
  if (!invite.response.ok && invite.body?.error === "member_exists") {
    ctx.assert(await memberBelongsToPinnedOrg(ctx), `Invite returned member_exists, but ${MEMBER_EMAIL} is not in ${state.orgName} (${state.orgId}).`);
    return;
  }
  ctx.assert(invite.response.ok, `Invitation failed: ${invite.response.status} ${JSON.stringify(invite.body).slice(0, 200)}`);
  const accept = await denApiFetch("/v1/orgs/invitations/accept", {
    method: "POST",
    headers: { authorization: `Bearer ${state.memberSession}` },
    body: JSON.stringify({ id: invite.body.inviteToken }),
  });
  ctx.assert(accept.response.ok && accept.body.accepted, "Invitation accept failed.");
  ctx.assert(await memberBelongsToPinnedOrg(ctx), `${MEMBER_EMAIL} did not join ${state.orgName} (${state.orgId}) after accepting the invite.`);
}

async function setBrowserActiveOrg(ctx) {
  const ok = await ctx.eval(`fetch('/api/auth/organization/set-active', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ organizationId: ${JSON.stringify(state.orgId)} }) }).then((r) => r.ok)`, { awaitPromise: true });
  ctx.assert(ok, `Could not set the browser active org to ${state.orgName} (${state.orgId}).`);
}

async function saveGoogleClient(ctx, features) {
  const saved = await denApiFetch("/v1/oauth-providers/google-workspace/client", {
    method: "POST",
    headers: orgHeaders(state.adminSession),
    body: JSON.stringify({
      clientId: GOOGLE_CLIENT_ID,
      clientSecret: GOOGLE_CLIENT_SECRET,
      features,
    }),
  });
  ctx.assert(saved.response.ok, `Saving Google client failed: ${saved.response.status} ${JSON.stringify(saved.body).slice(0, 200)}`);
  return saved.body;
}

async function getMemberGoogleConnection(ctx) {
  const result = await denApiFetch("/v1/mcp-connections?scope=usable", {
    headers: orgHeaders(state.memberSession),
  });
  ctx.assert(result.response.ok, `Member MCP connection list failed: ${result.response.status} ${JSON.stringify(result.body).slice(0, 200)}`);
  const connections = Array.isArray(result.body.connections) ? result.body.connections : [];
  const connection = connections.find((entry) => isRecord(entry) && entry.id === "google-workspace");
  ctx.assert(isRecord(connection), `Google Workspace row missing from member connection list: ${JSON.stringify(connections)}`);
  return connection;
}

async function waitForMemberGoogleConnection(ctx, predicate, label) {
  let connection = null;
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    connection = await getMemberGoogleConnection(ctx);
    if (predicate(connection)) return connection;
    await sleep(750);
  }
  ctx.assert(false, `${label} did not become true. Last row: ${JSON.stringify(connection)}`);
  return connection;
}

async function waitForMemberStatus(ctx, expectedScopes) {
  let status = null;
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const result = await denApiFetch("/v1/oauth-providers/google-workspace/status", {
      headers: orgHeaders(state.memberSession),
    });
    if (result.response.ok) {
      status = result.body;
      const scopes = Array.isArray(status.scopes) ? status.scopes : [];
      if (status.connected === true && expectedScopes.every((scope) => scopes.includes(scope))) return status;
    }
    await sleep(750);
  }
  ctx.assert(false, `Member Google Workspace status never included ${JSON.stringify(expectedScopes)}. Last status: ${JSON.stringify(status)}`);
  return status;
}

async function approveMockConsent(ctx) {
  const clicked = await ctx.eval(`(() => {
    const button = [...document.querySelectorAll('button')].find((entry) => (entry.textContent ?? '').trim() === 'Approve OpenWork');
    button?.click();
    return Boolean(button);
  })()`);
  ctx.assert(clicked, "Mock OAuth consent page did not show an Approve OpenWork button.");
  await ctx.waitForText("Connected", { timeoutMs: 30_000 });
}

async function connectMemberWithScopes(ctx, expectedScopes) {
  const started = await denApiFetch("/v1/mcp-connections/google-workspace/connect/start", {
    headers: orgHeaders(state.memberSession),
  });
  ctx.assert(started.response.ok, `Starting Google Workspace connect failed: ${started.response.status} ${JSON.stringify(started.body).slice(0, 200)}`);
  ctx.assert(started.body.status === "needs_auth" && typeof started.body.authorizeUrl === "string", "connect/start did not return an authorizeUrl.");
  assertExactStringSet(ctx, parseScopes(started.body.authorizeUrl), expectedScopes, "Authorize URL scopes");
  await ctx.eval(`(() => { window.location.href = ${JSON.stringify(consentAuthorizeUrl(started.body.authorizeUrl))}; return true; })()`);
  await ctx.waitFor("document.readyState === 'complete'", { timeoutMs: 30_000, label: "mock consent page loaded" });
  await approveMockConsent(ctx);
  await waitForMemberStatus(ctx, expectedScopes);
}

function googleWorkspaceRowTextScript() {
  return `(() => {
    const candidates = [...document.querySelectorAll('div')]
      .filter((el) => {
        const text = el.innerText ?? '';
        return text.includes('Google Workspace') && text.includes('https://workspace.google.com');
      })
      .sort((a, b) => (a.innerText ?? '').length - (b.innerText ?? '').length);
    const row = candidates.find((el) => el.querySelector('button') && ((el.innerText ?? '').includes('Connected as you') || (el.innerText ?? '').includes('Connect your account') || (el.innerText ?? '').includes('Reconnect to grant new permissions')))
      ?? candidates.find((el) => (el.innerText ?? '').includes('Connected as you') || (el.innerText ?? '').includes('Connect your account') || (el.innerText ?? '').includes('Reconnect to grant new permissions'))
      ?? candidates[0];
    row?.scrollIntoView({ block: 'center' });
    return row?.innerText ?? '';
  })()`;
}

function googleWorkspaceRowIncludesScript(requiredText, rejectedText = []) {
  return `(() => {
    const text = ${googleWorkspaceRowTextScript()};
    return ${JSON.stringify(requiredText)}.every((entry) => text.includes(entry))
      && ${JSON.stringify(rejectedText)}.every((entry) => !text.includes(entry));
  })()`;
}

function clickGoogleWorkspaceRowButtonScript(label) {
  return `(() => {
    const candidates = [...document.querySelectorAll('div')]
      .filter((el) => {
        const text = el.innerText ?? '';
        return text.includes('Google Workspace') && text.includes('https://workspace.google.com');
      })
      .sort((a, b) => (a.innerText ?? '').length - (b.innerText ?? '').length);
    for (const row of candidates) {
      const button = [...row.querySelectorAll('button')].find((entry) => (entry.textContent ?? '').trim() === ${JSON.stringify(label)});
      if (!button) continue;
      button.scrollIntoView({ block: 'center' });
      button.click();
      return true;
    }
    return false;
  })()`;
}

async function openMemberYourConnections(ctx) {
  await signInViaBrowser(ctx, MEMBER_EMAIL, MEMBER_PASSWORD);
  await setBrowserActiveOrg(ctx);
  await openYourConnections(ctx);
}

export default {
  id: "org-google-workspace-reconnect",
  title: "Org Google Workspace prompts members to reconnect after selected scopes drift",
  kind: "user-facing",
  spec: "evals/voiceovers/org-google-workspace-reconnect.md",
  requiredEnv: ["OPENWORK_EVAL_DEN_API_URL", "OPENWORK_EVAL_DEN_WEB_URL"],
  steps: [
    {
      name: "Setup: admin saves identity-only Google Workspace and member connects before optional scopes exist",
      run: async (ctx) => {
        const health = await fetch(`${MOCK_SERVER_URL}/health`).then((response) => response.json()).catch(() => null);
        ctx.assert(Boolean(health?.ok), `Mock Google IdP not reachable at ${MOCK_SERVER_URL}.`);

        state.adminSession = await signInApi(ADMIN_EMAIL, ADMIN_PASSWORD);
        ctx.assert(Boolean(state.adminSession), `Admin sign-in failed for ${ADMIN_EMAIL}.`);
        await selectAdminOrganization(ctx);
        await ensureMember(ctx);

        await denApiFetch("/v1/oauth-providers/google-workspace/disconnect", {
          method: "POST",
          headers: orgHeaders(state.memberSession),
        }).catch(() => undefined);

        await saveGoogleClient(ctx, []);
        await connectMemberWithScopes(ctx, IDENTITY_SCOPES);
      },
    },
    {
      name: "Frame 1",
      run: async (ctx) => {
        await ctx.prove("A member connected before optional scopes sees the normal green Google Workspace row", {
          voiceover: vo[0],
          action: async () => {
            await openMemberYourConnections(ctx);
          },
          assert: async () => {
            const connection = await waitForMemberGoogleConnection(ctx, (entry) => entry.connectedForMe === true && entry.needsReconnect !== true, "connected without reconnect drift");
            ctx.assert(connection.needsReconnect !== true, `Expected no reconnect drift, got ${JSON.stringify(connection)}`);
            await ctx.waitFor(googleWorkspaceRowIncludesScript(["Google Workspace", "Connected as you"], ["Reconnect to grant new permissions"]), {
              timeoutMs: 30_000,
              label: "green connected Google Workspace row",
            });
          },
          screenshot: {
            name: "org-google-workspace-reconnect-initial-connected",
            claim: "The member's Google Workspace row is connected and has no reconnect warning before the admin adds scopes.",
            requireText: ["Google Workspace", "Connected as you"],
            rejectText: ["Reconnect to grant new permissions", "Something went wrong"],
          },
        });
      },
    },
    {
      name: "Frame 2",
      run: async (ctx) => {
        await ctx.prove("After the admin adds Gmail read and Calendar write, the member sees an amber reconnect prompt", {
          voiceover: vo[1],
          action: async () => {
            await saveGoogleClient(ctx, RECONNECT_FEATURES);
            await ctx.eval(`(() => { window.location.href = ${JSON.stringify(`${denWebUrl()}/dashboard/your-connections`)}; return true; })()`);
            await ctx.waitFor("window.location.pathname.endsWith('/your-connections')", { timeoutMs: 30_000, label: "Your Connections reloaded" });
          },
          assert: async () => {
            const connection = await waitForMemberGoogleConnection(
              ctx,
              (entry) => entry.connectedForMe === true && entry.needsReconnect === true,
              "Google Workspace reconnect drift",
            );
            assertExactStringSet(ctx, connection.missingFeatures, RECONNECT_FEATURES, "Missing feature ids");
            await ctx.waitFor(googleWorkspaceRowIncludesScript(["Google Workspace", "Reconnect to grant new permissions", "Reconnect", "Disconnect"]), {
              timeoutMs: 30_000,
              label: "amber reconnect Google Workspace row",
            });
          },
          screenshot: {
            name: "org-google-workspace-reconnect-needed",
            claim: "The member row replaces the green ready state with an amber reconnect nudge and keeps Disconnect visible.",
            requireText: ["Google Workspace", "Reconnect to grant new permissions", "Reconnect", "Disconnect"],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
    {
      name: "Frame 3",
      run: async (ctx) => {
        await ctx.prove("Clicking Reconnect opens consent for the newly requested Google scopes", {
          voiceover: vo[2],
          action: async () => {
            await ctx.eval(`(() => {
              window.__openworkEvalLastOpen = null;
              window.open = (url) => { window.__openworkEvalLastOpen = String(url); return null; };
              return true;
            })()`);
            const clicked = await ctx.eval(clickGoogleWorkspaceRowButtonScript("Reconnect"));
            ctx.assert(clicked, "Could not click the Google Workspace Reconnect button.");
            await ctx.waitFor("typeof window.__openworkEvalLastOpen === 'string'", { timeoutMs: 30_000, label: "Reconnect authorize URL opened" });
            state.reconnectAuthorizeUrl = await ctx.eval("window.__openworkEvalLastOpen");
            state.reconnectAuthorizeScopes = parseScopes(state.reconnectAuthorizeUrl);
            assertExactStringSet(ctx, state.reconnectAuthorizeScopes, RECONNECT_SCOPES, "Reconnect authorize URL scopes");
            await ctx.eval(`(() => { window.location.href = ${JSON.stringify(consentAuthorizeUrl(state.reconnectAuthorizeUrl))}; return true; })()`);
            await ctx.waitFor("document.readyState === 'complete'", { timeoutMs: 30_000, label: "mock reconnect consent page loaded" });
          },
          assert: async () => {
            await ctx.waitFor("document.body.innerText.includes('Mock MCP OAuth') && document.body.innerText.includes('https://www.googleapis.com/auth/gmail.readonly') && document.body.innerText.includes('https://www.googleapis.com/auth/calendar.events')", {
              timeoutMs: 30_000,
              label: "mock Google reconnect consent scopes",
            });
            assertExactStringSet(ctx, state.reconnectAuthorizeScopes, RECONNECT_SCOPES, "Reconnect authorize URL scopes");
          },
          screenshot: {
            name: "org-google-workspace-reconnect-consent-scopes",
            claim: "The reconnect consent page shows the newly requested Gmail read and Calendar event scopes before approval.",
            requireText: ["Mock MCP OAuth", "Requested scopes", "https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/calendar.events", "Approve OpenWork"],
            rejectText: ["Connection failed"],
          },
        });

        await approveMockConsent(ctx);
      },
    },
    {
      name: "Frame 4",
      run: async (ctx) => {
        await ctx.prove("After reconnect approval, the row returns to connected and the API clears needsReconnect", {
          voiceover: vo[3],
          action: async () => {
            await waitForMemberStatus(ctx, RECONNECT_SCOPES);
            await openMemberYourConnections(ctx);
          },
          assert: async () => {
            const connection = await waitForMemberGoogleConnection(ctx, (entry) => entry.connectedForMe === true && entry.needsReconnect !== true, "reconnected Google Workspace row");
            ctx.assert(connection.needsReconnect !== true, `Expected needsReconnect false after approval, got ${JSON.stringify(connection)}`);
            await ctx.waitFor(googleWorkspaceRowIncludesScript(["Google Workspace", "Connected as you"], ["Reconnect to grant new permissions"]), {
              timeoutMs: 30_000,
              label: "green reconnected Google Workspace row",
            });
          },
          screenshot: {
            name: "org-google-workspace-reconnect-cleared",
            claim: "After approving the expanded scopes, Google Workspace is green again and no reconnect nudge remains.",
            requireText: ["Google Workspace", "Connected as you"],
            rejectText: ["Reconnect to grant new permissions", "Something went wrong"],
          },
        });
      },
    },
    {
      name: "Frame 5",
      run: async (ctx) => {
        await ctx.prove("Disconnect still returns the Google Workspace row to Connect your account", {
          voiceover: vo[4],
          action: async () => {
            const clicked = await ctx.eval(clickGoogleWorkspaceRowButtonScript("Disconnect"));
            ctx.assert(clicked, "Could not click the Google Workspace Disconnect button.");
          },
          assert: async () => {
            const connection = await waitForMemberGoogleConnection(ctx, (entry) => entry.connectedForMe === false, "disconnected Google Workspace row");
            ctx.assert(connection.needsReconnect !== true, `Disconnected row should not ask for reconnect: ${JSON.stringify(connection)}`);
            await ctx.waitFor(googleWorkspaceRowIncludesScript(["Google Workspace", "Connect your account"], ["Connected as you", "Reconnect to grant new permissions"]), {
              timeoutMs: 30_000,
              label: "disconnected Google Workspace row",
            });
          },
          screenshot: {
            name: "org-google-workspace-reconnect-disconnected",
            claim: "Disconnect clears the member grant and the row returns to the normal connect prompt.",
            requireText: ["Google Workspace", "Connect your account"],
            rejectText: ["Connected as you", "Reconnect to grant new permissions", "Something went wrong"],
          },
        });
      },
    },
  ],
};
