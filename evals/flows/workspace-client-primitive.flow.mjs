import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

// Narration is loaded from the approved script (evals/voiceovers/workspace-client-primitive.md).
// The runner fails this flow if the narration drifts from that script.
const vo = await loadVoiceoverParagraphs("workspace-client-primitive");

const FIXTURE_WORKSPACE = resolve(
  process.env.OPENWORK_EVAL_ARTIFACTS_DIR ?? "evals/results",
  "..",
  "workspace-client-primitive-workspace",
);
const SESSION_TITLE = "Workspace client primitive proof";
const ACTIVE_WORKSPACE_KEY = "openwork.react.activeWorkspace";

let baselineRoute = null;
let createdSessionId = "";
let settingsHashBeforeReload = "";

async function waitForControl(ctx, label = "control API") {
  await ctx.waitFor("Boolean(window.__openworkControl)", {
    timeoutMs: 60_000,
    label,
  });
}

async function maybeSkipOnboardingPrompts(ctx) {
  const dismissedModels = await ctx.eval(`(() => {
    const dialog = Array.from(document.querySelectorAll('[role="dialog"], [data-slot="dialog-content"], [data-radix-dialog-content]'))
      .find((item) => (item.textContent || "").includes("OpenWork Models"));
    if (!dialog) return false;
    const button = Array.from(dialog.querySelectorAll("button"))
      .find((item) => {
        const label = (item.textContent || "").trim();
        return label.includes("Continue without OpenWork Models") || label === "Close" || item.getAttribute("aria-label") === "Close";
      });
    if (!button) return false;
    button.click();
    return true;
  })()`);
  if (dismissedModels) {
    await ctx.waitFor(
      `!Array.from(document.querySelectorAll('[role="dialog"], [data-slot="dialog-content"], [data-radix-dialog-content]')).some((item) => (item.textContent || "").includes("OpenWork Models"))`,
      { timeoutMs: 10_000, label: "OpenWork Models modal dismissed" },
    );
  }
  const choosingModel = await ctx.hasText("Skip and use the free model");
  if (choosingModel) {
    await ctx.clickText("Skip and use the free model", { selector: "button", timeoutMs: 10_000 });
  }
  const surveySkip = await ctx.eval(`Boolean([...document.querySelectorAll('button')]
    .find((button) => button.textContent?.trim() === 'Skip'))`);
  if (surveySkip) await ctx.clickText("Skip", { selector: "button", timeoutMs: 10_000 });
}

async function ensureWorkspaceReady(ctx) {
  await waitForControl(ctx);
  await maybeSkipOnboardingPrompts(ctx);
  await ctx.eval(`(() => {
    const event = new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true });
    document.dispatchEvent(event);
    document.activeElement?.dispatchEvent(event);
    return true;
  })()`);

  const canCreateTask = await ctx.eval(
    "window.__openworkControl.listActions().some((action) => action.id === 'session.create_task' && !action.disabled)",
  );
  if (!canCreateTask) {
    await mkdir(FIXTURE_WORKSPACE, { recursive: true });
    const welcomeInput = 'input[placeholder="/workspace/my-project"]';
    const onWelcome = await ctx.eval(`Boolean(document.querySelector(${JSON.stringify(welcomeInput)}))`);
    if (onWelcome) {
      await ctx.fill(welcomeInput, FIXTURE_WORKSPACE);
      await ctx.clickText("Use this folder", { selector: "button", timeoutMs: 10_000 });
      await maybeSkipOnboardingPrompts(ctx);
    } else {
      await ctx.waitFor(
        "window.__openworkControl.listActions().some((action) => action.id === 'workspace.create' && !action.disabled)",
        { timeoutMs: 30_000, label: "workspace.create action" },
      );
      await ctx.control("workspace.create", { path: FIXTURE_WORKSPACE });
    }
  }

  await ctx.waitFor(
    "window.__openworkControl.listActions().some((action) => action.id === 'session.create_task' && !action.disabled)",
    { timeoutMs: 60_000, label: "enabled session.create_task action" },
  );
}

