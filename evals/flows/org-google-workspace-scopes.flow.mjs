import { execSync } from "node:child_process";
import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";
import { denApiFetch, openAdminConnections, openYourConnections, signInApi, signInViaBrowser } from "./lib/den-web.mjs";

// Narration is loaded from the approved script (evals/voiceovers/org-google-workspace-scopes.md).
// The runner fails this flow if the narration drifts from that script.
const vo = await loadVoiceoverParagraphs("org-google-workspace-scopes");

const ADMIN_EMAIL = process.env.OPENWORK_EVAL_DEMO_EMAIL?.trim() || "alex@acme.test";
const ADMIN_PASSWORD = process.env.OPENWORK_EVAL_DEMO_PASSWORD?.trim() || "OpenWorkDemo123!";
const MEMBER_EMAIL = process.env.OPENWORK_EVAL_MEMBER_EMAIL?.trim() || "jordan.demo@acme.test";
const MEMBER_PASSWORD = process.env.OPENWORK_EVAL_MEMBER_PASSWORD?.trim() || "OpenWorkDemo123!";
const MARK_VERIFIED_CMD = process.env.OPENWORK_EVAL_MARK_VERIFIED_CMD?.trim() || "";
const MOCK_SERVER_URL = (process.env.MOCK_OAUTH_MCP_URL ?? "http://127.0.0.1:3978").trim().replace(/\/+$/, "");
const RUN_TAG = Date.now();
const GOOGLE_CLIENT_ID = "google-client-id";
const GOOGLE_CLIENT_SECRET = "google-client-secret";
const DEFAULT_FEATURES = ["calendarRead", "gmailDraft", "driveFile"];
const EXTRA_FEATURES = ["gmailRead", "calendarWrite"];
const SAVED_FEATURES = ["calendarRead", "gmailDraft", "driveFile", "gmailRead", "calendarWrite"];
const FEATURE_KEYS = ["calendarRead", "calendarWrite", "gmailDraft", "gmailRead", "driveFile", "driveRead", "driveFull", "chat"];
const IDENTITY_SCOPES = [
  "openid",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
];
const EXPECTED_MEMBER_SCOPES = [
  ...IDENTITY_SCOPES,
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/drive.file",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/calendar.events",
];

