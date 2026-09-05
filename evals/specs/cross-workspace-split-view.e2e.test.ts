import { expect } from "vitest";
import { control, evalIn, go, waitFor } from "@openwork/behaviors";
import type { Surface } from "@openwork/cdp";
import { screenshot } from "@openwork/test-evidence";
import { spec, sleep } from "@openwork/testkit";
import type { User } from "@openwork/testkit";
import { bootCrossWorkspaceSplitView } from "../../worlds/cross-workspace-split-view.ts";

const test = spec.world(async (_seed, { place }) => {
  const stack = new AsyncDisposableStack();
  const runId = `${Date.now().toString(36)}-${process.pid}`;
  try {
    const world = await bootCrossWorkspaceSplitView(stack, place, {
      adminEmail: `split-view-admin-${runId}@openwork.test`,
      workspacePath: `/tmp/openwork-cross-workspace-split-${runId}-a`,
      sessionTitles: [`Primary workspace anchor ${runId}`, `Primary workspace peer ${runId}`],
    });
    return { ...world, app: world.desktop, runId, [Symbol.asyncDispose]: () => stack.disposeAsync() };
  } catch (error) {
    await stack.disposeAsync();
    throw error;
  }
}, { timeout: 600_000 });

type WorkspaceListing = {
  ids: string[];
  activeId: string | null;
};

type SplitCandidate = {
  workspaceId: string;
  sessionId: string;
  title: string;
};

