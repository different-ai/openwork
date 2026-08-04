import { dumpScreenState, readActiveWorkspaceId } from "@openwork/cdp";
import type { Surface } from "@openwork/cdp";
import type { DenRef, DenSession } from "./den.ts";
import { createDesktopHandoffGrant } from "./den.ts";
import { clickButton, control, currentHash, evalIn, go, waitFor, waitForText, waitUntilInteractive } from "./desktop.ts";
import { createLocalWorkspaceViaUi } from "./onboarding.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function messageText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function waitForDenState(
  app: Surface,
  den: DenRef,
  expression: string,
  options: { timeoutMs: number; label: string },
): Promise<void> {
  try {
    await waitFor(app, expression, options);
  } catch (error) {
    const keys = await evalIn(
      app,
      "Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index)).filter(Boolean).sort()",
      { timeoutMs: 5_000 },
    ).catch((keysError: unknown) => [`<unavailable: ${messageText(keysError)}>`]);
    throw new Error(
      `${messageText(error)} Resolved Den URLs: web=${den.webUrl}, api=${den.apiUrl}. Current localStorage keys: ${JSON.stringify(keys)}.`,
    );
  }
}

export interface SelectedWorkspaceFacts {
  workspaceId: string;
  route: string;
}

export async function signInDesktopAs(app: Surface, den: DenRef, member: DenSession): Promise<void> {
  await waitFor(app, "Boolean(window.__openworkControl?.listActions?.().some((action) => action.id === 'auth.exchange-grant'))", {
    timeoutMs: 60_000,
    label: "auth.exchange-grant action registered",
  });
  const grant = await createDesktopHandoffGrant(member);
  await control(app, "auth.exchange-grant", { grant, baseUrl: den.webUrl });
  await waitForDenState(app, den, "Boolean((localStorage.getItem('openwork.den.authToken') ?? '').trim())", {
    timeoutMs: 45_000,
    label: "persisted den auth token",
  });
  await waitForDenState(app, den, "Boolean((localStorage.getItem('openwork.den.activeOrgId') ?? '').trim())", {
    timeoutMs: 60_000,
    label: "active org resolved",
  });
  // A first-time member lands on organization onboarding; a member whose app
  // already has a workspace can come straight back to it.
  await waitFor(app, `window.location.hash.includes("/onboarding") || /\\/(workspace|session)/.test(window.location.hash)`, {
    timeoutMs: 60_000,
    label: "organization onboarding or workspace route",
  });
}

async function completeOrganizationOnboarding(app: Surface): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline && (await currentHash(app)).includes("/onboarding")) {
    const label = await evalIn(app, `(() => {
      const labels = [...document.querySelectorAll("button")]
        .filter((button) => !button.disabled)
        .map((button) => (button.textContent ?? "").trim());
      return ["Continue with organization", "Continue to workspace", "Continue without OpenWork Models", "Continue"]
        .find((candidate) => labels.includes(candidate)) ?? "";
    })()`);
    if (typeof label === "string" && label) {
      await clickButton(app, label);
    }
    await sleep(Math.min(750, Math.max(0, deadline - Date.now())));
  }
  if ((await currentHash(app)).includes("/onboarding")) {
    throw new Error(`Organization onboarding did not reach the workspace route. On screen: ${await dumpScreenState(app)}.`);
  }
}

function workspaceIdFromRoute(route: string): string {
  return /\/workspace\/([^/?#]+)/.exec(route)?.[1] ?? "";
}

async function waitForTaskUi(app: Surface, workspaceId: string): Promise<string> {
  await go(app, `/workspace/${workspaceId}/session`);
  await waitFor(app, `(() => {
    const match = /^#?\\/workspace\\/([^/?#]+)\\/session\\/?$/.exec(window.location.hash);
    const routeReady = match?.[1] === ${JSON.stringify(workspaceId)};
    const text = document.body.innerText;
    const runTask = [...document.querySelectorAll("button")]
      .some((button) => (button.textContent ?? "").trim() === "Run task");
    return routeReady && (text.includes("What do you need done?") || runTask);
  })()`, { timeoutMs: 120_000, label: `workspace ${workspaceId} task UI` });
  return currentHash(app);
}

/** The active workspace id from the product's own state, with the route as fallback. */
async function resolveWorkspaceId(app: Surface): Promise<string> {
  const fromState = await readActiveWorkspaceId(app.client, { timeoutMs: 30_000 }).catch(() => null);
  if (fromState) return fromState;
  return workspaceIdFromRoute(await currentHash(app));
}

/**
 * THE arrangement path for a workspace: the product's own onboarding, driven
 * the way a person drives it. A previous API seed (POST /workspaces/local +
 * activate) produced a state the product itself never produces — a workspace
 * with no engine and no model catalog — and specs failed on that arrangement,
 * not on their subject. If a spec needs a workspace, it goes through here.
 */
export async function createAndSelectWorkspace(
  app: Surface,
  input: { path: string },
): Promise<SelectedWorkspaceFacts> {
  let workspaceId = "";
  const route = await currentHash(app);
  if (route.includes("/welcome")) {
    const workspace = await createLocalWorkspaceViaUi(app, input);
    await clickButton(app, "Skip and use the free model", { timeoutMs: 90_000 });
    await waitForText(app, "How did you hear about OpenWork?", { timeoutMs: 90_000 });
    await clickButton(app, "Skip", { timeoutMs: 15_000 });
    // Only now is the workspace actually selected: resolving before the
    // onboarding steps finish reads an id the app has not adopted yet.
    workspaceId = workspace.id;
    if (!workspaceId) {
      await waitFor(app, `Boolean(localStorage.getItem("openwork.react.activeWorkspace"))
        || /\\/workspace\\/[^/?#]+/.test(window.location.hash)`, {
        timeoutMs: 180_000,
        label: "workspace selected after onboarding",
      });
      workspaceId = await resolveWorkspaceId(app);
    }
  } else {
    if (route.includes("/onboarding")) await completeOrganizationOnboarding(app);
    workspaceId = await resolveWorkspaceId(app);
    if (!workspaceId) {
      await waitFor(app, `window.__openworkControl.listActions()
        .some((action) => action.id === "workspace.create" && !action.disabled)`, {
        timeoutMs: 60_000,
        label: "workspace.create enabled",
      });
      // Cold first action: engine spawn + Vite compile can exceed the default
      // evaluate bound, and this proved flaky at 8s (passed on rerun).
      await control(app, "workspace.create", input, { timeoutMs: 60_000 });
      // The app does not always put a new workspace in the hash, so wait for its
      // own active-workspace state to settle instead of matching a route shape.
      await waitFor(app, `Boolean(localStorage.getItem("openwork.react.activeWorkspace"))
        || /\\/workspace\\/[^/?#]+/.test(window.location.hash)`, {
        timeoutMs: 120_000,
        label: "created workspace selected",
      });
      workspaceId = await resolveWorkspaceId(app);
    }
  }
  if (!workspaceId) throw new Error("Workspace creation did not produce a workspace ID.");
  const taskRoute = await waitForTaskUi(app, workspaceId);
  // The task UI can be mounted while the panel still renders placeholders, so
  // hand back only once the app is actually interactive.
  await waitUntilInteractive(app);
  return { workspaceId, route: taskRoute };
}
