import { expect } from "vitest";
import { control, createAndSelectWorkspace, evalIn, seedSessions, waitFor } from "@openwork/behaviors";
import type { Surface } from "@openwork/cdp";
import { screenshot, validate } from "@openwork/test-evidence";
import { desktop } from "@openwork/hosts";
import { eventually, needs, test } from "@openwork/testkit";

const e2eTestsEnabled = process.env.OPENWORK_EVAL_E2E_TESTS === "1";
const title = e2eTestsEnabled
  ? "the sidebar archive affordance archives and restores the intended session in its own workspace"
  : "session archive button skipped — needs: set OPENWORK_EVAL_E2E_TESTS=1";

type SessionCandidate = {
  workspaceId: string;
  sessionId: string;
  title: string;
};

type ListedSession = {
  sessionId: string;
  title: string;
  workspace: string;
};

type WorkspaceSessionState = {
  sessionId: string;
  title: string;
  archivedAt: number;
};

type SidebarFacts = {
  activeSessionIds: string[];
  archivedSessionIds: string[];
  archivedExpanded: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseListedSessions(value: unknown): ListedSession[] {
  if (!Array.isArray(value)) {
    throw new Error(`session.list_sessions did not return a list: ${JSON.stringify(value)}`);
  }
  return value.map((entry) => {
    if (
      !isRecord(entry)
      || typeof entry.sessionId !== "string"
      || typeof entry.title !== "string"
      || typeof entry.workspace !== "string"
    ) {
      throw new Error(`session.list_sessions returned a malformed entry: ${JSON.stringify(entry)}`);
    }
    return { sessionId: entry.sessionId, title: entry.title, workspace: entry.workspace };
  });
}

function parseWorkspaceSessionStates(value: unknown): WorkspaceSessionState[] {
  if (!Array.isArray(value)) {
    throw new Error(`Workspace session listing did not return a list: ${JSON.stringify(value)}`);
  }
  return value.map((entry) => {
    if (
      !isRecord(entry)
      || typeof entry.sessionId !== "string"
      || typeof entry.title !== "string"
      || typeof entry.archivedAt !== "number"
    ) {
      throw new Error(`Workspace session listing returned a malformed entry: ${JSON.stringify(entry)}`);
    }
    return { sessionId: entry.sessionId, title: entry.title, archivedAt: entry.archivedAt };
  });
}

function parseSidebarFacts(value: unknown): SidebarFacts {
  if (!isRecord(value) || !Array.isArray(value.activeSessionIds) || !Array.isArray(value.archivedSessionIds)) {
    throw new Error(`Sidebar facts were malformed: ${JSON.stringify(value)}`);
  }
  const activeSessionIds = value.activeSessionIds.filter((entry): entry is string => typeof entry === "string");
  const archivedSessionIds = value.archivedSessionIds.filter((entry): entry is string => typeof entry === "string");
  if (
    activeSessionIds.length !== value.activeSessionIds.length
    || archivedSessionIds.length !== value.archivedSessionIds.length
    || typeof value.archivedExpanded !== "boolean"
  ) {
    throw new Error(`Sidebar facts contained invalid fields: ${JSON.stringify(value)}`);
  }
  return { activeSessionIds, archivedSessionIds, archivedExpanded: value.archivedExpanded };
}

async function activeWorkspaceId(app: Surface): Promise<string> {
  const value = await evalIn(app, `localStorage.getItem("openwork.react.activeWorkspace") ?? ""`);
  if (typeof value !== "string" || !value) {
    throw new Error(`The selected workspace was unavailable: ${JSON.stringify(value)}`);
  }
  return value;
}

async function readListedSessions(app: Surface): Promise<ListedSession[]> {
  return parseListedSessions(await control(app, "session.list_sessions"));
}

/**
 * session.list_sessions identifies sessions across workspaces but does not
 * expose time.archived, so inspect the same native session list through each
 * workspace-scoped OpenWork server endpoint for the archived timestamp.
 */
async function readWorkspaceSessionStates(app: Surface, workspaceId: string): Promise<WorkspaceSessionState[]> {
  const value = await evalIn(app, `(async () => {
    const info = await window.__OPENWORK_ELECTRON__?.invokeDesktop?.("openworkServerInfo");
    if (!info?.running || !info.baseUrl) throw new Error("OpenWork server is unavailable");
    const response = await fetch(
      String(info.baseUrl).replace(/\\/+$/, "")
        + "/workspace/" + encodeURIComponent(${JSON.stringify(workspaceId)})
        + "/opencode/session?limit=200",
      {
        headers: { Authorization: "Bearer " + String(info.ownerToken ?? info.clientToken ?? "") },
        signal: AbortSignal.timeout(15000),
      },
    );
    if (!response.ok) throw new Error("Workspace session listing failed with HTTP " + response.status);
    const body = await response.json();
    if (!Array.isArray(body)) throw new Error("Workspace session listing was not an array");
    return body.map((session) => ({
      sessionId: typeof session?.id === "string" ? session.id : "",
      title: typeof session?.title === "string" ? session.title : "",
      archivedAt: typeof session?.time?.archived === "number" ? session.time.archived : 0,
    }));
  })()`, { awaitPromise: true, timeoutMs: 20_000 });
  return parseWorkspaceSessionStates(value);
}

async function waitForWorkspaceSessionStates(
  app: Surface,
  workspaceId: string,
  label: string,
  until: (states: WorkspaceSessionState[]) => boolean,
): Promise<WorkspaceSessionState[]> {
  return eventually(() => readWorkspaceSessionStates(app, workspaceId), {
    within: 60_000,
    intervalMs: 500,
    label,
    until,
  });
}

function stateFor(states: WorkspaceSessionState[], candidate: SessionCandidate): WorkspaceSessionState {
  const state = states.find((entry) => entry.sessionId === candidate.sessionId);
  if (!state) throw new Error(`${candidate.title} was absent from its workspace session listing.`);
  return state;
}

function activeRowSelector(candidate: SessionCandidate): string {
  return `[data-sidebar-workspace-id="${candidate.workspaceId}"] [data-sidebar-session-id="${candidate.sessionId}"]`;
}

function archivedRowSelector(candidate: SessionCandidate): string {
  return `[data-global-archived-sessions] [data-sidebar-session-id="${candidate.sessionId}"][data-sidebar-session-workspace-id="${candidate.workspaceId}"]`;
}

async function ensureActiveSessionRowVisible(app: Surface, candidate: SessionCandidate): Promise<void> {
  const selector = activeRowSelector(candidate);
  const visible = await evalIn(app, `(() => {
    const row = document.querySelector(${JSON.stringify(selector)});
    return row instanceof HTMLElement && row.getClientRects().length > 0;
  })()`);
  if (visible !== true) {
    const clicked = await evalIn(app, `(() => {
      const workspace = document.querySelector(${JSON.stringify(`[data-sidebar-workspace-id="${candidate.workspaceId}"]`)});
      const button = [...(workspace?.querySelectorAll("button") ?? [])]
        .find((entry) => entry.getAttribute("aria-label") === "Expand");
      if (!(button instanceof HTMLButtonElement)) return false;
      button.click();
      return true;
    })()`);
    expect(clicked, `expand workspace containing ${candidate.title}`).toBe(true);
  }
  await waitFor(app, `(() => {
    const row = document.querySelector(${JSON.stringify(selector)});
    return row instanceof HTMLElement && row.getClientRects().length > 0;
  })()`, {
    timeoutMs: 30_000,
    label: `active sidebar row for ${candidate.title}`,
  });
}

async function clickArchiveQuickAction(
  app: Surface,
  candidate: SessionCandidate,
  actionLabel: "Archive session" | "Unarchive session",
): Promise<void> {
  const rowSelector = actionLabel === "Archive session"
    ? activeRowSelector(candidate)
    : archivedRowSelector(candidate);
  const buttonSelector = `[data-session-hover-actions] button[aria-label="${actionLabel}"]`;
  await waitFor(app, `(() => {
    const row = document.querySelector(${JSON.stringify(rowSelector)});
    return row?.querySelector(${JSON.stringify(buttonSelector)}) instanceof HTMLButtonElement;
  })()`, {
    timeoutMs: 30_000,
    label: `${actionLabel} quick action for ${candidate.title}`,
  });
  const clicked = await evalIn(app, `(() => {
    const row = document.querySelector(${JSON.stringify(rowSelector)});
    const button = row?.querySelector(${JSON.stringify(buttonSelector)});
    if (!(row instanceof HTMLElement) || !(button instanceof HTMLButtonElement)) return false;
    row.scrollIntoView({ block: "center" });
    button.click();
    return true;
  })()`);
  expect(clicked, `${actionLabel} quick action for ${candidate.title}`).toBe(true);
}

async function expandArchivedSection(app: Surface, candidate: SessionCandidate): Promise<void> {
  await waitFor(app, `Boolean(document.querySelector("[data-global-archived-sessions]"))`, {
    timeoutMs: 30_000,
    label: "Archived sidebar section",
  });
  await evalIn(app, `(() => {
    const section = document.querySelector("[data-global-archived-sessions]");
    const trigger = section?.querySelector("button");
    if (!(trigger instanceof HTMLButtonElement)) return false;
    if (trigger.getAttribute("aria-expanded") !== "true") trigger.click();
    return true;
  })()`);
  await waitFor(app, `(() => {
    const section = document.querySelector("[data-global-archived-sessions]");
    const trigger = section?.querySelector("button");
    const row = document.querySelector(${JSON.stringify(archivedRowSelector(candidate))});
    return trigger?.getAttribute("aria-expanded") === "true"
      && row instanceof HTMLElement
      && row.getClientRects().length > 0;
  })()`, {
    timeoutMs: 30_000,
    label: `${candidate.title} visible in expanded Archived section`,
  });
}

async function readSidebarFacts(app: Surface, workspaceId: string): Promise<SidebarFacts> {
  const value = await evalIn(app, `(() => {
    const visibleIds = (root) => [...(root?.querySelectorAll("[data-sidebar-session-id]") ?? [])]
      .filter((entry) => entry instanceof HTMLElement && entry.getClientRects().length > 0)
      .map((entry) => entry.getAttribute("data-sidebar-session-id"))
      .filter(Boolean);
    const activeRoot = document.querySelector(${JSON.stringify(`[data-sidebar-workspace-id="${workspaceId}"]`)});
    const archivedRoot = document.querySelector("[data-global-archived-sessions]");
    return {
      activeSessionIds: visibleIds(activeRoot),
      archivedSessionIds: visibleIds(archivedRoot),
      archivedExpanded: archivedRoot?.querySelector("button")?.getAttribute("aria-expanded") === "true",
    };
  })()`);
  return parseSidebarFacts(value);
}

async function waitForSidebarFacts(
  app: Surface,
  workspaceId: string,
  expected: {
    active: string[];
    inactive: string[];
    archived: string[];
    notArchived: string[];
  },
  label: string,
): Promise<SidebarFacts> {
  await waitFor(app, `(() => {
    const visibleIds = (root) => [...(root?.querySelectorAll("[data-sidebar-session-id]") ?? [])]
      .filter((entry) => entry instanceof HTMLElement && entry.getClientRects().length > 0)
      .map((entry) => entry.getAttribute("data-sidebar-session-id"))
      .filter(Boolean);
    const activeRoot = document.querySelector(${JSON.stringify(`[data-sidebar-workspace-id="${workspaceId}"]`)});
    const archivedRoot = document.querySelector("[data-global-archived-sessions]");
    const activeIds = new Set(visibleIds(activeRoot));
    const archivedIds = new Set(visibleIds(archivedRoot));
    const expected = ${JSON.stringify(expected)};
    return expected.active.every((id) => activeIds.has(id))
      && expected.inactive.every((id) => !activeIds.has(id))
      && expected.archived.every((id) => archivedIds.has(id))
      && expected.notArchived.every((id) => !archivedIds.has(id));
  })()`, { timeoutMs: 30_000, label });
  return readSidebarFacts(app, workspaceId);
}

test.skipIf(!e2eTestsEnabled)(title, { timeout: 12 * 60_000 }, async ({ evidence }) => {
  needs({ optIn: ["OPENWORK_EVAL_E2E_TESTS"] });

  await using app = await desktop({ name: "session-archive-button" });
  const stamp = `${Date.now()}-${process.pid}`;
  const workspaceB = await createAndSelectWorkspace(app, {
    path: `/tmp/openwork-session-archive-${stamp}-b`,
  });
  const [seededB1] = await seedSessions(app, [`Archive B1 ${stamp}`]);
  if (!seededB1) throw new Error("Workspace B session was not created.");
  const sessionB1: SessionCandidate = { ...seededB1, workspaceId: workspaceB.workspaceId };

  await control(app, "workspace.create", {
    path: `/tmp/openwork-session-archive-${stamp}-a`,
  }, { timeoutMs: 90_000 });
  await waitFor(app, `(localStorage.getItem("openwork.react.activeWorkspace") ?? "") !== ""
    && (localStorage.getItem("openwork.react.activeWorkspace") ?? "") !== ${JSON.stringify(workspaceB.workspaceId)}`, {
    timeoutMs: 120_000,
    label: "workspace A selected after creation",
  });
  const workspaceAId = await activeWorkspaceId(app);
  const [seededA1, seededA2] = await seedSessions(app, [
    `Archive A1 ${stamp}`,
    `Archive A2 ${stamp}`,
  ]);
  if (!seededA1 || !seededA2) throw new Error("Workspace A sessions were not created.");
  const sessionA1: SessionCandidate = { ...seededA1, workspaceId: workspaceAId };
  const sessionA2: SessionCandidate = { ...seededA2, workspaceId: workspaceAId };

  await ensureActiveSessionRowVisible(app, sessionA1);
  await ensureActiveSessionRowVisible(app, sessionA2);
  expect(await activeWorkspaceId(app)).toBe(workspaceAId);

  const baselineListing = await readListedSessions(app);
  const listedA1 = baselineListing.find((entry) => entry.sessionId === sessionA1.sessionId);
  const listedA2 = baselineListing.find((entry) => entry.sessionId === sessionA2.sessionId);
  const listedB1 = baselineListing.find((entry) => entry.sessionId === sessionB1.sessionId);
  expect(listedA1?.title).toBe(sessionA1.title);
  expect(listedA2?.title).toBe(sessionA2.title);
  expect(listedB1?.title).toBe(sessionB1.title);
  expect(listedA1?.workspace).toBe(listedA2?.workspace);
  expect(listedA1?.workspace).not.toBe(listedB1?.workspace);

  const baselineA = await waitForWorkspaceSessionStates(
    app,
    workspaceAId,
    "unarchived workspace A baseline",
    (states) => [sessionA1, sessionA2].every((candidate) => {
      const state = states.find((entry) => entry.sessionId === candidate.sessionId);
      return state?.archivedAt === 0;
    }),
  );
  expect(stateFor(baselineA, sessionA1).archivedAt).toBe(0);
  expect(stateFor(baselineA, sessionA2).archivedAt).toBe(0);

  // Claim 1: archiving A1 through its sidebar quick action moves only A1.
  await clickArchiveQuickAction(app, sessionA1, "Archive session");
  const archivedA = await waitForWorkspaceSessionStates(
    app,
    workspaceAId,
    "A1 archived while A2 remains active",
    (states) => {
      const a1 = states.find((entry) => entry.sessionId === sessionA1.sessionId);
      const a2 = states.find((entry) => entry.sessionId === sessionA2.sessionId);
      return typeof a1?.archivedAt === "number" && a1.archivedAt > 0 && a2?.archivedAt === 0;
    },
  );
  await expandArchivedSection(app, sessionA1);
  const archiveSidebar = await waitForSidebarFacts(app, workspaceAId, {
    active: [sessionA2.sessionId],
    inactive: [sessionA1.sessionId],
    archived: [sessionA1.sessionId],
    notArchived: [sessionA2.sessionId],
  }, "A1 leaves workspace A's active tree and only A1 appears in Archived");
  const archiveListing = await readListedSessions(app);
  expect(stateFor(archivedA, sessionA1).archivedAt).toBeGreaterThan(0);
  expect(stateFor(archivedA, sessionA2).archivedAt).toBe(0);
  expect(archiveSidebar.activeSessionIds).not.toContain(sessionA1.sessionId);
  expect(archiveSidebar.archivedSessionIds).toContain(sessionA1.sessionId);
  expect(archiveSidebar.activeSessionIds).toContain(sessionA2.sessionId);
  expect(archiveSidebar.archivedSessionIds).not.toContain(sessionA2.sessionId);
  expect(archiveListing.some((entry) => entry.sessionId === sessionA1.sessionId)).toBe(true);
  expect(archiveListing.some((entry) => entry.sessionId === sessionA2.sessionId)).toBe(true);
  evidence.recordAssertionEvidence(
    "Archiving a selected-workspace session moves only that session into Archived",
    `A1 archivedAt=${stateFor(archivedA, sessionA1).archivedAt}; A2 archivedAt=${stateFor(archivedA, sessionA2).archivedAt}; sidebar=${JSON.stringify(archiveSidebar)}.`,
    true,
  );

  {
    const shot = await screenshot(app);
    const seen = await validate(shot, [
      `The expanded Archived section contains the session titled ${sessionA1.title}`,
      `The workspace session list still contains the active session titled ${sessionA2.title}`,
      "No error dialog or crash message is visible",
    ]);
    expect(seen.ok, seen.why).toBe(true);
  }

  // Claim 2: the same affordance restores A1 without changing A2.
  await clickArchiveQuickAction(app, sessionA1, "Unarchive session");
  const restoredA = await waitForWorkspaceSessionStates(
    app,
    workspaceAId,
    "A1 and A2 both active after unarchive",
    (states) => [sessionA1, sessionA2].every((candidate) => {
      const state = states.find((entry) => entry.sessionId === candidate.sessionId);
      return state?.archivedAt === 0;
    }),
  );
  const restoredSidebar = await waitForSidebarFacts(app, workspaceAId, {
    active: [sessionA1.sessionId, sessionA2.sessionId],
    inactive: [],
    archived: [],
    notArchived: [sessionA1.sessionId, sessionA2.sessionId],
  }, "A1 and A2 converge in workspace A's active tree after unarchive");
  expect(stateFor(restoredA, sessionA1).archivedAt).toBe(0);
  expect(stateFor(restoredA, sessionA2).archivedAt).toBe(0);
  expect(restoredSidebar.activeSessionIds).toContain(sessionA1.sessionId);
  expect(restoredSidebar.activeSessionIds).toContain(sessionA2.sessionId);
  expect(restoredSidebar.archivedSessionIds).not.toContain(sessionA1.sessionId);
  expect(restoredSidebar.archivedSessionIds).not.toContain(sessionA2.sessionId);
  evidence.recordAssertionEvidence(
    "Unarchiving restores the intended session and leaves its neighbor untouched",
    `A1 archivedAt=${stateFor(restoredA, sessionA1).archivedAt}; A2 archivedAt=${stateFor(restoredA, sessionA2).archivedAt}; sidebar=${JSON.stringify(restoredSidebar)}.`,
    true,
  );

  // Claim 3: a row from workspace B must archive against B even while A stays selected.
  await ensureActiveSessionRowVisible(app, sessionB1);
  expect(await activeWorkspaceId(app)).toBe(workspaceAId);
  await clickArchiveQuickAction(app, sessionB1, "Archive session");

  const unchangedA = await waitForWorkspaceSessionStates(
    app,
    workspaceAId,
    "workspace A remains unarchived after archiving B1",
    (states) => states.length >= 2 && states.every((state) => state.archivedAt === 0),
  );
  expect(unchangedA.every((state) => state.archivedAt === 0)).toBe(true);
  expect(stateFor(unchangedA, sessionA1).archivedAt).toBe(0);
  expect(stateFor(unchangedA, sessionA2).archivedAt).toBe(0);
  expect(await activeWorkspaceId(app)).toBe(workspaceAId);

  const archivedB = await waitForWorkspaceSessionStates(
    app,
    workspaceB.workspaceId,
    "B1 archived in workspace B while workspace A remains selected",
    (states) => {
      const b1 = states.find((entry) => entry.sessionId === sessionB1.sessionId);
      return typeof b1?.archivedAt === "number" && b1.archivedAt > 0;
    },
  );
  await expandArchivedSection(app, sessionB1);
  const crossWorkspaceSidebar = await waitForSidebarFacts(app, workspaceB.workspaceId, {
    active: [],
    inactive: [sessionB1.sessionId],
    archived: [sessionB1.sessionId],
    notArchived: [sessionA1.sessionId, sessionA2.sessionId],
  }, "B1 leaves workspace B's active tree and only B1 appears in Archived");
  expect(stateFor(archivedB, sessionB1).archivedAt).toBeGreaterThan(0);
  expect(crossWorkspaceSidebar.activeSessionIds).not.toContain(sessionB1.sessionId);
  expect(crossWorkspaceSidebar.archivedSessionIds).toContain(sessionB1.sessionId);
  evidence.recordAssertionEvidence(
    "A cross-workspace archive click mutates the row's workspace, not the selected workspace",
    `Selected workspace remained ${workspaceAId}; B1 archivedAt=${stateFor(archivedB, sessionB1).archivedAt}; A1/A2 archivedAt=${stateFor(unchangedA, sessionA1).archivedAt}/${stateFor(unchangedA, sessionA2).archivedAt}.`,
    true,
  );
});