type SplitFacts = {
  layout: string;
  primarySessionId: string;
  secondarySessionId: string;
  primaryLayoutWorkspaceId: string;
  secondaryLayoutWorkspaceId: string;
  primaryPaneWorkspaceId: string;
  secondaryPaneWorkspaceId: string;
  primarySurfaceWorkspaceId: string;
  secondarySurfaceWorkspaceId: string;
  primaryWorkspaceName: string;
  secondaryWorkspaceName: string;
  primaryResourceWorkspaceId: string;
  secondaryResourceWorkspaceId: string;
  primaryOwnsSecondarySurface: boolean;
  secondaryOwnsPrimarySurface: boolean;
  primaryUnavailable: boolean;
  secondaryUnavailable: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseWorkspaceListing(value: unknown): WorkspaceListing {
  if (!isRecord(value) || value.ok !== true || !Array.isArray(value.ids)) {
    throw new Error(`Invalid workspace listing: ${JSON.stringify(value)}`);
  }
  return {
    ids: value.ids.filter((id): id is string => typeof id === "string"),
    activeId: typeof value.activeId === "string" ? value.activeId : null,
  };
}

function parseSplitFacts(value: unknown): SplitFacts {
  if (!isRecord(value)) throw new Error(`Invalid split facts: ${JSON.stringify(value)}`);
  const text = (key: string) => typeof value[key] === "string" ? value[key] : "";
  return {
    layout: text("layout"),
    primarySessionId: text("primarySessionId"),
    secondarySessionId: text("secondarySessionId"),
    primaryLayoutWorkspaceId: text("primaryLayoutWorkspaceId"),
    secondaryLayoutWorkspaceId: text("secondaryLayoutWorkspaceId"),
    primaryPaneWorkspaceId: text("primaryPaneWorkspaceId"),
    secondaryPaneWorkspaceId: text("secondaryPaneWorkspaceId"),
    primarySurfaceWorkspaceId: text("primarySurfaceWorkspaceId"),
    secondarySurfaceWorkspaceId: text("secondarySurfaceWorkspaceId"),
    primaryWorkspaceName: text("primaryWorkspaceName"),
    secondaryWorkspaceName: text("secondaryWorkspaceName"),
    primaryResourceWorkspaceId: text("primaryResourceWorkspaceId"),
    secondaryResourceWorkspaceId: text("secondaryResourceWorkspaceId"),
    primaryOwnsSecondarySurface: value.primaryOwnsSecondarySurface === true,
    secondaryOwnsPrimarySurface: value.secondaryOwnsPrimarySurface === true,
    primaryUnavailable: value.primaryUnavailable === true,
    secondaryUnavailable: value.secondaryUnavailable === true,
  };
}

async function listWorkspaces(app: Surface): Promise<WorkspaceListing> {
  return parseWorkspaceListing(await evalIn(app, `(async () => {
    const info = await window.__OPENWORK_ELECTRON__?.invokeDesktop?.("openworkServerInfo");
    if (!info?.running || !info.baseUrl) return { ok: false, ids: [], activeId: null };
    const response = await fetch(String(info.baseUrl).replace(/\\\/+$/, "") + "/workspaces", {
      headers: { Authorization: "Bearer " + String(info.ownerToken ?? info.clientToken ?? "") },
      signal: AbortSignal.timeout(15000),
    });
    const body = await response.json();
    const items = Array.isArray(body?.items) ? body.items : [];
    return {
      ok: response.ok,
      ids: items.map((item) => String(item?.id ?? "")).filter(Boolean),
      activeId: typeof body?.activeId === "string" ? body.activeId : null,
    };
  })()`, { awaitPromise: true, timeoutMs: 20_000 }));
}

async function createWorkspace(app: Surface, path: string): Promise<string> {
  const before = await listWorkspaces(app);
  await control(app, "workspace.create", { path }, { timeoutMs: 90_000 });
  await waitFor(app, `(() => {
    const active = localStorage.getItem("openwork.react.activeWorkspace") ?? "";
    return Boolean(active) && active !== ${JSON.stringify(before.activeId ?? "")};
  })()`, { timeoutMs: 90_000, label: `workspace ${path} selected` });
  const after = await listWorkspaces(app);
  const created = after.ids.find((id) => !before.ids.includes(id)) ?? after.activeId;
  if (!created) throw new Error(`workspace.create produced no workspace id for ${path}`);
  return created;
}

async function createSessionInWorkspace(app: Surface, workspaceId: string, title: string): Promise<SplitCandidate> {
  await go(app, `/workspace/${workspaceId}/session`, { timeoutMs: 60_000 });
  await waitFor(app, `(localStorage.getItem("openwork.react.activeWorkspace") ?? "") === ${JSON.stringify(workspaceId)}`, {
    timeoutMs: 60_000,
    label: `workspace ${workspaceId} active before creating ${title}`,
  });
  const deadline = Date.now() + 90_000;
  let created: unknown = null;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      created = await control(app, "session.create_task", undefined, { timeoutMs: 30_000 });
      if (typeof created === "string" && created.startsWith("ses_")) break;
      lastError = new Error(`session.create_task returned ${JSON.stringify(created)}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(500);
  }
  if (typeof created !== "string" || !created.startsWith("ses_")) {
    const detail = lastError instanceof Error ? lastError.message : String(lastError);
    throw new Error(`session.create_task did not return a session id for ${title}: ${detail}`);
  }
  await control(app, "session.rename", { sessionId: created, title }, { timeoutMs: 30_000 });
  const candidate = { workspaceId, sessionId: created, title };
  await waitForSessionRow(app, candidate);
  return candidate;
}

async function waitForSessionRow(app: Surface, candidate: SplitCandidate): Promise<void> {
  await waitFor(app, `Boolean(document.querySelector(${JSON.stringify(
    `[data-sidebar-session-id="${candidate.sessionId}"][data-sidebar-session-workspace-id="${candidate.workspaceId}"]`,
  )}))`, {
    timeoutMs: 60_000,
    label: `sidebar row for ${candidate.title}`,
  });
}

async function openSessionRoute(app: Surface, candidate: SplitCandidate): Promise<void> {
  await go(app, `/workspace/${candidate.workspaceId}/session/${candidate.sessionId}`, { timeoutMs: 60_000 });
  await waitFor(app, `(() => {
    const surface = document.querySelector("[data-session-surface-id]");
    return (localStorage.getItem("openwork.react.activeWorkspace") ?? "") === ${JSON.stringify(candidate.workspaceId)}
      && surface?.getAttribute("data-session-surface-id") === ${JSON.stringify(candidate.sessionId)};
  })()`, { timeoutMs: 60_000, label: `visible session ${candidate.title}` });
}

async function openContextMenuForSession(app: Surface, user: User, candidate: SplitCandidate): Promise<void> {
  await user.press("Escape");
  await user.rightClick({ text: candidate.title });
  await waitFor(app, `Boolean(document.querySelector('[role="menu"]'))`, {
    timeoutMs: 15000, label: `context menu rendered for ${candidate.title}`,
  });
}

async function splitMenuVisible(app: Surface): Promise<boolean> {
  return await evalIn(app, `Boolean(document.querySelector("[data-session-menu-open-split]"))`) === true;
}

async function clickOpenSplit(user: User): Promise<void> {
  await user.click({ role: "menuitem", label: /Open in split view/ });
}

async function closeSecondaryPane(app: Surface, user: User): Promise<void> {
  await user.click({ role: "button", label: "Close secondary split pane" });
  await waitFor(app, `!document.querySelector('[data-workbench-pane="secondary"]')`, {
    timeoutMs: 15000, label: "secondary split pane closes",
  });
}

async function openCrossWorkspaceSplitFromPalette(app: Surface, user: User, candidate: SplitCandidate): Promise<void> {
  await user.press("Escape");
  const mac = app.handle.hostKind !== "daytona" && process.platform === "darwin";
  await user.press(mac ? "Meta+K" : "Control+K");
  await user.click({ role: "option", label: /Open in split view/ });
  await user.click({ text: candidate.title });
}

async function readSplitFacts(app: Surface, primary: SplitCandidate, secondary: SplitCandidate): Promise<SplitFacts> {
  return parseSplitFacts(await evalIn(app, `(() => {
    const context = window.__openworkControl?.context?.();
    const layout = context?.conversations?.layout;
    const primaryPane = document.querySelector('[data-workbench-pane="primary"]');
    const secondaryPane = document.querySelector('[data-workbench-pane="secondary"]');
    const primarySurface = primaryPane?.querySelector('[data-session-surface-id="${primary.sessionId}"]');
    const secondarySurface = secondaryPane?.querySelector('[data-session-surface-id="${secondary.sessionId}"]');
    const resources = Array.isArray(context?.resources) ? context.resources : [];
    const primaryResource = resources.find((resource) => resource?.kind === "session"
      && resource?.state?.pane === "primary" && resource?.state?.visible === true);
    const secondaryResource = resources.find((resource) => resource?.kind === "session"
      && resource?.state?.pane === "secondary" && resource?.state?.visible === true);
    return {
      layout: layout?.kind ?? "",
      primarySessionId: layout?.primarySessionId ?? layout?.sessionId ?? "",
      secondarySessionId: layout?.secondarySessionId ?? "",
      primaryLayoutWorkspaceId: layout?.primaryWorkspaceId ?? layout?.workspaceId ?? "",
      secondaryLayoutWorkspaceId: layout?.secondaryWorkspaceId ?? "",
      primaryPaneWorkspaceId: primaryPane?.getAttribute("data-workbench-workspace-id") ?? "",
      secondaryPaneWorkspaceId: secondaryPane?.getAttribute("data-workbench-workspace-id") ?? "",
      primarySurfaceWorkspaceId: primarySurface?.getAttribute("data-session-surface-workspace-id") ?? "",
      secondarySurfaceWorkspaceId: secondarySurface?.getAttribute("data-session-surface-workspace-id") ?? "",
      primaryWorkspaceName: primaryPane?.querySelector('[data-workbench-pane-header="primary"]')
        ?.getAttribute("data-workbench-pane-workspace-name") ?? "",
      secondaryWorkspaceName: secondaryPane?.querySelector('[data-workbench-pane-header="secondary"]')
        ?.getAttribute("data-workbench-pane-workspace-name") ?? "",
      primaryResourceWorkspaceId: primaryResource?.state?.workspaceId ?? "",
      secondaryResourceWorkspaceId: secondaryResource?.state?.workspaceId ?? "",
      primaryOwnsSecondarySurface: Boolean(primaryPane?.querySelector(
        '[data-session-surface-id="${secondary.sessionId}"]',
      )),
      secondaryOwnsPrimarySurface: Boolean(secondaryPane?.querySelector(
        '[data-session-surface-id="${primary.sessionId}"]',
      )),
      primaryUnavailable: Boolean(primaryPane?.querySelector('[data-workbench-pane-unavailable]')),
      secondaryUnavailable: Boolean(secondaryPane?.querySelector('[data-workbench-pane-unavailable]')),
    };
  })()`));
}

test("same-workspace and cross-workspace split sessions retain visible ownership", async ({ world, user, evidence }) => {
    const { app, runId } = world;
    const crossWorkspaceTitle = `Secondary workspace peer ${runId}`;
    const workspaceA = app.workspaceId;
    if (!workspaceA) throw new Error("World app did not resolve a primary workspace id.");

    const seededPrimary = world.sessions[0];
    const seededSameWorkspacePeer = world.sessions[1];
    if (!seededPrimary || !seededSameWorkspacePeer) {
      throw new Error("The split-view world did not seed both primary-workspace sessions.");
    }
    const primary = { workspaceId: workspaceA, ...seededPrimary };
    const sameWorkspacePeer = { workspaceId: workspaceA, ...seededSameWorkspacePeer };
    const workspaceB = await createWorkspace(app, `/tmp/openwork-cross-workspace-split-${runId}-b`);
    const crossWorkspacePeer = await createSessionInWorkspace(app, workspaceB, crossWorkspaceTitle);
    expect(primary.workspaceId).not.toBe(crossWorkspacePeer.workspaceId);

    await openSessionRoute(app, primary);
    await waitForSessionRow(app, sameWorkspacePeer);
    await waitForSessionRow(app, crossWorkspacePeer);

    await openContextMenuForSession(app, user, sameWorkspacePeer);
    expect(await splitMenuVisible(app)).toBe(true);
    await clickOpenSplit(user);
    await waitFor(app, `Boolean(document.querySelector('[data-workbench-pane="secondary"]'))`, {
      timeoutMs: 30_000,
      label: "same-workspace secondary pane opens",
    });
    const sameWorkspaceMountDiagnostic = await evalIn(app, `(() => {
      const panes = [...document.querySelectorAll('[data-workbench-pane]')];
      return panes.map((pane) => ({
        pane: pane.getAttribute('data-workbench-pane'),
        workspaceId: pane.getAttribute('data-workbench-workspace-id'),
        surfaces: [...pane.querySelectorAll('[data-session-surface-id]')].map((surface) => ({
          sessionId: surface.getAttribute('data-session-surface-id'),
          workspaceId: surface.getAttribute('data-session-surface-workspace-id'),
        })),
        text: (pane.textContent ?? '').replace(/\\s+/g, ' ').trim().slice(0, 500),
      }));
    })()`);
    expect(
      await evalIn(app, `Boolean(document.querySelector(
        '[data-workbench-pane="secondary"] [data-session-surface-id="${sameWorkspacePeer.sessionId}"]'
      ))`),
      `same-workspace mount diagnostic: ${JSON.stringify(sameWorkspaceMountDiagnostic)}`,
    ).toBe(true);
    await waitFor(app, `Boolean(document.querySelector(
      '[data-workbench-pane="secondary"][data-workbench-workspace-id="${workspaceA}"] [data-session-surface-id="${sameWorkspacePeer.sessionId}"]'
    ))`, { timeoutMs: 60_000, label: "same-workspace split renders" });
    const sameWorkspaceFacts = await readSplitFacts(app, primary, sameWorkspacePeer);
    expect(sameWorkspaceFacts.primaryPaneWorkspaceId).toBe(workspaceA);
    expect(sameWorkspaceFacts.secondaryPaneWorkspaceId).toBe(workspaceA);
    expect(sameWorkspaceFacts.primarySurfaceWorkspaceId).toBe(workspaceA);
    expect(sameWorkspaceFacts.secondarySurfaceWorkspaceId).toBe(workspaceA);
    expect(sameWorkspaceFacts.primaryLayoutWorkspaceId).toBe(workspaceA);
    expect(sameWorkspaceFacts.secondaryLayoutWorkspaceId).toBe(workspaceA);
    expect(sameWorkspaceFacts.secondaryPaneWorkspaceId).not.toBe(workspaceB);
    expect(sameWorkspaceFacts.primaryOwnsSecondarySurface).toBe(false);
    expect(sameWorkspaceFacts.secondaryOwnsPrimarySurface).toBe(false);
    expect(sameWorkspaceFacts.primaryUnavailable).toBe(false);
    expect(sameWorkspaceFacts.secondaryUnavailable).toBe(false);
    evidence.recordAssertionEvidence(
      "Same-workspace split remains available and renders both sessions in their owning workspace",
      JSON.stringify(sameWorkspaceFacts),
      sameWorkspaceFacts.layout === "split"
        && sameWorkspaceFacts.primarySessionId === primary.sessionId
        && sameWorkspaceFacts.secondarySessionId === sameWorkspacePeer.sessionId
        && sameWorkspaceFacts.primaryPaneWorkspaceId === workspaceA
        && sameWorkspaceFacts.secondaryPaneWorkspaceId === workspaceA
        && sameWorkspaceFacts.primarySurfaceWorkspaceId === workspaceA
        && sameWorkspaceFacts.secondarySurfaceWorkspaceId === workspaceA
        && sameWorkspaceFacts.primaryLayoutWorkspaceId === workspaceA
        && sameWorkspaceFacts.secondaryLayoutWorkspaceId === workspaceA
        && sameWorkspaceFacts.secondaryPaneWorkspaceId !== workspaceB
        && !sameWorkspaceFacts.primaryOwnsSecondarySurface
        && !sameWorkspaceFacts.secondaryOwnsPrimarySurface
        && !sameWorkspaceFacts.primaryUnavailable
        && !sameWorkspaceFacts.secondaryUnavailable,
    );
    await closeSecondaryPane(app, user);
    expect(await evalIn(app, `document.querySelector('[data-session-surface-id="${primary.sessionId}"]') !== null`)).toBe(true);
    expect(await evalIn(app, `document.querySelector('[data-session-surface-id="${sameWorkspacePeer.sessionId}"]') === null`)).toBe(true);

    await openContextMenuForSession(app, user, crossWorkspacePeer);
    expect(await splitMenuVisible(app)).toBe(true);
    await user.press("Escape");
    await openCrossWorkspaceSplitFromPalette(app, user, crossWorkspacePeer);
    await waitFor(app, `Boolean(document.querySelector(
      '[data-workbench-pane="secondary"][data-workbench-workspace-id="${workspaceB}"] [data-session-surface-id="${crossWorkspacePeer.sessionId}"]'
    ))`, { timeoutMs: 60_000, label: "cross-workspace palette split renders" });

    const crossWorkspaceFacts = await readSplitFacts(app, primary, crossWorkspacePeer);
    expect(crossWorkspaceFacts.layout).toBe("split");
    expect(crossWorkspaceFacts.primaryPaneWorkspaceId).toBe(workspaceA);
    expect(crossWorkspaceFacts.primaryPaneWorkspaceId).not.toBe(workspaceB);
    expect(crossWorkspaceFacts.secondaryPaneWorkspaceId).toBe(workspaceB);
    expect(crossWorkspaceFacts.secondaryPaneWorkspaceId).not.toBe(workspaceA);
    expect(crossWorkspaceFacts.primarySurfaceWorkspaceId).toBe(workspaceA);
    expect(crossWorkspaceFacts.secondarySurfaceWorkspaceId).toBe(workspaceB);
    expect(crossWorkspaceFacts.primaryLayoutWorkspaceId).toBe(workspaceA);
    expect(crossWorkspaceFacts.secondaryLayoutWorkspaceId).toBe(workspaceB);
    expect(crossWorkspaceFacts.primaryResourceWorkspaceId).toBe(workspaceA);
    expect(crossWorkspaceFacts.secondaryResourceWorkspaceId).toBe(workspaceB);
    expect(crossWorkspaceFacts.primaryOwnsSecondarySurface).toBe(false);
    expect(crossWorkspaceFacts.secondaryOwnsPrimarySurface).toBe(false);
    expect(crossWorkspaceFacts.primaryUnavailable).toBe(false);
    expect(crossWorkspaceFacts.secondaryUnavailable).toBe(false);
    expect(crossWorkspaceFacts.primaryWorkspaceName).not.toBe("");
    expect(crossWorkspaceFacts.secondaryWorkspaceName).not.toBe("");
    expect(crossWorkspaceFacts.primaryWorkspaceName).not.toBe(crossWorkspaceFacts.secondaryWorkspaceName);
    evidence.recordAssertionEvidence(
      "The command palette renders two sessions from different workspaces with correct visible ownership",
      JSON.stringify(crossWorkspaceFacts),
      crossWorkspaceFacts.layout === "split"
        && crossWorkspaceFacts.primarySessionId === primary.sessionId
        && crossWorkspaceFacts.secondarySessionId === crossWorkspacePeer.sessionId
        && crossWorkspaceFacts.primaryPaneWorkspaceId === workspaceA
        && crossWorkspaceFacts.primaryPaneWorkspaceId !== workspaceB
        && crossWorkspaceFacts.secondaryPaneWorkspaceId === workspaceB
        && crossWorkspaceFacts.secondaryPaneWorkspaceId !== workspaceA
        && crossWorkspaceFacts.primarySurfaceWorkspaceId === workspaceA
        && crossWorkspaceFacts.secondarySurfaceWorkspaceId === workspaceB
        && crossWorkspaceFacts.primaryLayoutWorkspaceId === workspaceA
        && crossWorkspaceFacts.secondaryLayoutWorkspaceId === workspaceB
        && crossWorkspaceFacts.primaryResourceWorkspaceId === workspaceA
        && crossWorkspaceFacts.secondaryResourceWorkspaceId === workspaceB
        && crossWorkspaceFacts.primaryWorkspaceName !== crossWorkspaceFacts.secondaryWorkspaceName
        && !crossWorkspaceFacts.primaryOwnsSecondarySurface
        && !crossWorkspaceFacts.secondaryOwnsPrimarySurface
        && !crossWorkspaceFacts.primaryUnavailable
        && !crossWorkspaceFacts.secondaryUnavailable,
    );
    await screenshot(app);
  },
);
