import { rm } from "node:fs/promises";
import { expect } from "vitest";
import { control, evalIn, go } from "@openwork/behaviors";
import {
  checkedExec,
  daytonaSandbox,
  defaultDaytonaExec,
  deleteSandboxes,
  desktop,
  localHost,
  provisionDesktopSandbox,
} from "@openwork/hosts";
import type { DesktopHandle } from "@openwork/hosts";
import { eventually, needs, sleep, test } from "@openwork/testkit";

/**
 * ACCEPTANCE TAPE — a session created outside the desktop window (an agent's
 * server-side `session.create`, the CLI, another client) reaches the sidebar
 * of a workspace that is not selected.
 *
 * The desktop only receives engine events for the selected workspace and used
 * to fetch every other workspace's session list exactly once per app
 * lifetime, so such a session stayed invisible — even after clicking the
 * workspace — until a full reload. Two paths now surface it:
 *   1. `workspace.reload_sessions`, which the server-side session.create
 *      affordance issues through the UI bridge right after creating sessions;
 *   2. selecting the workspace, which refetches its list every time.
 */

const e2eTestsEnabled = process.env.OPENWORK_EVAL_E2E_TESTS === "1";
const daytonaEnabled = process.env.OPENWORK_EVAL_DAYTONA === "1";
const title = e2eTestsEnabled
  ? "sessions created outside the window appear in a non-selected workspace's sidebar"
  : "sidebar external session visibility skipped — needs: set OPENWORK_EVAL_E2E_TESTS=1";

// Quiet window that outlasts the sidebar's single 3s "empty list" retry, so a
// session that shows up afterwards can only have arrived through the path
// under test.
const EMPTY_LIST_RETRY_SETTLE_MS = 4_500;
const STALE_OBSERVATION_MS = 2_000;

