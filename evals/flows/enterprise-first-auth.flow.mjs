/**
 * Enterprise new-member first run — factory-fresh desktop app first auth.
 *
 * Required env:
 * - OPENWORK_EVAL_DEN_API_URL: Den API base URL for the enterprise sandbox.
 * - OPENWORK_EVAL_DEN_WEB_URL: Den Web origin used by the desktop handoff link.
 *
 * Optional env:
 * - OPENWORK_EVAL_CDP_URL or --cdp-url: CDP endpoint for a factory-fresh Electron app.
 * - OPENWORK_EVAL_ENTERPRISE_ORG_NAME: organization display name (default Example Organization).
 * - OPENWORK_EVAL_ENTERPRISE_NEW_MEMBER_EMAIL: signed-in member email (default new.member@example.com).
 * - OPENWORK_EVAL_ENTERPRISE_NEW_MEMBER_WORKSPACE: workspace folder (default /workspace/enterprise-first-auth).
 * - OPENWORK_EVAL_ENTERPRISE_GATEWAY_URL: gateway base URL used if the transcript asks for JIT login without a full link.
 * - OPENWORK_EVAL_ENTERPRISE_NEW_MEMBER_GATEWAY_USER: gateway login user override (default signed-in member email).
 * - OPENWORK_EVAL_ENTERPRISE_PASSWORD: account password (default TutorialDemo123!).
 * - OPENWORK_EVAL_ENTERPRISE_TASK_TIMEOUT_MS: chat turn timeout in milliseconds.
 *
 * Runner note: evals/runner/run.mjs chooses one CDP endpoint for a run. Point
 * OPENWORK_EVAL_CDP_URL (or --cdp-url) at the freshly installed sandbox/app.
 */

import {
  assertEvidence,
  configureDesktopForDen,
  createDesktopHandoff,
  deliverDesktopDeepLink,
  ensureLocalWorkspace,
  ensureLocalWorkspaceBeforeConnectPollIfNeeded,
  enterpriseOrgName,
  envText,
  resetDesktopDenSession,
  retryAfterGatewayLoginIfNeeded,
  sendPromptAndWait,
  signInByEmail,
  timeoutMs,
  waitForOpenWorkConnectReady,
  workspaceFolder,
} from "./enterprise-gateway-common.mjs";

const DEFAULT_NEW_MEMBER_EMAIL = "new.member@example.com";
const WORKSPACE_ENV = "OPENWORK_EVAL_ENTERPRISE_NEW_MEMBER_WORKSPACE";
const DEFAULT_WORKSPACE = "/workspace/enterprise-first-auth";
const PROMPT = "Use OpenWork Cloud capabilities to find and use the `my-incidents` skill, then report the open incidents assigned to me.";
const PROMPT_AFTER_JIT = "The enterprise incident gateway sign-in is complete. Start fresh without reusing prior results: find and use `my-incidents` / `enterprise_graph_query` with `assigned_to: me` and `status: open`, then report my open incidents.";
const JIT_COMPLETE_SENTINEL = "OPENWORK_ENTERPRISE_JIT_COMPLETE_SENTINEL";

const state = {
  newMemberToken: "",
  workspaceId: "",
  latestTranscript: "",
};