async function readRouteInspector(ctx, label = "route inspector") {
  return ctx.waitFor(
    `(() => {
      const route = window.__openwork?.slice?.("route");
      if (!route || route.loading) return null;
      if (!route.baseUrl || !route.tokenPresent || !route.selectedWorkspaceId || !route.connected) return null;
      const selected = Array.isArray(route.workspaces)
        ? route.workspaces.find((workspace) => workspace.id === route.selectedWorkspaceId)
        : null;
      return {
        baseUrl: route.baseUrl,
        tokenPresent: route.tokenPresent,
        selectedWorkspaceId: route.selectedWorkspaceId,
        selectedWorkspaceSessionCount: selected?.sessionCount ?? 0,
        route: window.__openworkControl?.snapshot?.().route ?? window.location.hash,
      };
    })()`,
    { timeoutMs: 60_000, label },
  );
}

function assertRouteStable(ctx, current, label) {
  ctx.assert(Boolean(baselineRoute), "Baseline route inspector was not captured.");
  ctx.assert(current.baseUrl === baselineRoute.baseUrl, `${label}: server base URL changed from ${baselineRoute.baseUrl} to ${current.baseUrl}.`);
  ctx.assert(current.tokenPresent === baselineRoute.tokenPresent, `${label}: token presence changed.`);
  ctx.assert(current.selectedWorkspaceId === baselineRoute.selectedWorkspaceId, `${label}: selected workspace changed from ${baselineRoute.selectedWorkspaceId} to ${current.selectedWorkspaceId}.`);
}

function selectedWorkspaceSettingsHash(tab) {
  const workspaceId = baselineRoute?.selectedWorkspaceId ?? "";
  return `/workspace/${encodeURIComponent(workspaceId)}/settings/${tab}`;
}

async function waitForCreatedSessionInRoute(ctx) {
  return ctx.waitFor(
    `(() => {
      const route = window.__openworkControl.snapshot().route || "";
      const marker = "/session/";
      const markerIndex = route.indexOf(marker);
      if (markerIndex < 0) return null;
      const afterMarker = route.slice(markerIndex + marker.length);
      const stopIndexes = [afterMarker.indexOf("/"), afterMarker.indexOf("?"), afterMarker.indexOf("#")]
        .filter((index) => index >= 0);
      const stopIndex = stopIndexes.length > 0 ? Math.min(...stopIndexes) : afterMarker.length;
      const encodedSessionId = afterMarker.slice(0, stopIndex);
      if (!encodedSessionId) return null;
      try {
        return decodeURIComponent(encodedSessionId);
      } catch {
        return encodedSessionId;
      }
    })()`,
    { timeoutMs: 30_000, label: "created session in route" },
  );
}