type UiSession = { sessionId: string; title: string; workspace: string };
type RouteWorkspace = { id: string; name: string; sessionCount: number; loading: boolean; error: string | null };
type RouteSlice = { selectedWorkspaceId: string; workspaces: RouteWorkspace[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function seedHomeWorkspace(desktopApp: DesktopHandle, profileDir: string): Promise<string> {
  const value = await evalIn(desktopApp, `(async () => {
    const state = await window.__OPENWORK_ELECTRON__.invokeDesktop("workspaceCreate", {
      folderPath: ${JSON.stringify(`${profileDir}/home`)},
      name: "Home",
    });
    return (state?.workspaces ?? []).map((workspace) => workspace.id);
  })()`, { awaitPromise: true, timeoutMs: 60_000 });
  if (!Array.isArray(value) || value.length !== 1 || typeof value[0] !== "string") {
    throw new Error(`Workspace seeding returned an invalid list: ${JSON.stringify(value)}`);
  }
  return value[0];
}

async function readRouteSlice(desktopApp: DesktopHandle): Promise<RouteSlice> {
  const value = await evalIn(desktopApp, `(() => {
    const route = window.__openwork?.slice?.("route");
    if (!route) return null;
    return {
      selectedWorkspaceId: String(route.selectedWorkspaceId ?? ""),
      workspaces: (route.workspaces ?? []).map((workspace) => ({
        id: String(workspace.id),
        name: String(workspace.displayNameResolved ?? ""),
        sessionCount: Number(workspace.sessionCount ?? 0),
        loading: Boolean(workspace.loading),
        error: typeof workspace.error === "string" ? workspace.error : null,
      })),
    };
  })()`);
  if (!isRecord(value) || typeof value.selectedWorkspaceId !== "string" || !Array.isArray(value.workspaces)) {
    throw new Error(`Route inspector slice was unavailable: ${JSON.stringify(value)}`);
  }
  const workspaces: RouteWorkspace[] = [];
  for (const workspace of value.workspaces) {
    if (!isRecord(workspace) || typeof workspace.id !== "string" || typeof workspace.name !== "string" || typeof workspace.sessionCount !== "number" || typeof workspace.loading !== "boolean") {
      throw new Error(`Route inspector workspace was invalid: ${JSON.stringify(workspace)}`);
    }
    workspaces.push({
      id: workspace.id,
      name: workspace.name,
      sessionCount: workspace.sessionCount,
      loading: workspace.loading,
      error: typeof workspace.error === "string" ? workspace.error : null,
    });
  }
  return { selectedWorkspaceId: value.selectedWorkspaceId, workspaces };
}

async function listUiSessions(desktopApp: DesktopHandle): Promise<UiSession[]> {
  const value = await control(desktopApp, "session.list_sessions");
  if (!Array.isArray(value)) throw new Error(`session.list_sessions returned an invalid list: ${JSON.stringify(value)}`);
  const sessions: UiSession[] = [];
  for (const session of value) {
    if (!isRecord(session) || typeof session.sessionId !== "string" || typeof session.title !== "string" || typeof session.workspace !== "string") {
      throw new Error(`session.list_sessions returned an invalid session: ${JSON.stringify(session)}`);
    }
    sessions.push({ sessionId: session.sessionId, title: session.title, workspace: session.workspace });
  }
  return sessions;
}

async function sidebarSessionIds(desktopApp: DesktopHandle, workspaceId: string): Promise<string[]> {
  const value = await evalIn(desktopApp, `Array.from(document.querySelectorAll(
    "[data-sidebar-session-workspace-id=" + JSON.stringify(${JSON.stringify(workspaceId)}) + "]",
  )).map((element) => element.getAttribute("data-sidebar-session-id")).filter(Boolean)`);
  if (!Array.isArray(value) || value.some((id) => typeof id !== "string")) {
    throw new Error(`Sidebar returned invalid session rows: ${JSON.stringify(value)}`);
  }
  return value.filter((id): id is string => typeof id === "string");
}

async function listServerWorkspaceIds(desktopApp: DesktopHandle): Promise<string[]> {
  const value = await evalIn(desktopApp, `(async () => {
    const info = await window.__OPENWORK_ELECTRON__?.invokeDesktop?.("openworkServerInfo");
    if (!info?.running || !info.baseUrl) return { error: "local_server_unavailable" };
    const response = await fetch(String(info.baseUrl).replace(/\\/+$/, "") + "/workspaces", {
      headers: { Authorization: "Bearer " + String(info.ownerToken ?? info.clientToken ?? "") },
      signal: AbortSignal.timeout(15_000),
    });
    const body = await response.json();
    return { ok: response.ok, ids: (Array.isArray(body?.items) ? body.items : []).map((item) => String(item?.id ?? "")).filter(Boolean) };
  })()`, { awaitPromise: true, timeoutMs: 20_000 });
  if (!isRecord(value) || value.ok !== true || !Array.isArray(value.ids)) {
    throw new Error(`Listing server workspaces failed: ${JSON.stringify(value)}`);
  }
  return value.ids.filter((id): id is string => typeof id === "string");
}

async function createWorkspace(desktopApp: DesktopHandle, path: string): Promise<string> {
  const before = await listServerWorkspaceIds(desktopApp);
  await control(desktopApp, "workspace.create", { path }, { timeoutMs: 90_000 });
  const after = await eventually(() => listServerWorkspaceIds(desktopApp), {
    within: 90_000,
    intervalMs: 500,
    label: "new workspace registered",
    until: (ids) => ids.length === before.length + 1,
  });
  const createdId = after.find((id) => !before.includes(id));
  if (!createdId) throw new Error("Workspace creation produced no new workspace id.");
  return createdId;
}

/**
 * Creates a session the way another client would: straight against the
 * OpenWork server's workspace mount, never through the desktop's UI state.
 */
async function createSessionOutsideWindow(desktopApp: DesktopHandle, workspaceId: string, sessionTitle: string): Promise<string> {
  const value = await evalIn(desktopApp, `(async () => {
    const info = await window.__OPENWORK_ELECTRON__?.invokeDesktop?.("openworkServerInfo");
    if (!info?.running || !info.baseUrl) return { error: "local_server_unavailable" };
    const response = await fetch(
      String(info.baseUrl).replace(/\\/+$/, "") + "/workspace/" + encodeURIComponent(${JSON.stringify(workspaceId)}) + "/opencode/session",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer " + String(info.ownerToken ?? info.clientToken ?? ""),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ title: ${JSON.stringify(sessionTitle)} }),
        signal: AbortSignal.timeout(60_000),
      },
    );
    const body = await response.json().catch(() => null);
    return { ok: response.ok, status: response.status, id: typeof body?.id === "string" ? body.id : null };
  })()`, { awaitPromise: true, timeoutMs: 90_000 });
  if (!isRecord(value) || value.ok !== true || typeof value.id !== "string") {
    throw new Error(`Creating a session outside the window failed: ${JSON.stringify(value)}`);
  }
  return value.id;
}

async function waitForWorkspaceListLoaded(desktopApp: DesktopHandle, workspaceId: string): Promise<void> {
  await eventually(() => readRouteSlice(desktopApp), {
    within: 90_000,
    intervalMs: 250,
    label: `workspace ${workspaceId} session list loaded`,
    until: (route) => {
      const workspace = route.workspaces.find((item) => item.id === workspaceId);
      return Boolean(workspace) && workspace?.loading === false && workspace?.error === null;
    },
  });
}

/** The sidebar only renders its workspace rows on a desktop-width viewport. */
async function useDesktopViewport(desktopApp: DesktopHandle): Promise<void> {
  await desktopApp.client.send("Emulation.setDeviceMetricsOverride", {
    width: 1_400,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await eventually(() => evalIn(desktopApp, "window.innerWidth"), {
    within: 15_000,
    intervalMs: 100,
    label: "desktop-width viewport",
    until: (value) => value === 1_400,
  });
}

/** Sidebar groups only auto-expand on selection; open the group so its rows render. */
async function expandSidebarWorkspace(desktopApp: DesktopHandle, workspaceId: string): Promise<void> {
  const toggleExpression = `(() => {
    const row = document.querySelector("[data-sidebar-workspace-id=" + JSON.stringify(${JSON.stringify(workspaceId)}) + "]");
    const toggle = row?.querySelector("[data-sidebar-workspace-toggle]");
    if (!toggle) return "missing";
    return toggle.getAttribute("aria-expanded");
  })()`;
  const state = await evalIn(desktopApp, toggleExpression);
  if (state === "true") return;
  if (state !== "false") {
    const diagnostics = await evalIn(desktopApp, `(() => ({
      innerWidth: window.innerWidth,
      workspaceRows: Array.from(document.querySelectorAll("[data-sidebar-workspace-id]")).map((row) => row.getAttribute("data-sidebar-workspace-id")),
      toggles: document.querySelectorAll("[data-sidebar-workspace-toggle]").length,
      rowHtml: document.querySelector("[data-sidebar-workspace-id=" + JSON.stringify(${JSON.stringify(workspaceId)}) + "]")?.outerHTML.slice(0, 1200) ?? null,
    }))()`);
    throw new Error(`Sidebar expand toggle for ${workspaceId} was unavailable: ${JSON.stringify(state)} ${JSON.stringify(diagnostics)}`);
  }
  await evalIn(desktopApp, `(() => {
    const row = document.querySelector("[data-sidebar-workspace-id=" + JSON.stringify(${JSON.stringify(workspaceId)}) + "]");
    row?.querySelector("[data-sidebar-workspace-toggle]")?.click();
    return true;
  })()`);
  await eventually(() => evalIn(desktopApp, toggleExpression), {
    within: 15_000,
    intervalMs: 100,
    label: `sidebar group ${workspaceId} expanded`,
    until: (value) => value === "true",
  });
}

async function selectWorkspace(desktopApp: DesktopHandle, workspaceId: string): Promise<void> {
  await go(desktopApp, `/workspace/${encodeURIComponent(workspaceId)}/session`);
  await eventually(() => readRouteSlice(desktopApp), {
    within: 60_000,
    intervalMs: 250,
    label: `workspace ${workspaceId} selected`,
    until: (route) => route.selectedWorkspaceId === workspaceId,
  });
}

async function expectStillHidden(desktopApp: DesktopHandle, workspaceId: string, sessionId: string): Promise<void> {
  const deadline = Date.now() + STALE_OBSERVATION_MS;
  while (Date.now() < deadline) {
    const [uiSessions, rows] = await Promise.all([listUiSessions(desktopApp), sidebarSessionIds(desktopApp, workspaceId)]);
    expect(uiSessions.map((session) => session.sessionId)).not.toContain(sessionId);
    expect(rows).not.toContain(sessionId);
    await sleep(250);
  }
}

test.skipIf(!e2eTestsEnabled)(title, { timeout: 15 * 60_000 }, async ({ evidence }) => {
  needs({ optIn: ["OPENWORK_EVAL_E2E_TESTS"] });
  const profileDir = `/tmp/openwork-sidebar-external-sessions-${process.pid}-${Date.now()}`;
  const provisioned = daytonaEnabled
    ? await provisionDesktopSandbox({
        ref: process.env.OPENWORK_EVAL_REF?.trim() || process.env.GITHUB_SHA?.trim() || "dev",
        name: "sidebar-external-sessions",
        reuse: process.env.OPENWORK_EVAL_DAYTONA_SANDBOX?.trim(),
        log: (line) => console.error(`[openwork/testkit] ${line}`),
      })
    : null;
  const host = provisioned ? daytonaSandbox(provisioned.sandbox) : localHost();

  try {
    let homeId = "";
    {
      await using seededApp = await desktop({ name: "sidebar-external-sessions-seed", host, profileDir });
      homeId = await seedHomeWorkspace(seededApp, profileDir);
    }

    await using desktopApp = await desktop({ name: "sidebar-external-sessions", host, profileDir });
    await useDesktopViewport(desktopApp);
    await waitForWorkspaceListLoaded(desktopApp, homeId);

    // Mirror the incident: a second workspace is registered through the
    // control surface while the user keeps working in the first one.
    const otherId = await createWorkspace(desktopApp, `${profileDir}/other`);
    await selectWorkspace(desktopApp, homeId);
    await waitForWorkspaceListLoaded(desktopApp, otherId);
    await expandSidebarWorkspace(desktopApp, otherId);
    const routeBefore = await readRouteSlice(desktopApp);
    const homeName = routeBefore.workspaces.find((workspace) => workspace.id === homeId)?.name ?? "";
    const otherName = routeBefore.workspaces.find((workspace) => workspace.id === otherId)?.name ?? "";
    expect(homeName).not.toBe("");
    expect(otherName).not.toBe("");
    expect(otherName).not.toBe(homeName);
    const homeSessionsBefore = (await listUiSessions(desktopApp)).filter((session) => session.workspace === homeName).map((session) => session.sessionId);
    await sleep(EMPTY_LIST_RETRY_SETTLE_MS);

    // --- Path 1: an explicit reload request, as issued by session.create. ---
    const reloadedTitle = "External session surfaced by reload";
    const reloadedId = await createSessionOutsideWindow(desktopApp, otherId, reloadedTitle);
    await expectStillHidden(desktopApp, otherId, reloadedId);

    await control(desktopApp, "workspace.reload_sessions", { workspaceId: otherId }, { timeoutMs: 60_000 });
    const afterReload = await eventually(() => listUiSessions(desktopApp), {
      within: 30_000,
      intervalMs: 250,
      label: "reloaded workspace lists the external session",
      until: (sessions) => sessions.some((session) => session.sessionId === reloadedId),
    });
    const reloadedEntry = afterReload.find((session) => session.sessionId === reloadedId);
    expect(reloadedEntry?.title).toBe(reloadedTitle);
    expect(reloadedEntry?.workspace).toBe(otherName);
    expect(await sidebarSessionIds(desktopApp, otherId)).toContain(reloadedId);
    const routeAfterReload = await readRouteSlice(desktopApp);
    expect(routeAfterReload.selectedWorkspaceId).toBe(homeId);
    expect(afterReload.filter((session) => session.workspace === homeName).map((session) => session.sessionId)).toEqual(homeSessionsBefore);
    evidence.recordAssertionEvidence(
      "workspace.reload_sessions surfaces a session created outside the window without selecting its workspace",
      `Session ${reloadedId} was absent for ${STALE_OBSERVATION_MS}ms, then appeared under ${otherId} with its title after the reload; the selection stayed on ${homeId} and Home's ${homeSessionsBefore.length} session(s) were unchanged.`,
      true,
    );

    // --- Path 2: selecting the workspace refetches its list. ---
    const selectedTitle = "External session surfaced by selection";
    const selectedId = await createSessionOutsideWindow(desktopApp, otherId, selectedTitle);
    await expectStillHidden(desktopApp, otherId, selectedId);

    await selectWorkspace(desktopApp, otherId);
    const afterSelect = await eventually(() => listUiSessions(desktopApp), {
      within: 30_000,
      intervalMs: 250,
      label: "selected workspace lists the external session",
      until: (sessions) => sessions.some((session) => session.sessionId === selectedId),
    });
    const selectedEntry = afterSelect.find((session) => session.sessionId === selectedId);
    expect(selectedEntry?.title).toBe(selectedTitle);
    expect(selectedEntry?.workspace).toBe(otherName);
    const otherRows = await sidebarSessionIds(desktopApp, otherId);
    expect(otherRows).toContain(selectedId);
    expect(otherRows).toContain(reloadedId);
    expect(afterSelect.filter((session) => session.workspace === homeName).map((session) => session.sessionId)).toEqual(homeSessionsBefore);
    evidence.recordAssertionEvidence(
      "Selecting a workspace refetches its session list and reveals sessions created outside the window",
      `Session ${selectedId} was absent for ${STALE_OBSERVATION_MS}ms while ${homeId} was selected, then appeared under ${otherId} once it was selected; the earlier session ${reloadedId} stayed listed and Home's list was unchanged.`,
      true,
    );
  } finally {
    try {
      await host[Symbol.asyncDispose]();
    } finally {
      if (provisioned) {
        try {
          await checkedExec(
            defaultDaytonaExec,
            ["exec", provisioned.sandbox, "--", "rm", "-rf", profileDir],
            `remove caller-owned sidebar-external-sessions profile ${profileDir}`,
            { timeoutMs: 30_000 },
          );
        } finally {
          if (provisioned.created) await deleteSandboxes([provisioned.sandbox]);
        }
      } else {
        await rm(profileDir, { recursive: true, force: true });
      }
    }
  }
});
