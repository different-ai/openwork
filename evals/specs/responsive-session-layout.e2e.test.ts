import { expect } from "vitest";
import { control, evalIn, go, listSessions, seedSessions, waitFor } from "@openwork/behaviors";
import type { Surface } from "@openwork/cdp";
import { setViewport } from "@openwork/cdp";
import {
  localMysqlIsRunning,
  localRedisIsRunning,
  needs,
  app as launchApp,
  createAdmin,
  createOrg,
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

const sessionTitles = ["Responsive primary chat", "Responsive split chat"];

async function openSessionRoute(app: Surface, workspaceId: string, sessionId: string) {
  await go(app, `/workspace/${workspaceId}/session/${sessionId}`);
  await waitFor(app, `Boolean(document.querySelector(
    '[data-session-surface-id="${sessionId}"]'
  ))`, { timeoutMs: 60_000, label: "primary session route" });
}

async function openSessionInSplit(app: Surface, workspaceId: string, sessionId: string) {
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
  await waitFor(app, `Boolean(document.querySelector('[data-session-menu-open-split]'))`, {
    timeoutMs: 15_000,
    label: "Open in split view menu item",
  });
  const clicked = await evalIn(app, `(() => {
    const item = document.querySelector('[data-session-menu-open-split]');
    if (!(item instanceof HTMLElement)) return false;
    item.click();
    return true;
  })()`);
  expect(clicked).toBe(true);
}

async function pressPaneKey(app: Surface, pane: "chat" | "split" | "panel", key: string) {
  const pressed = await evalIn(app, `(() => {
    const tab = document.querySelector('[data-narrow-pane="${pane}"]');
    if (!(tab instanceof HTMLElement)) return false;
    tab.focus();
    tab.dispatchEvent(new KeyboardEvent("keydown", { key: ${JSON.stringify(key)}, bubbles: true }));
    return true;
  })()`);
  expect(pressed).toBe(true);
}

async function openFilesPanel(app: Surface) {
  const openedMenu = await evalIn(app, `(() => {
    const button = document.querySelector('button[aria-label="More actions"]');
    if (!(button instanceof HTMLButtonElement)) return false;
    button.click();
    return true;
  })()`);
  expect(openedMenu).toBe(true);
  await waitFor(app, `Boolean([...document.querySelectorAll('[role="menuitem"]')]
    .find((item) => (item.textContent ?? '').trim().startsWith('Files')))`, {
    timeoutMs: 15_000,
    label: "Files menu item",
  });
  const openedPanel = await evalIn(app, `(() => {
    const item = [...document.querySelectorAll('[role="menuitem"]')]
      .find((candidate) => (candidate.textContent ?? '').trim().startsWith('Files'));
    if (!(item instanceof HTMLElement)) return false;
    item.click();
    return true;
  })()`);
  expect(openedPanel).toBe(true);
}

test.skipIf(!runnable)(
  `narrow session panes stay selectable, synchronized, and inside the viewport${skipSuffix}`,
  { timeout: 600_000 },
  async ({ evidence, place }) => {
    needs({ optIn: ["OPENWORK_EVAL_E2E_TESTS"] });

    await using stack = new AsyncDisposableStack();
    const den = stack.use(await server({ place, provision: false, web: true }));
    await createAdmin(den, {});
    stack.use(await createOrg(den, "acme"));
    const app = stack.use(await launchApp({ den, place, as: "admin" }));
    await seedSessions(app, sessionTitles);
    const workspaceId = app.workspaceId;
    if (!workspaceId) throw new Error("The responsive session world did not resolve a workspace.");

    const sessions = await listSessions(app);
    const primary = sessions.find((session) => session.title === sessionTitles[0]);
    const secondary = sessions.find((session) => session.title === sessionTitles[1]);
    if (!primary || !secondary) {
      throw new Error(`The responsive session world did not expose both seeded sessions: ${JSON.stringify(sessions)}`);
    }

    await openSessionRoute(app, workspaceId, primary.sessionId);
    await openSessionInSplit(app, workspaceId, secondary.sessionId);
    await waitFor(app, `Boolean(document.querySelector(
      '[data-workbench-pane="secondary"] [data-session-surface-id="${secondary.sessionId}"]'
    ))`, { timeoutMs: 60_000, label: "desktop split session" });

    await setViewport(app, { width: 390, height: 844, deviceScaleFactor: 1 });
    await waitFor(app, `(() => {
      const selected = document.querySelector('[data-narrow-pane][aria-selected="true"]');
      const secondary = document.querySelector('[data-session-surface-id="${secondary.sessionId}"]');
      const primary = document.querySelector('[data-session-surface-id="${primary.sessionId}"]');
      return selected?.getAttribute('data-narrow-pane') === 'split' && Boolean(secondary) && !primary;
    })()`, { timeoutMs: 30_000, label: "focused split becomes the narrow visible pane" });

    const initialNarrowFacts = await evalIn(app, `(() => {
      const tabs = [...document.querySelectorAll('[data-narrow-pane]')];
      const active = tabs.find((tab) => tab.getAttribute('aria-selected') === 'true');
      const activePanel = active
        ? document.getElementById(active.getAttribute('aria-controls') ?? '')
        : null;
      const switcher = document.querySelector('[data-narrow-pane-switcher]');
      const switcherRect = switcher?.getBoundingClientRect();
      const panelRect = activePanel?.getBoundingClientRect();
      return {
        selected: active?.getAttribute('data-narrow-pane') ?? '',
        tabStops: tabs.filter((tab) => tab.getAttribute('tabindex') === '0').length,
        inactiveStops: tabs.filter((tab) => tab.getAttribute('aria-selected') === 'false'
          && tab.getAttribute('tabindex') !== '-1').length,
        controlsResolve: tabs.every((tab) => Boolean(document.getElementById(tab.getAttribute('aria-controls') ?? ''))),
        labelledByActiveTab: activePanel?.getAttribute('aria-labelledby') === active?.id,
        minimumTarget: Math.min(...tabs.map((tab) => tab.getBoundingClientRect().height)),
        switcherInsideViewport: Boolean(switcherRect
          && switcherRect.left >= 0
          && switcherRect.right <= window.innerWidth
          && switcherRect.top >= 0
          && switcherRect.bottom <= window.innerHeight),
        panelInsideViewport: Boolean(panelRect
          && panelRect.left >= 0
          && panelRect.right <= window.innerWidth
          && panelRect.top >= 0
          && panelRect.bottom <= window.innerHeight),
        documentWidth: document.documentElement.scrollWidth,
        viewportWidth: window.innerWidth,
      };
    })()`);
    expect(initialNarrowFacts).toMatchObject({
      selected: "split",
      tabStops: 1,
      inactiveStops: 0,
      controlsResolve: true,
      labelledByActiveTab: true,
      switcherInsideViewport: true,
      panelInsideViewport: true,
      documentWidth: 390,
      viewportWidth: 390,
    });
    expect(initialNarrowFacts).toHaveProperty("minimumTarget");
    if (typeof initialNarrowFacts !== "object" || initialNarrowFacts === null) {
      throw new Error(`Invalid narrow layout facts: ${JSON.stringify(initialNarrowFacts)}`);
    }
    const minimumTarget = Reflect.get(initialNarrowFacts, "minimumTarget");
    expect(typeof minimumTarget === "number" && minimumTarget >= 44).toBe(true);
    evidence.recordAssertionEvidence(
      "Narrow split focus stays synchronized and the tab widget remains reachable",
      JSON.stringify(initialNarrowFacts),
      true,
    );

    await pressPaneKey(app, "split", "ArrowLeft");
    await waitFor(app, `(() => {
      const selected = document.querySelector('[data-narrow-pane][aria-selected="true"]');
      return selected?.getAttribute('data-narrow-pane') === 'chat'
        && Boolean(document.querySelector('[data-session-surface-id="${primary.sessionId}"]'))
        && !document.querySelector('[data-session-surface-id="${secondary.sessionId}"]');
    })()`, { timeoutMs: 30_000, label: "ArrowLeft selects primary chat" });

    const draft = "Keep this narrow-screen draft";
    const focusedComposer = await evalIn(app, `(() => {
      const editor = document.querySelector(
        '[data-session-surface-id="${primary.sessionId}"] [contenteditable="true"][data-lexical-editor="true"]'
      );
      if (!(editor instanceof HTMLElement)) return false;
      editor.focus();
      return document.activeElement === editor;
    })()`);
    expect(focusedComposer).toBe(true);
    await app.client.send("Input.insertText", { text: draft });
    await waitFor(app, `(document.querySelector(
      '[data-session-surface-id="${primary.sessionId}"] [contenteditable="true"][data-lexical-editor="true"]'
    )?.textContent ?? '').includes(${JSON.stringify(draft)})`, {
      timeoutMs: 15_000,
      label: "narrow primary draft",
    });

    const focusSecondaryResult = await control(app, "session.open", { sessionId: secondary.sessionId });
    expect(focusSecondaryResult).toMatchObject({ ok: true, reused: "secondary-pane" });
    await waitFor(app, `document.querySelector('[data-narrow-pane="split"]')?.getAttribute('aria-selected') === 'true'
      && Boolean(document.querySelector('[data-session-surface-id="${secondary.sessionId}"]'))`, {
      timeoutMs: 30_000,
      label: "session.open reveals narrow split",
    });
    await pressPaneKey(app, "split", "ArrowLeft");
    await waitFor(app, `(document.querySelector(
      '[data-session-surface-id="${primary.sessionId}"] [contenteditable="true"][data-lexical-editor="true"]'
    )?.textContent ?? '').includes(${JSON.stringify(draft)})`, {
      timeoutMs: 30_000,
      label: "draft survives narrow pane remount",
    });
    evidence.recordAssertionEvidence(
      "Existing session focus actions reveal the requested narrow pane without losing the other chat draft",
      `session.open revealed ${secondary.sessionId}; returning to ${primary.sessionId} preserved the draft.`,
      true,
    );

    await openFilesPanel(app);
    await waitFor(app, `document.querySelector('[data-narrow-pane="panel"]')?.getAttribute('aria-selected') === 'true'
      && Boolean(document.getElementById('narrow-session-pane-panel'))`, {
      timeoutMs: 30_000,
      label: "tools panel becomes the narrow visible pane",
    });
    const panelFacts = await evalIn(app, `(() => {
      const panel = document.getElementById('narrow-session-pane-panel');
      const rect = panel?.getBoundingClientRect();
      return {
        panelInsideViewport: Boolean(rect
          && rect.left >= 0
          && rect.right <= window.innerWidth
          && rect.top >= 0
          && rect.bottom <= window.innerHeight),
        chatHidden: document.getElementById('narrow-session-pane-chat')?.hidden === true,
        splitHidden: document.getElementById('narrow-session-pane-split')?.hidden === true,
        documentWidth: document.documentElement.scrollWidth,
        viewportWidth: window.innerWidth,
      };
    })()`);
    expect(panelFacts).toEqual({
      panelInsideViewport: true,
      chatHidden: true,
      splitHidden: true,
      documentWidth: 390,
      viewportWidth: 390,
    });

    const closedPanel = await evalIn(app, `(() => {
      const close = document.querySelector('#narrow-session-pane-panel button[aria-label="Close panel"]');
      if (!(close instanceof HTMLButtonElement)) return false;
      close.click();
      return true;
    })()`);
    expect(closedPanel).toBe(true);
    await waitFor(app, `!document.querySelector('[data-narrow-pane="panel"]')
      && document.querySelector('[data-narrow-pane="chat"]')?.getAttribute('aria-selected') === 'true'
      && Boolean(document.querySelector('[data-session-surface-id="${primary.sessionId}"]'))`, {
      timeoutMs: 30_000,
      label: "closing selected panel falls back to chat",
    });
    evidence.recordAssertionEvidence(
      "The in-flow tools pane stays inside the viewport and closing it returns to chat",
      JSON.stringify(panelFacts),
      true,
    );
  },
);
