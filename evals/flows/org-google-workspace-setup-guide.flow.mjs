import { execSync } from "node:child_process";
import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";
import { denApiFetch, openAdminConnections, signInApi, signInViaBrowser } from "./lib/den-web.mjs";

// Narration is loaded from the approved script (evals/voiceovers/org-google-workspace-setup-guide.md).
// The runner fails this flow if the narration drifts from that script.
const vo = await loadVoiceoverParagraphs("org-google-workspace-setup-guide");

const ADMIN_EMAIL = process.env.OPENWORK_EVAL_DEMO_EMAIL?.trim() || "alex@acme.test";
const ADMIN_PASSWORD = process.env.OPENWORK_EVAL_DEMO_PASSWORD?.trim() || "OpenWorkDemo123!";
const MEMBER_EMAIL = process.env.OPENWORK_EVAL_MEMBER_EMAIL?.trim() || "jordan.demo@acme.test";
const MEMBER_PASSWORD = process.env.OPENWORK_EVAL_MEMBER_PASSWORD?.trim() || "OpenWorkDemo123!";
const MARK_VERIFIED_CMD = process.env.OPENWORK_EVAL_MARK_VERIFIED_CMD?.trim() || "";
const MOCK_SERVER_URL = (process.env.MOCK_OAUTH_MCP_URL ?? "http://127.0.0.1:3978").trim().replace(/\/+$/, "");
const RUN_TAG = Date.now();
const DEFAULT_FEATURES = ["calendarRead", "gmailDraft", "driveFile"];
const GOOGLE_WORKSPACE_CALLBACK_PATH = "/v1/oauth-providers/google-workspace/connect/callback";

const state = {
  adminSession: null,
  memberSession: null,
  orgId: null,
  orgName: null,
  redirectUri: null,
  authorizeUrl: null,
};

