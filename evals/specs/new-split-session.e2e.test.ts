import { expect } from "vitest";
import { evalIn, go, listSessions, seedSessions, waitFor } from "@openwork/behaviors";
import type { Surface } from "@openwork/cdp";
import { screenshot } from "@openwork/test-evidence";
import {
  app as launchApp,
  createAdmin,
  createOrg,
  localMysqlIsRunning,
  localRedisIsRunning,
  needs,
  server,
  test,
} from "@openwork/testkit";

const e2eTestsEnabled = process.env.OPENWORK_EVAL_E2E_TESTS === "1";
const daytonaEnabled = process.env.OPENWORK_EVAL_DAYTONA === "1";
const configuredDen = Boolean(process.env.OPENWORK_EVAL_DEN_API_URL?.trim());
const localServicesRequired = !daytonaEnabled && !configuredDen;
const mysqlOpen = await localMysqlIsRunning();
const redisOpen = await localRedisIsRunning();
const runnable = e2eTestsEnabled && (!localServicesRequired || (mysqlOpen && redisOpen));
const skipSuffix = !e2eTestsEnabled
  ? " skipped — needs: set OPENWORK_EVAL_E2E_TESTS=1"
  : localServicesRequired && !mysqlOpen
    ? " skipped — needs MySQL on 127.0.0.1:3306"
    : localServicesRequired && !redisOpen
      ? " skipped — needs Redis on 127.0.0.1:6379"
      : "";

