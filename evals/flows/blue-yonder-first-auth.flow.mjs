/**
 * Blue Yonder new-user first run — factory-fresh desktop app first auth.
 *
 * Required env:
 * - OPENWORK_EVAL_DEN_API_URL: Den API base URL for the Blue Yonder sandbox.
 * - OPENWORK_EVAL_DEN_WEB_URL: Den Web origin used by the desktop handoff link.
 *
 * Optional env:
 * - OPENWORK_EVAL_CDP_URL or --cdp-url: CDP endpoint for a factory-fresh Electron app.
 * - OPENWORK_EVAL_BLUE_YONDER_NEW_USER: signed-in member email (default venkat@blueyonder.dev).
 * - OPENWORK_EVAL_BLUE_YONDER_NEW_WORKSPACE: workspace folder (default /workspace/venkat-workspace).
 * - OPENWORK_EVAL_BLUE_YONDER_GATEWAY_URL: gateway base URL used if the transcript asks for JIT login without a full link.
 * - OPENWORK_EVAL_BLUE_YONDER_PASSWORD: account password (default TutorialDemo123!).
 * - OPENWORK_EVAL_BLUE_YONDER_TASK_TIMEOUT_MS: chat turn timeout in milliseconds.
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
  envText,
  resetDesktopDenSession,
  retryAfterGatewayLoginIfNeeded,
  sendPromptAndWait,
  signInByEmail,
  timeoutMs,
  waitForOpenWorkConnectReady,
  workspaceFolder,
} from "./blue-yonder-gateway-common.mjs";

const DEFAULT_NEW_USER_EMAIL = "venkat@blueyonder.dev";
const WORKSPACE_ENV = "OPENWORK_EVAL_BLUE_YONDER_NEW_WORKSPACE";
const DEFAULT_WORKSPACE = "/workspace/venkat-workspace";
const PROMPT = "How many incidents do I have?";
const PROMPT_AFTER_JIT = "Done, signed in.";
const JIT_COMPLETE_SENTINEL = "OPENWORK_BLUE_YONDER_JIT_COMPLETE_SENTINEL";

const state = {
  newUserToken: "",
  workspaceId: "",
  latestTranscript: "",
};

export default {
  id: "blue-yonder-first-auth",
  title: "Blue Yonder factory-fresh desktop first auth provisions org resources and discovers my-incidents",
  kind: "user-facing",
  requiredEnv: ["OPENWORK_EVAL_DEN_API_URL", "OPENWORK_EVAL_DEN_WEB_URL"],
  steps: [
    {
      name: "Frame: first open",
      run: async (ctx) => {
        await ctx.prove("A just-installed Blue Yonder desktop app opens to the OpenWork welcome screen", {
          action: async () => {
            await ctx.waitForText("Welcome to OpenWork", { timeoutMs: 90_000 });
          },
          assert: async () => {
            await ctx.expectText("Welcome to OpenWork");
          },
          screenshot: {
            name: "first-open",
            claim: "The first launch starts from the generic OpenWork welcome screen before Venkat signs in.",
            requireText: ["Welcome to OpenWork"],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
    {
      name: "Dispatch Venkat's Den desktop handoff",
      run: async (ctx) => {
        state.newUserToken = await dispatchDesktopHandoff(ctx, newUserEmail(ctx));
      },
    },
    {
      name: "Frame: choose org",
      run: async (ctx) => {
        await ctx.prove("Venkat chooses Blue Yonder during first desktop auth", {
          action: async () => {
            await waitForChooseOrg(ctx);
          },
          assert: async () => {
            await ctx.expectText("Choose your organization");
            await ctx.expectText("Blue Yonder");
            await ctx.expectText("Continue with organization");
            const signedIn = await desktopAuthState(ctx);
            assertEvidence(ctx, signedIn.hasToken, "The desktop handoff persisted a Den auth token before org selection", signedIn);
          },
          screenshot: {
            name: "choose-org",
            claim: "Before anything is clicked, the app asks Venkat which organization to connect.",
            requireText: ["Choose your organization", "Blue Yonder", "Continue with organization"],
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
        await ctx.prove("Blue Yonder resources are provisioned before Venkat enters the workspace", {
          action: async () => {
            await waitForOrgResources(ctx);
          },
          assert: async () => {
            await ctx.expectText("Blue Yonder");
            await ctx.expectText("You have access to the following resources.");
            await ctx.expectText("Continue to workspace");
          },
          screenshot: {
            name: "org-provisioned",
            claim: "Before Continue to workspace is clicked, the app shows Blue Yonder resources are ready.",
            requireText: ["Blue Yonder", "You have access to the following resources.", "Continue to workspace"],
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
      name: "Create Venkat's fresh workspace",
      run: async (ctx) => {
        const folder = workspaceFolder(ctx, WORKSPACE_ENV, DEFAULT_WORKSPACE);
        if (state.workspaceId) {
          assertEvidence(ctx, true, "A local workspace is available for Venkat's first run", {
            folder,
            workspaceId: state.workspaceId,
          });
          return;
        }
        state.workspaceId = await ensureLocalWorkspace(ctx, folder);
        assertEvidence(ctx, state.workspaceId.length > 0, "A local workspace is created for Venkat's first run", {
          folder,
          workspaceId: state.workspaceId,
        });
      },
    },
    {
      name: "Frame: org skill on fresh machine",
      run: async (ctx) => {
        await ctx.prove("Venkat's first task discovers the Blue Yonder my-incidents org skill on a fresh machine", {
          action: async () => {
            const timeout = timeoutMs(ctx, "OPENWORK_EVAL_BLUE_YONDER_VENKAT_TIMEOUT_MS", 300_000);
            const first = await sendPromptAndWait(ctx, PROMPT, { timeout });
            state.latestTranscript = await retryAfterGatewayLoginIfNeeded(
              ctx,
              newUserEmail(ctx),
              first,
              JIT_COMPLETE_SENTINEL,
              PROMPT_AFTER_JIT,
              { timeout, gatewayUserEnvName: "OPENWORK_EVAL_BLUE_YONDER_NEW_USER" },
            );
          },
          assert: async () => {
            const transcript = state.latestTranscript;
            assertEvidence(ctx, transcript.toLowerCase().includes("my-incidents"), "Transcript mentions the cloud-delivered my-incidents skill", transcript);
          },
          screenshot: {
            name: "org-skill-on-fresh-machine",
            claim: "The first chat on a brand-new desktop discovers and uses the Blue Yonder my-incidents skill.",
            requireText: ["my-incidents"],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
  ],
};

function newUserEmail(ctx) {
  return envText(ctx, "OPENWORK_EVAL_BLUE_YONDER_NEW_USER") || DEFAULT_NEW_USER_EMAIL;
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
  await ctx.waitFor(`(() => {
    const text = document.body.innerText || '';
    const buttons = [...document.querySelectorAll('button, [role=button]')].map((entry) => (entry.textContent ?? '').replace(/\\s+/g, ' ').trim());
    return text.includes('Choose your organization') && text.includes('Blue Yonder') && buttons.some((button) => button.startsWith('Continue with organization'));
  })()`, { timeoutMs: 90_000, label: "Blue Yonder organization chooser" });
}

async function waitForOrgResources(ctx) {
  await ctx.waitFor(`(() => {
    const text = document.body.innerText || '';
    return text.includes('Blue Yonder') && text.includes('You have access to the following resources.') && text.includes('Continue to workspace');
  })()`, { timeoutMs: 90_000, label: "Blue Yonder provisioned resources screen" });
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
    handoffEvents: window.__blueYonderHandoffDiagnostics?.events ?? [],
    handoffExchanges: window.__blueYonderHandoffDiagnostics?.exchanges ?? [],
  }))()`);
}