export default {
  id: "workspace-client-primitive",
  title: "Workspace-scoped server clients stay stable across sessions, settings, and reloads",
  kind: "user-facing",
  steps: [
    {
      name: "Selected workspace opens with a connected server",
      run: async (ctx) => {
        await ctx.prove("The selected workspace opens on the session surface with one connected server context", {
          voiceover: vo[0],
          action: async () => {
            await ensureWorkspaceReady(ctx);
            await ctx.control("route.session");
            baselineRoute = await readRouteInspector(ctx, "baseline route inspector");
          },
          assert: async () => {
            ctx.assert(Boolean(baselineRoute?.baseUrl), "Route inspector did not report a server base URL.");
            ctx.assert(baselineRoute?.tokenPresent === true, "Route inspector did not report an authenticated server token.");
            ctx.assert(Boolean(baselineRoute?.selectedWorkspaceId), "Route inspector did not report a selected workspace.");
            ctx.log(`workspace=${baselineRoute.selectedWorkspaceId} baseUrl=${baselineRoute.baseUrl}`);
          },
          screenshot: {
            name: "workspace-session-surface-connected",
            requireText: ["Search sessions", "Add workspace"],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
    {
      name: "Session creation uses the same workspace-backed list",
      run: async (ctx) => {
        await ctx.prove("A new session opens and is listed without switching the workspace server", {
          voiceover: vo[1],
          action: async () => {
            await ctx.control("session.create_task");
            createdSessionId = await waitForCreatedSessionInRoute(ctx);
            await ctx.waitFor(
              "window.__openworkControl.listActions().some((action) => action.id === 'session.rename' && !action.disabled)",
              { timeoutMs: 30_000, label: "enabled session.rename action" },
            );
            await ctx.control("session.rename", { sessionId: createdSessionId, title: SESSION_TITLE });
            await ctx.waitForText(SESSION_TITLE, { timeoutMs: 30_000 });
          },
          assert: async () => {
            const currentRoute = await readRouteInspector(ctx, "route inspector after session create");
            assertRouteStable(ctx, currentRoute, "after session create");
            const sessions = await ctx.control("session.list_sessions");
            const listed = Array.isArray(sessions) && sessions.some((session) => session.sessionId === createdSessionId);
            ctx.assert(listed, `Created session ${createdSessionId} was not returned by session.list_sessions.`);
          },
          screenshot: {
            name: "workspace-session-created-listed",
            requireText: [SESSION_TITLE],
          },
        });
      },
    },
    {
      name: "Settings, Connect, and Extensions keep the selected workspace",
      run: async (ctx) => {
        await ctx.prove("Settings, Connect, and Extensions stay scoped to the selected workspace", {
          voiceover: vo[2],
          action: async () => {
            await ctx.control("settings.panel.open", { panel: "connect" });
            await ctx.waitFor(`window.location.hash.includes(${JSON.stringify(selectedWorkspaceSettingsHash("connect"))})`, {
              timeoutMs: 30_000,
              label: "workspace-scoped connect settings route",
            });
            await ctx.waitForText("Connect for teams", { timeoutMs: 30_000 });
            await ctx.control("settings.panel.open", { panel: "extensions" });
            await ctx.waitFor(`window.location.hash.includes(${JSON.stringify(selectedWorkspaceSettingsHash("extensions"))})`, {
              timeoutMs: 30_000,
              label: "workspace-scoped extensions settings route",
            });
            await ctx.waitForText("Extensions", { timeoutMs: 30_000 });
            settingsHashBeforeReload = await ctx.eval("window.location.hash");
          },
          assert: async () => {
            const activeWorkspaceId = await ctx.eval(`window.localStorage.getItem(${JSON.stringify(ACTIVE_WORKSPACE_KEY)})`);
            ctx.assert(activeWorkspaceId === baselineRoute.selectedWorkspaceId, `Active workspace changed in settings: ${activeWorkspaceId}`);
            ctx.assert(settingsHashBeforeReload.includes(selectedWorkspaceSettingsHash("extensions")), `Extensions route was not workspace-scoped: ${settingsHashBeforeReload}`);
            await ctx.expectText("My Extensions");
            await ctx.expectText("Refresh");
          },
          screenshot: {
            name: "workspace-settings-extensions-scoped",
            requireText: ["Extensions", "My Extensions", "Refresh"],
            hashIncludes: selectedWorkspaceSettingsHash("extensions"),
          },
        });
      },
    },
    {
      name: "Reload restores settings and the same workspace session",
      run: async (ctx) => {
        await ctx.prove("Reloading restores the same workspace, settings route, and session list", {
          voiceover: vo[3],
          action: async () => {
            await ctx.eval("(() => { window.location.reload(); return true; })()");
            await waitForControl(ctx, "control API after reload");
            await ctx.waitFor(`window.location.hash.includes(${JSON.stringify(selectedWorkspaceSettingsHash("extensions"))})`, {
              timeoutMs: 60_000,
              label: "settings route restored after reload",
            });
            await ctx.waitForText("Extensions", { timeoutMs: 60_000 });
            await ctx.control("route.session");
            await ctx.waitFor(
              "window.__openworkControl.listActions().some((action) => action.id === 'session.open')",
              { timeoutMs: 60_000, label: "session.open action after reload" },
            );
            await ctx.control("session.open", { sessionId: createdSessionId });
            await ctx.waitForText(SESSION_TITLE, { timeoutMs: 45_000 });
          },
          assert: async () => {
            const currentRoute = await readRouteInspector(ctx, "route inspector after reload");
            assertRouteStable(ctx, currentRoute, "after reload");
            const sessions = await ctx.control("session.list_sessions");
            const listed = Array.isArray(sessions) && sessions.some((session) => session.sessionId === createdSessionId);
            ctx.assert(listed, `Session ${createdSessionId} was not restored in the session list after reload.`);
            const activeWorkspaceId = await ctx.eval(`window.localStorage.getItem(${JSON.stringify(ACTIVE_WORKSPACE_KEY)})`);
            ctx.assert(activeWorkspaceId === baselineRoute.selectedWorkspaceId, `Active workspace changed after reload: ${activeWorkspaceId}`);
          },
          screenshot: {
            name: "workspace-session-restored-after-reload",
            requireText: [SESSION_TITLE],
            hashIncludes: createdSessionId,
          },
        });
      },
    },
  ],
};