export default {
  id: "enterprise-first-auth",
  title: "Enterprise factory-fresh desktop first auth provisions org resources and discovers my-incidents",
  kind: "user-facing",
  requiredEnv: ["OPENWORK_EVAL_DEN_API_URL", "OPENWORK_EVAL_DEN_WEB_URL"],
  steps: [
    {
      name: "Frame: first open",
      run: async (ctx) => {
        await ctx.prove("A just-installed enterprise desktop app opens to the OpenWork welcome screen", {
          action: async () => {
            await ctx.waitForText("Welcome to OpenWork", { timeoutMs: 90_000 });
          },
          assert: async () => {
            await ctx.expectText("Welcome to OpenWork");
          },
          screenshot: {
            name: "enterprise-first-open",
            claim: "The first launch starts from the generic OpenWork welcome screen before the member signs in.",
            requireText: ["Welcome to OpenWork"],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
    {
      name: "Dispatch new member's Den desktop handoff",
      run: async (ctx) => {
        state.newMemberToken = await dispatchDesktopHandoff(ctx, newMemberEmail(ctx));
      },
    },
    {
      name: "Frame: choose org",
      run: async (ctx) => {
        await ctx.prove("New member chooses the organization during first desktop auth", {
          action: async () => {
            await waitForChooseOrg(ctx);
          },
          assert: async () => {
            await ctx.expectText("Choose your organization");
            await ctx.expectText(enterpriseOrgName(ctx));
            await ctx.expectText("Continue with organization");
            const signedIn = await desktopAuthState(ctx);
            assertEvidence(ctx, signedIn.hasToken, "The desktop handoff persisted a Den auth token before org selection", signedIn);
          },
          screenshot: {
            name: "enterprise-choose-org",
            claim: "Before anything is clicked, the app asks the member which organization to connect.",
            requireText: ["Choose your organization", enterpriseOrgName(ctx), "Continue with organization"],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
    {
      name: "Click Continue with organization",
      run: async (ctx) => {
        await clickTextStartingWith(ctx, "Continue with organization", "button, [role=button]", 30_000);
      },
    },
    {
      name: "Frame: org provisioned",
      run: async (ctx) => {
        await ctx.prove("Organization resources are provisioned before the member enters the workspace", {
          action: async () => {
            await waitForOrgResources(ctx);
          },
          assert: async () => {
            await ctx.expectText(enterpriseOrgName(ctx));
            await ctx.expectText("You have access to the following resources.");
            await ctx.expectText("Continue to workspace");
          },
          screenshot: {
            name: "enterprise-org-provisioned",
            claim: "Before Continue to workspace is clicked, the app shows organization resources are ready.",
            requireText: [enterpriseOrgName(ctx), "You have access to the following resources.", "Continue to workspace"],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
    {
      name: "Continue to workspace and wait for OpenWork Connect",
      run: async (ctx) => {
        await clickTextStartingWith(ctx, "Continue to workspace", "button, [role=button]", 30_000);
        await ctx.waitFor("Boolean((localStorage.getItem('openwork.den.authToken') ?? '').trim())", { timeoutMs: 60_000, label: "desktop Den auth token" });
        const shell = await ctx.waitFor(`(() => {
          const text = document.body.innerText || '';
          return text.includes('OpenWork Connect') || text.includes('Run task') || location.hash.includes('/workspace') || location.hash.includes('/welcome');
        })()`, { timeoutMs: 90_000, label: "desktop app shell after org provisioning" });
        assertEvidence(ctx, Boolean(shell), "The signed-in desktop app shell is visible after org provisioning", await desktopAuthState(ctx));
        const folder = workspaceFolder(ctx, WORKSPACE_ENV, DEFAULT_WORKSPACE);
        state.workspaceId = await ensureLocalWorkspaceBeforeConnectPollIfNeeded(ctx, folder);
        if (state.workspaceId) {
          assertEvidence(ctx, true, "A local workspace is created from the welcome route before polling OpenWork Connect", {
            folder,
            workspaceId: state.workspaceId,
          });
        }
        const ready = await waitForOpenWorkConnectReady(ctx);
        assertEvidence(ctx, ready.ready, "OpenWork Connect reaches Ready on the factory-fresh app", ready);
      },
    },
    {
      name: "Create new member's fresh workspace",
      run: async (ctx) => {
        const folder = workspaceFolder(ctx, WORKSPACE_ENV, DEFAULT_WORKSPACE);
        if (state.workspaceId) {
          assertEvidence(ctx, true, "A local workspace is available for the member's first run", {
            folder,
            workspaceId: state.workspaceId,
          });
          return;
        }
        state.workspaceId = await ensureLocalWorkspace(ctx, folder);
        assertEvidence(ctx, state.workspaceId.length > 0, "A local workspace is created for the member's first run", {
          folder,
          workspaceId: state.workspaceId,
        });
      },
    },
    {
      name: "Frame: org skill on fresh machine",
      run: async (ctx) => {
        await ctx.prove("Member's first task discovers the my-incidents org skill on a fresh machine", {
          action: async () => {
            const timeout = timeoutMs(ctx, "OPENWORK_EVAL_ENTERPRISE_FIRST_AUTH_TIMEOUT_MS", 300_000);
            const first = await sendPromptAndWait(ctx, PROMPT, { timeout });
            state.latestTranscript = await retryAfterGatewayLoginIfNeeded(
              ctx,
              newMemberEmail(ctx),
              first,
              JIT_COMPLETE_SENTINEL,
              PROMPT_AFTER_JIT,
              { timeout, gatewayUserEnvName: "OPENWORK_EVAL_ENTERPRISE_NEW_MEMBER_GATEWAY_USER" },
            );
          },
          assert: async () => {
            const transcript = state.latestTranscript;
            assertEvidence(ctx, transcript.toLowerCase().includes("my-incidents"), "Transcript mentions the cloud-delivered my-incidents skill", transcript);
          },
          screenshot: {
            name: "enterprise-org-skill-on-fresh-machine",
            claim: "The first chat on a brand-new desktop discovers and uses the my-incidents skill.",
            requireText: ["my-incidents"],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
  ],
};

function newMemberEmail(ctx) {
  return envText(ctx, "OPENWORK_EVAL_ENTERPRISE_NEW_MEMBER_EMAIL") || DEFAULT_NEW_MEMBER_EMAIL;
}

async function dispatchDesktopHandoff(ctx, email) {
  await configureDesktopForDen(ctx);
  await resetDesktopDenSession(ctx);
  const token = await signInByEmail(ctx, email);
  const openworkUrl = await createDesktopHandoff(ctx, token);
  await deliverDesktopDeepLink(ctx, openworkUrl);
  await waitForDesktopToken(ctx, openworkUrl);
  return token;
}

async function waitForDesktopToken(ctx, openworkUrl) {
  try {
    await ctx.waitFor("Boolean((localStorage.getItem('openwork.den.authToken') ?? '').trim())", { timeoutMs: 60_000, label: "desktop Den token after handoff" });
  } catch (error) {
    const diagnostics = await desktopAuthState(ctx);
    const redactedUrl = openworkUrl.replace(/([?&]grant=)[^&]+/, "$1<redacted>");
    throw new Error(`Timed out waiting for desktop Den token after deep-link handoff ${redactedUrl}. Diagnostics: ${JSON.stringify(diagnostics)}. ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function waitForChooseOrg(ctx) {
  const orgName = enterpriseOrgName(ctx);
  await ctx.waitFor(`(() => {
    const orgName = ${JSON.stringify(orgName)};
    const text = document.body.innerText || '';
    const buttons = [...document.querySelectorAll('button, [role=button]')].map((entry) => (entry.textContent ?? '').replace(/\\s+/g, ' ').trim());
    return text.includes('Choose your organization') && text.includes(orgName) && buttons.some((button) => button.startsWith('Continue with organization'));
  })()`, { timeoutMs: 90_000, label: "enterprise organization chooser" });
}

async function waitForOrgResources(ctx) {
  const orgName = enterpriseOrgName(ctx);
  await ctx.waitFor(`(() => {
    const orgName = ${JSON.stringify(orgName)};
    const text = document.body.innerText || '';
    return text.includes(orgName) && text.includes('You have access to the following resources.') && text.includes('Continue to workspace');
  })()`, { timeoutMs: 90_000, label: "enterprise provisioned resources screen" });
}

async function clickTextStartingWith(ctx, prefix, selector, timeoutMs) {
  await ctx.waitFor(`(() => {
    const normalize = (value) => (value ?? '').replace(/\\s+/g, ' ').trim();
    const element = [...document.querySelectorAll(${JSON.stringify(selector)})]
      .find((entry) => normalize(entry.textContent).startsWith(${JSON.stringify(prefix)}) && entry.disabled !== true && entry.getAttribute('aria-disabled') !== 'true');
    element?.scrollIntoView({ block: 'center', inline: 'center' });
    element?.click();
    return Boolean(element);
  })()`, { timeoutMs, label: `clickable text starting with ${JSON.stringify(prefix)}` });
}

async function desktopAuthState(ctx) {
  return ctx.eval(`(() => ({
    hasToken: Boolean((localStorage.getItem('openwork.den.authToken') ?? '').trim()),
    activeOrgId: localStorage.getItem('openwork.den.activeOrgId') || '',
    activeOrgName: localStorage.getItem('openwork.den.activeOrgName') || '',
    hash: location.hash,
    visibleText: (document.body.innerText || '').slice(0, 1_000),
    handoffEvents: window.__enterpriseHandoffDiagnostics?.events ?? [],
    handoffExchanges: window.__enterpriseHandoffDiagnostics?.exchanges ?? [],
  }))()`);
}