function orgHeaders(session) {
  if (!session) throw new Error("Missing session for org-scoped API call.");
  if (!state.orgId) throw new Error("Missing pinned organization id for org-scoped API call.");
  return { authorization: `Bearer ${session}`, "x-openwork-legacy-org-id": state.orgId };
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

function setupInstructionsVisibleScript() {
  return `(() => {
    const text = document.body.innerText;
    const normalized = text.toLowerCase();
    return text.includes('How to set it up')
      && text.includes('Open Google Cloud Console')
      && text.includes('Open API library')
      && text.includes('Add this authorized redirect URI')
      && normalized.includes('google cloud console')
      && normalized.includes('gmail')
      && normalized.includes('calendar')
      && normalized.includes('drive');
  })()`;
}

function redirectUriVisibleScript() {
  return `(() => {
    const element = document.querySelector('[data-google-redirect-uri]');
    return Boolean(element && (element.textContent ?? '').includes('/v1/oauth-providers/google-workspace/connect/callback'));
  })()`;
}

function displayedRedirectUriScript() {
  return `(() => (document.querySelector('[data-google-redirect-uri]')?.textContent ?? '').trim())()`;
}

function copyButtonCopiedScript() {
  return `(() => {
    const button = [...document.querySelectorAll('button')].find((entry) => (entry.textContent ?? '').trim() === 'Copied');
    return Boolean(button);
  })()`;
}

function consoleLinksScript() {
  return `(() => [...document.querySelectorAll('a')].map((link) => ({ text: (link.textContent ?? '').trim(), href: link.href })).filter((link) => link.href.includes('console.cloud.google.com')))()`;
}

function parseRedirectUri(authorizeUrl) {
  return new URL(authorizeUrl).searchParams.get("redirect_uri");
}

function normalizeLoopback(url) {
  const parsed = new URL(url);
  if (parsed.hostname === "127.0.0.1") parsed.hostname = "localhost";
  return parsed.toString();
}

function assertRedirectUriMatch(ctx, actual, expected, label) {
  ctx.assert(typeof actual === "string" && typeof expected === "string", `${label} redirect URI was missing. Actual: ${actual}. Expected: ${expected}.`);
  const actualUrl = new URL(actual);
  const expectedUrl = new URL(expected);
  ctx.assert(actualUrl.pathname === GOOGLE_WORKSPACE_CALLBACK_PATH, `${label} actual path ${actualUrl.pathname} did not match ${GOOGLE_WORKSPACE_CALLBACK_PATH}.`);
  ctx.assert(expectedUrl.pathname === GOOGLE_WORKSPACE_CALLBACK_PATH, `${label} expected path ${expectedUrl.pathname} did not match ${GOOGLE_WORKSPACE_CALLBACK_PATH}.`);
  // Local den-web proxy may use localhost while direct API fetch uses 127.0.0.1; production pins DEN_API_PUBLIC_URL.
  ctx.assert(normalizeLoopback(actual) === normalizeLoopback(expected), `${label} redirect URI mismatch. Actual: ${actual}. Expected: ${expected}.`);
}

function consentAuthorizeUrl(authorizeUrl) {
  const url = new URL(authorizeUrl);
  const mockOrigin = new URL(MOCK_SERVER_URL).origin;
  if (url.origin === mockOrigin && url.pathname === "/authorize") {
    url.searchParams.set("force_consent", "1");
  }
  return url.toString();
}

async function loadGoogleClientConfig(ctx) {
  const config = await denApiFetch("/v1/oauth-providers/google-workspace/client", {
    headers: orgHeaders(state.adminSession),
  });
  ctx.assert(config.response.ok, `Google Workspace client config failed: ${config.response.status} ${JSON.stringify(config.body).slice(0, 200)}`);
  ctx.assert(typeof config.body.redirectUri === "string", `Google Workspace client config did not include redirectUri: ${JSON.stringify(config.body)}`);
  return config.body;
}

export default {
  id: "org-google-workspace-setup-guide",
  title: "Google Workspace setup guides admins through OAuth client registration",
  kind: "user-facing",
  spec: "evals/voiceovers/org-google-workspace-setup-guide.md",
  requiredEnv: ["OPENWORK_EVAL_DEN_API_URL", "OPENWORK_EVAL_DEN_WEB_URL"],
  steps: [
    {
      name: "Setup: admin and member sessions are ready and Google Workspace can start OAuth",
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

        const saved = await denApiFetch("/v1/oauth-providers/google-workspace/client", {
          method: "POST",
          headers: orgHeaders(state.adminSession),
          body: JSON.stringify({
            clientId: `google-setup-guide-client-${RUN_TAG}`,
            clientSecret: "google-setup-guide-secret",
            features: DEFAULT_FEATURES,
          }),
        });
        ctx.assert(saved.response.ok, `Saving Google Workspace client failed: ${saved.response.status} ${JSON.stringify(saved.body).slice(0, 200)}`);
      },
    },
    {
      name: "Frame 1",
      run: async (ctx) => {
        await ctx.prove("The Google Workspace dialog explains where to create the OAuth client and which APIs to enable", {
          voiceover: vo[0],
          action: async () => {
            await signInViaBrowser(ctx, ADMIN_EMAIL, ADMIN_PASSWORD);
            await setBrowserActiveOrg(ctx);
            await openAdminConnections(ctx);
            const clicked = await ctx.eval(clickGoogleQuickAddScript());
            ctx.assert(clicked, "Google Workspace quick-add card was not found.");
          },
          assert: async () => {
            await ctx.waitFor(setupInstructionsVisibleScript(), { timeoutMs: 20_000, label: "Google Workspace setup guide" });
          },
          screenshot: {
            name: "org-google-workspace-setup-guide-instructions",
            claim: "The setup dialog walks the admin through Google Cloud OAuth client creation and API enablement.",
            requireText: ["How to set it up", "Open Google Cloud Console", "Open API library", "Add this authorized redirect URI"],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
    {
      name: "Frame 2",
      run: async (ctx) => {
        await ctx.prove("The setup dialog shows the exact API redirect URI and the Copy button confirms it copied", {
          voiceover: vo[1],
          action: async () => {
            const config = await loadGoogleClientConfig(ctx);
            state.redirectUri = config.redirectUri;
            await ctx.waitFor(redirectUriVisibleScript(), { timeoutMs: 20_000, label: "rendered redirect URI" });
            await ctx.trustedClick('[data-testid="copy-redirect-uri"]', { timeoutMs: 10_000 });
          },
          assert: async () => {
            const displayedRedirectUri = await ctx.eval(displayedRedirectUriScript());
            assertRedirectUriMatch(ctx, displayedRedirectUri, state.redirectUri, "Displayed/API");
            await ctx.waitFor(copyButtonCopiedScript(), { timeoutMs: 10_000, label: "Copied button state" });
          },
          screenshot: {
            name: "org-google-workspace-setup-guide-copy-redirect",
            claim: "The redirect URI matches the API response and the copy control confirms success.",
            requireText: ["Add this authorized redirect URI", "/v1/oauth-providers/google-workspace/connect/callback", "Copied"],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
    {
      name: "Frame 3",
      run: async (ctx) => {
        await ctx.prove("The setup guide links point directly to the Google Console credential and API pages", {
          voiceover: vo[2],
          action: async () => {
            await ctx.waitFor(setupInstructionsVisibleScript(), { timeoutMs: 20_000, label: "Google Console setup links" });
          },
          assert: async () => {
            const links = await ctx.eval(consoleLinksScript());
            const credentialsLink = links.find((link) => link.text === "Open Google Cloud Console" && link.href.includes("/apis/credentials"));
            const apiLibraryLink = links.find((link) => link.text === "Open API library" && link.href.includes("/apis/library"));
            ctx.assert(Boolean(credentialsLink), `Credentials console link was missing or wrong: ${JSON.stringify(links)}`);
            ctx.assert(Boolean(apiLibraryLink), `API library console link was missing or wrong: ${JSON.stringify(links)}`);
          },
          screenshot: {
            name: "org-google-workspace-setup-guide-console-links",
            claim: "The setup guide includes direct links to Google Cloud credentials and API library pages.",
            requireText: ["Open Google Cloud Console", "Open API library"],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
    {
      name: "Frame 4",
      run: async (ctx) => {
        await ctx.prove("The member Google sign-in uses the same redirect URI shown in setup", {
          voiceover: vo[3],
          action: async () => {
            const config = await loadGoogleClientConfig(ctx);
            state.redirectUri = config.redirectUri;
            const started = await denApiFetch("/v1/mcp-connections/google-workspace/connect/start", {
              headers: orgHeaders(state.memberSession),
            });
            ctx.assert(started.response.ok, `Starting Google Workspace connect failed: ${started.response.status} ${JSON.stringify(started.body).slice(0, 200)}`);
            ctx.assert(started.body.status === "needs_auth" && typeof started.body.authorizeUrl === "string", "connect/start did not return an authorizeUrl.");
            state.authorizeUrl = started.body.authorizeUrl;
            assertRedirectUriMatch(ctx, parseRedirectUri(state.authorizeUrl), state.redirectUri, "Authorize/API");
            await ctx.eval(`(() => { window.location.href = ${JSON.stringify(consentAuthorizeUrl(state.authorizeUrl))}; return true; })()`);
            await ctx.waitFor("document.readyState === 'complete'", { timeoutMs: 30_000, label: "mock consent page loaded" });
          },
          assert: async () => {
            assertRedirectUriMatch(ctx, parseRedirectUri(state.authorizeUrl), state.redirectUri, "Authorize/API");
            await ctx.waitFor("document.body.innerText.includes('Mock MCP OAuth') && document.body.innerText.includes('Approve OpenWork')", {
              timeoutMs: 30_000,
              label: "mock Google consent page",
            });
          },
          screenshot: {
            name: "org-google-workspace-setup-guide-consent-redirect",
            claim: "The member reaches Google consent after Den generated an authorize URL with the exact setup redirect URI.",
            requireText: ["Mock MCP OAuth", "Approve OpenWork"],
            rejectText: ["Connection failed"],
          },
        });
      },
    },
  ],
};