const state = {
  adminSession: null,
  memberSession: null,
  orgId: null,
  orgName: null,
  authorizeUrl: null,
  authorizeScopes: [],
  status: null,
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sameStringSet(actual, expected) {
  if (!Array.isArray(actual) || actual.length !== expected.length) return false;
  const actualSet = new Set(actual);
  return actualSet.size === expected.length && expected.every((value) => actualSet.has(value));
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

function includedPermissionsScript() {
  return `(() => {
    const text = document.body.innerText;
    const normalized = text.toLowerCase();
    return text.includes('Permissions')
      && normalized.includes('calendar')
      && normalized.includes('gmail')
      && normalized.includes('drive');
  })()`;
}

function assertFeatureStates(ctx, states, checkedFeatures, uncheckedFeatures) {
  for (const feature of checkedFeatures) {
    ctx.assert(states[feature] === true, `${feature} should be checked.`);
  }
  for (const feature of uncheckedFeatures) {
    ctx.assert(states[feature] === false, `${feature} should be unchecked.`);
  }
}

function featureReadyScript(featureKey) {
  return `(() => {
    const input = [...document.querySelectorAll('input[type="checkbox"][data-feature]')].find((entry) => entry.dataset.feature === ${JSON.stringify(featureKey)});
    return Boolean(input && !input.disabled);
  })()`;
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

function featureStatesScript() {
  return `(() => {
    const states = {};
    for (const featureKey of ${JSON.stringify(FEATURE_KEYS)}) {
      const input = [...document.querySelectorAll('input[type="checkbox"][data-feature]')].find((entry) => entry.dataset.feature === featureKey);
      states[featureKey] = input ? input.checked : null;
    }
    return states;
  })()`;
}

function fillInputByLabelScript(labelText, value) {
  return `(() => {
    const label = [...document.querySelectorAll('label')].find((entry) => (entry.textContent ?? '').trim() === ${JSON.stringify(labelText)});
    const input = label?.parentElement?.querySelector('input');
    if (!input) return false;
    input.focus();
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return input.value === ${JSON.stringify(value)};
  })()`;
}

function saveButtonEnabledScript() {
  return `(() => {
    const button = [...document.querySelectorAll('button')].find((entry) => (entry.textContent ?? '').trim() === 'Save');
    return Boolean(button && !button.disabled);
  })()`;
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

async function waitForSavedFeatures(ctx) {
  let features = [];
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const config = await denApiFetch("/v1/oauth-providers/google-workspace/client", {
      headers: orgHeaders(state.adminSession),
    });
    if (config.response.ok) {
      features = Array.isArray(config.body.features) ? config.body.features : [];
      if (sameStringSet(features, SAVED_FEATURES)) return features;
    }
    await sleep(500);
  }
  ctx.assert(false, `Saved features never matched ${JSON.stringify(SAVED_FEATURES)}; last seen ${JSON.stringify(features)}.`);
  return features;
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

async function waitForMemberConnectedStatus(ctx) {
  let status = null;
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const result = await denApiFetch("/v1/oauth-providers/google-workspace/status", {
      headers: orgHeaders(state.memberSession),
    });
    if (result.response.ok) {
      status = result.body;
      const scopes = Array.isArray(status.scopes) ? status.scopes : [];
      if (status.connected === true && EXPECTED_MEMBER_SCOPES.every((scope) => scopes.includes(scope))) return status;
    }
    await sleep(750);
  }
  ctx.assert(false, `Member Google Workspace status did not become connected with the selected scopes: ${JSON.stringify(status)}`);
  return status;
}

function googleWorkspaceConnectedRowScript() {
  return `(() => {
    const leaves = [...document.querySelectorAll('*')].filter((el) => el.children.length === 0 && (el.textContent ?? '').trim() === 'Google Workspace');
    for (const leaf of leaves) {
      let el = leaf;
      for (let index = 0; index < 6 && el; index += 1) {
        const text = el.textContent ?? '';
        if (text.includes('Connected as you')) {
          el.scrollIntoView({ block: 'center' });
          return true;
        }
        el = el.parentElement;
      }
    }
    return false;
  })()`;
}

export default {
  id: "org-google-workspace-scopes",
  title: "Org Google Workspace asks for desktop-parity scopes and admin-selected extras",
  kind: "user-facing",
  spec: "evals/voiceovers/org-google-workspace-scopes.md",
  requiredEnv: ["OPENWORK_EVAL_DEN_API_URL", "OPENWORK_EVAL_DEN_WEB_URL"],
  steps: [
    {
      name: "Setup: admin and member sessions are ready and Google Workspace starts clean",
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

        const cleanClient = await denApiFetch("/v1/oauth-providers/google-workspace/client", {
          method: "POST",
          headers: orgHeaders(state.adminSession),
          body: JSON.stringify({
            clientId: `google-clean-client-${RUN_TAG}`,
            clientSecret: "google-clean-secret",
            features: DEFAULT_FEATURES,
          }),
        });
        ctx.assert(cleanClient.response.ok, `Saving clean Google client failed: ${cleanClient.response.status} ${JSON.stringify(cleanClient.body).slice(0, 200)}`);
      },
    },
    {
      name: "Frame 1",
      run: async (ctx) => {
        await ctx.prove("The Google Workspace setup shows granular permissions with desktop defaults checked", {
          voiceover: vo[0],
          action: async () => {
            await signInViaBrowser(ctx, ADMIN_EMAIL, ADMIN_PASSWORD);
            await setBrowserActiveOrg(ctx);
            await openAdminConnections(ctx);
            const clicked = await ctx.eval(clickGoogleQuickAddScript());
            ctx.assert(clicked, "Google Workspace quick-add card was not found.");
          },
          assert: async () => {
            await ctx.waitFor(includedPermissionsScript(), { timeoutMs: 20_000, label: "permissions copy" });
            await ctx.waitFor(featureReadyScript("calendarRead"), { timeoutMs: 20_000, label: "default permission checkboxes ready" });
            const states = await ctx.eval(featureStatesScript());
            assertFeatureStates(ctx, states, DEFAULT_FEATURES, ["calendarWrite", "gmailRead", "driveRead", "driveFull", "chat"]);
          },
          screenshot: {
            name: "org-google-workspace-included-permissions",
            claim: "The setup dialog shows granular Calendar, Gmail, and Drive permissions with the default picks checked.",
            requireText: ["Permissions", "Calendar", "Gmail", "Drive", "Read calendar", "Draft emails"],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
    {
      name: "Frame 2",
      run: async (ctx) => {
        await ctx.prove("The admin selects Read Gmail and Create calendar events and the API stores those features", {
          voiceover: vo[1],
          action: async () => {
            await ctx.waitFor(featureReadyScript("gmailRead"), { timeoutMs: 20_000, label: "optional permission checkboxes ready" });
            for (const feature of EXTRA_FEATURES) {
              const result = await ctx.eval(setFeatureCheckedScript(feature, true));
              ctx.assert(result?.ok, `Could not check optional feature ${feature}.`);
            }
            const filledClientId = await ctx.eval(fillInputByLabelScript("Client ID", GOOGLE_CLIENT_ID));
            const filledSecret = await ctx.eval(fillInputByLabelScript("Client secret", GOOGLE_CLIENT_SECRET));
            ctx.assert(filledClientId, "Could not fill the Google client ID.");
            ctx.assert(filledSecret, "Could not fill the Google client secret.");
            await ctx.waitFor(saveButtonEnabledScript(), { timeoutMs: 10_000, label: "enabled Save button" });
            await ctx.clickText("Save", { timeoutMs: 10_000 });
          },
          assert: async () => {
            const features = await waitForSavedFeatures(ctx);
            assertExactStringSet(ctx, features, SAVED_FEATURES, "Saved permission features");
          },
          screenshot: {
            name: "org-google-workspace-features-saved",
            claim: "The admin's two selected optional permissions are saved on the org OAuth client.",
            requireText: ["Google Workspace", "Configured"],
            rejectText: ["Something went wrong", "Failed to save"],
          },
        });
      },
    },
    {
      name: "Frame 3",
      run: async (ctx) => {
        await ctx.prove("Reopening Google Workspace shows the selected optional permissions persisted", {
          voiceover: vo[2],
          action: async () => {
            const clicked = await ctx.eval(clickGoogleQuickAddScript());
            ctx.assert(clicked, "Google Workspace quick-add card was not found when reopening.");
          },
          assert: async () => {
            await ctx.waitFor(featureReadyScript("gmailRead"), { timeoutMs: 20_000, label: "reopened optional permission checkboxes ready" });
            const states = await ctx.eval(featureStatesScript());
            assertFeatureStates(ctx, states, SAVED_FEATURES, ["driveRead", "driveFull", "chat"]);
          },
          screenshot: {
            name: "org-google-workspace-features-persisted",
            claim: "The saved Read Gmail and Create calendar events options are still checked.",
            requireText: ["Permissions", "Read calendar", "Draft emails", "Read Gmail", "Create calendar events"],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
    {
      name: "Frame 4",
      run: async (ctx) => {
        await ctx.prove("The member authorize URL asks for exactly the defaults plus the two selected additions", {
          voiceover: vo[3],
          action: async () => {
            const started = await denApiFetch("/v1/mcp-connections/google-workspace/connect/start", {
              headers: orgHeaders(state.memberSession),
            });
            ctx.assert(started.response.ok, `Starting Google Workspace connect failed: ${started.response.status} ${JSON.stringify(started.body).slice(0, 200)}`);
            ctx.assert(started.body.status === "needs_auth" && typeof started.body.authorizeUrl === "string", "connect/start did not return an authorizeUrl.");
            state.authorizeUrl = started.body.authorizeUrl;
            state.authorizeScopes = parseScopes(state.authorizeUrl);
            assertExactStringSet(ctx, state.authorizeScopes, EXPECTED_MEMBER_SCOPES, "Authorize URL scopes");
            await ctx.eval(`(() => { window.location.href = ${JSON.stringify(consentAuthorizeUrl(state.authorizeUrl))}; return true; })()`);
            await ctx.waitFor("document.readyState === 'complete'", { timeoutMs: 30_000, label: "mock consent page loaded" });
          },
          assert: async () => {
            assertExactStringSet(ctx, state.authorizeScopes, EXPECTED_MEMBER_SCOPES, "Authorize URL scopes");
            await ctx.waitFor("document.body.innerText.includes('Mock MCP OAuth') && document.body.innerText.includes('Approve OpenWork')", {
              timeoutMs: 30_000,
              label: "mock Google consent page",
            });
          },
          screenshot: {
            name: "org-google-workspace-scope-consent",
            claim: "The member reaches the mock Google consent step after Den generated the exact selected scope set.",
            requireText: ["Mock MCP OAuth", "Approve OpenWork"],
            rejectText: ["Connection failed"],
          },
        });

        await approveMockConsent(ctx);
      },
    },
    {
      name: "Frame 5",
      run: async (ctx) => {
        await ctx.prove("After consent, the member is connected and the recorded scopes include the selected extras", {
          voiceover: vo[4],
          action: async () => {
            state.status = await waitForMemberConnectedStatus(ctx);
            await signInViaBrowser(ctx, MEMBER_EMAIL, MEMBER_PASSWORD);
            await setBrowserActiveOrg(ctx);
            await openYourConnections(ctx);
          },
          assert: async () => {
            ctx.assert(state.status?.connected === true, "Member status should report connected: true.");
            const scopes = Array.isArray(state.status?.scopes) ? state.status.scopes : [];
            ctx.assert(scopes.includes("https://www.googleapis.com/auth/gmail.readonly"), "Connected scopes should include Gmail read.");
            ctx.assert(scopes.includes("https://www.googleapis.com/auth/calendar.events"), "Connected scopes should include calendar events.");
            await ctx.waitForText("Google Workspace", { timeoutMs: 30_000 });
            await ctx.waitFor(googleWorkspaceConnectedRowScript(), { timeoutMs: 60_000, label: "Google Workspace connected row" });
          },
          screenshot: {
            name: "org-google-workspace-member-connected",
            claim: "The member-facing row shows Google Workspace connected after consent.",
            requireText: ["Google Workspace", "Connected as you"],
            rejectText: ["Something went wrong", "Connection failed"],
          },
        });
      },
    },
  ],
};