type SplitFacts = {
  layoutKind: string;
  primarySessionId: string;
  secondarySessionId: string;
  primarySurfaceSessionId: string;
  secondarySurfaceSessionId: string;
  secondaryPaneWorkspaceId: string;
  secondaryPaneCount: number;
  locationHash: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSplitFacts(value: unknown): SplitFacts {
  if (!isRecord(value)) throw new Error(`Invalid split facts: ${JSON.stringify(value)}`);
  const text = (key: string) => typeof value[key] === "string" ? value[key] : "";
  return {
    layoutKind: text("layoutKind"),
    primarySessionId: text("primarySessionId"),
    secondarySessionId: text("secondarySessionId"),
    primarySurfaceSessionId: text("primarySurfaceSessionId"),
    secondarySurfaceSessionId: text("secondarySurfaceSessionId"),
    secondaryPaneWorkspaceId: text("secondaryPaneWorkspaceId"),
    secondaryPaneCount: typeof value.secondaryPaneCount === "number" ? value.secondaryPaneCount : -1,
    locationHash: text("locationHash"),
  };
}

async function openSessionRoute(app: Surface, workspaceId: string, sessionId: string): Promise<void> {
  await go(app, `/workspace/${workspaceId}/session/${sessionId}`);
  await waitFor(app, `Boolean(document.querySelector(
    '[data-session-surface-id="${sessionId}"]'
  ))`, { timeoutMs: 60_000, label: "primary session route" });
}

async function openNewSplitFromContextMenu(app: Surface, workspaceId: string, sessionId: string): Promise<void> {
  const opened = await evalIn(app, `(() => {
    const row = document.querySelector(
      '[data-sidebar-session-id="${sessionId}"][data-sidebar-session-workspace-id="${workspaceId}"]'
    );
    if (!(row instanceof HTMLElement)) return false;
    row.scrollIntoView({ block: "center" });
    const target = row.querySelector('[data-session-tab-id="${sessionId}"]') ?? row;
    if (!(target instanceof HTMLElement)) return false;
    const rect = target.getBoundingClientRect();
    target.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      button: 2,
      buttons: 2,
      clientX: rect.left + Math.min(24, Math.max(1, rect.width / 2)),
      clientY: rect.top + Math.min(12, Math.max(1, rect.height / 2)),
    }));
    return true;
  })()`);
  expect(opened).toBe(true);
  await waitFor(app, `Boolean(document.querySelector('[role="menu"]'))`, {
    timeoutMs: 15_000,
    label: "session context menu",
  });
  const itemExists = await evalIn(app, `Boolean(document.querySelector('[data-session-menu-new-split]'))`);
  expect(itemExists).toBe(true);
  const clicked = await evalIn(app, `(() => {
    const item = document.querySelector('[data-session-menu-new-split]');
    if (!(item instanceof HTMLElement)) return false;
    item.click();
    return true;
  })()`);
  expect(clicked).toBe(true);
}

async function openNewSplitFromPalette(app: Surface): Promise<void> {
  await evalIn(app, `(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", {
      key: "k",
      code: "KeyK",
      metaKey: true,
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    }));
    return true;
  })()`);
  await waitFor(app, `Boolean(document.querySelector('[data-command-palette-item="new-split"]'))`, {
    timeoutMs: 15_000,
    label: "New split command",
  });
  const itemExists = await evalIn(app, `Boolean(document.querySelector('[data-command-palette-item="new-split"]'))`);
  expect(itemExists).toBe(true);
  const clicked = await evalIn(app, `(() => {
    const item = document.querySelector('[data-command-palette-item="new-split"]');
    if (!(item instanceof HTMLElement)) return false;
    item.click();
    return true;
  })()`);
  expect(clicked).toBe(true);
}

async function readSplitFacts(app: Surface): Promise<SplitFacts> {
  return parseSplitFacts(await evalIn(app, `(() => {
    const context = window.__openworkControl?.context?.();
    const layout = context?.conversations?.layout;
    const primaryPane = document.querySelector('[data-workbench-pane="primary"]');
    const secondaryPanes = [...document.querySelectorAll('[data-workbench-pane="secondary"]')];
    const secondaryPane = secondaryPanes[0];
    return {
      layoutKind: layout?.kind ?? "",
      primarySessionId: layout?.primarySessionId ?? layout?.sessionId ?? "",
      secondarySessionId: layout?.secondarySessionId ?? "",
      primarySurfaceSessionId: primaryPane?.querySelector('[data-session-surface-id]')
        ?.getAttribute('data-session-surface-id') ?? "",
      secondarySurfaceSessionId: secondaryPane?.querySelector('[data-session-surface-id]')
        ?.getAttribute('data-session-surface-id') ?? "",
      secondaryPaneWorkspaceId: secondaryPane?.getAttribute('data-workbench-workspace-id') ?? "",
      secondaryPaneCount: secondaryPanes.length,
      locationHash: window.location.hash,
    };
  })()`));
}

test.skipIf(!runnable)(
  `new split creates fresh same-workspace secondary sessions without moving the primary${skipSuffix}`,
  { timeout: 600_000 },
  async ({ place }) => {
    needs({ optIn: ["OPENWORK_EVAL_E2E_TESTS"] });

    await using stack = new AsyncDisposableStack();
    const den = stack.use(await server({ place, provision: false, web: true }));
    await createAdmin(den, {});
    stack.use(await createOrg(den, "acme"));
    const app = stack.use(await launchApp({ den, place, as: "admin" }));
    await seedSessions(app, ["New split primary"]);
    const workspaceId = app.workspaceId;
    if (!workspaceId) throw new Error("The new split world did not resolve a workspace.");

    const seededSessions = await listSessions(app);
    const primary = seededSessions.find((session) => session.title === "New split primary");
    if (!primary) throw new Error(`The seeded primary session was not found: ${JSON.stringify(seededSessions)}`);

    await openSessionRoute(app, workspaceId, primary.sessionId);
    const before = (await listSessions(app)).map((session) => session.sessionId);

    await openNewSplitFromContextMenu(app, workspaceId, primary.sessionId);
    await waitFor(app, `window.__openworkControl?.context?.().conversations?.layout?.kind === "split"`, {
      timeoutMs: 60_000,
      label: "context-menu new split layout",
    });

    const firstFacts = await readSplitFacts(app);
    expect(firstFacts.layoutKind).toBe("split");
    expect(firstFacts.primarySessionId).toBe(primary.sessionId);
    expect(firstFacts.primarySurfaceSessionId).toBe(primary.sessionId);
    expect(firstFacts.secondarySessionId).toMatch(/^ses_/);
    expect(before).not.toContain(firstFacts.secondarySessionId);
    expect(firstFacts.secondarySurfaceSessionId).toBe(firstFacts.secondarySessionId);
    expect(firstFacts.secondaryPaneWorkspaceId).toBe(workspaceId);
    expect(firstFacts.locationHash).toContain(`/workspace/${workspaceId}/session/${primary.sessionId}`);
    const afterContextMenu = await listSessions(app);
    expect(afterContextMenu).toHaveLength(before.length + 1);
    expect(afterContextMenu.map((session) => session.sessionId)).toContain(firstFacts.secondarySessionId);
    // session.list_sessions exposes only IDs and titles, so message freshness is not observable here.

    await openNewSplitFromPalette(app);
    await waitFor(app, `(() => {
      const layout = window.__openworkControl?.context?.().conversations?.layout;
      return layout?.kind === "split"
        && layout?.secondarySessionId !== ${JSON.stringify(firstFacts.secondarySessionId)};
    })()`, { timeoutMs: 60_000, label: "palette new split replaces secondary session" });

    const secondFacts = await readSplitFacts(app);
    expect(secondFacts.layoutKind).toBe("split");
    expect(secondFacts.primarySessionId).toBe(primary.sessionId);
    expect(secondFacts.primarySurfaceSessionId).toBe(primary.sessionId);
    expect(secondFacts.secondarySessionId).toMatch(/^ses_/);
    expect(secondFacts.secondarySessionId).not.toBe(firstFacts.secondarySessionId);
    expect(afterContextMenu.map((session) => session.sessionId)).not.toContain(secondFacts.secondarySessionId);
    expect(secondFacts.secondarySurfaceSessionId).toBe(secondFacts.secondarySessionId);
    expect(secondFacts.secondaryPaneWorkspaceId).toBe(workspaceId);
    expect(secondFacts.locationHash).toContain(`/workspace/${workspaceId}/session/${primary.sessionId}`);
    expect(secondFacts.secondaryPaneCount).toBe(1);
    const afterPalette = await listSessions(app);
    expect(afterPalette).toHaveLength(before.length + 2);
    expect(afterPalette.map((session) => session.sessionId)).toContain(secondFacts.secondarySessionId);

    await screenshot(app);
  },
);
