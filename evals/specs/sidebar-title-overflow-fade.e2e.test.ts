import { expect } from "vitest";
import { spec, type Probe } from "@openwork/testkit";
import { sidebarOverflow } from "../worlds/session-shell.ts";

const test = spec.world(sidebarOverflow);

interface TitleState {
  clientWidth: number;
  hiddenEdges: string;
  maskImage: string;
  scrollWidth: number;
}

interface RowState {
  title: string;
  titleRight: number;
  actionsLeft: number;
  actionsOpacity: string;
}

interface ListState {
  clientWidth: number;
  scrollLeft: number;
  scrollWidth: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function rowStates(probe: Probe): Promise<RowState[]> {
  // TODO(primitive): probe.geometry should read the boxes of a row's title and actions.
  const value = await probe.eval(`(() => [...document.querySelectorAll("[data-sidebar-session-id]")].map((row) => {
    const title = row.querySelector("[data-session-title-slot]");
    const actions = row.querySelector("[data-session-hover-actions]");
    if (!(title instanceof HTMLElement) || !(actions instanceof HTMLElement)) return null;
    return {
      title: (title.textContent ?? "").trim(),
      titleRight: title.getBoundingClientRect().right,
      actionsLeft: actions.getBoundingClientRect().left,
      actionsOpacity: getComputedStyle(actions).opacity,
    };
  }))()`);
  if (!Array.isArray(value)) throw new Error(`Unexpected sidebar rows: ${JSON.stringify(value)}`);
  return value.map((row) => {
    if (!isRecord(row)
      || typeof row.title !== "string"
      || typeof row.titleRight !== "number"
      || typeof row.actionsLeft !== "number"
      || typeof row.actionsOpacity !== "string") throw new Error(`Unexpected sidebar row: ${JSON.stringify(row)}`);
    return { title: row.title, titleRight: row.titleRight, actionsLeft: row.actionsLeft, actionsOpacity: row.actionsOpacity };
  });
}

async function listState(probe: Probe): Promise<ListState> {
  // TODO(primitive): probe.geometry should read the scroll extents of a visible target.
  const value = await probe.eval(`(() => {
    const list = document.querySelector('[data-sidebar="content"]');
    if (!(list instanceof HTMLElement)) return null;
    return { clientWidth: list.clientWidth, scrollLeft: list.scrollLeft, scrollWidth: list.scrollWidth };
  })()`);
  if (!isRecord(value)
    || typeof value.clientWidth !== "number"
    || typeof value.scrollLeft !== "number"
    || typeof value.scrollWidth !== "number") throw new Error(`Unexpected sidebar list state: ${JSON.stringify(value)}`);
  return { clientWidth: value.clientWidth, scrollLeft: value.scrollLeft, scrollWidth: value.scrollWidth };
}

/** Nothing in the sidebar list is hidden sideways, so there is nothing to scroll to. */
async function expectListFits(probe: Probe): Promise<void> {
  const list = await listState(probe);
  expect(list.scrollWidth).toBeLessThanOrEqual(list.clientWidth);
  expect(list.scrollLeft).toBe(0);
}

async function titleState(probe: Probe, title: string): Promise<TitleState> {
  // TODO(primitive): probe.computedStyle should read overflow geometry and computed masks for a visible target.
  const value = await probe.eval(`(title) => {
    const text = [...document.querySelectorAll("[data-session-title-text]")]
      .find((node) => (node.textContent ?? "").trim() === title);
    if (!(text instanceof HTMLElement) || !(text.parentElement instanceof HTMLElement)) return null;
    const viewport = text.parentElement;
    return {
      clientWidth: viewport.clientWidth,
      hiddenEdges: viewport.dataset.sessionTitleHiddenEdges ?? "",
      maskImage: getComputedStyle(viewport).maskImage,
      scrollWidth: text.scrollWidth,
    };
  }`, { args: [title] });
  if (!isRecord(value)
    || typeof value.clientWidth !== "number"
    || typeof value.hiddenEdges !== "string"
    || typeof value.maskImage !== "string"
    || typeof value.scrollWidth !== "number") throw new Error(`Unexpected title state: ${JSON.stringify(value)}`);
  return {
    clientWidth: value.clientWidth,
    hiddenEdges: value.hiddenEdges,
    maskImage: value.maskImage,
    scrollWidth: value.scrollWidth,
  };
}

test("the sidebar title fade follows only the edges with hidden text", async ({ world, user, seed, probe, step }) => {
  const workspaceName = world.workspacePath.split("/").at(-1) ?? world.workspacePath;
  const resting = await probe.eventually(() => titleState(probe, world.longTitle), {
    within: 60_000,
    label: "overflowing sidebar title",
    until: (state) => state.scrollWidth > state.clientWidth && state.hiddenEdges === "end",
  });
  expect(resting.maskImage).not.toBe("none");

  await step("collapsing the macOS sidebar aligns the pane with the window controls, and reopening restores its inset", async () => {
    await user.see({ text: world.longTitle });
    // Exercise the macOS titlebar layout even when the desktop host is Linux.
    const platformClasses = await seed.evalIn(world.app, `document.documentElement.className`);
    if (typeof platformClasses !== "string") throw new Error("Desktop platform classes were not readable.");
    await seed.evalIn(world.app, `(() => {
      document.documentElement.classList.remove('openwork-platform-linux', 'openwork-platform-windows');
      document.documentElement.classList.add('openwork-electron', 'openwork-platform-mac');
    })()`);
    // TODO(primitive): probe.geometry should compare a pane and its visible titlebar trigger.
    const geometry = () => probe.eval(`(() => {
      const pane = document.querySelector('[data-session-pane]');
      const header = pane?.querySelector('header');
      const trigger = [...document.querySelectorAll('[data-sidebar="trigger"]')]
        .find((element) => element.getBoundingClientRect().width > 0);
      const sidebar = document.querySelector('[data-slot="sidebar"][data-state]');
      if (!pane || !header || !trigger || !sidebar) return null;
      const box = pane.getBoundingClientRect();
      const headerBox = header.getBoundingClientRect();
      const triggerBox = trigger.getBoundingClientRect();
      return {
        isMac: document.documentElement.classList.contains('openwork-platform-mac'),
        state: sidebar.getAttribute('data-state'),
        top: box.top,
        left: box.left,
        centerOffset: Math.abs(headerBox.top + headerBox.height / 2 - triggerBox.top - triggerBox.height / 2),
      };
    })()`);
    const expanded = await geometry();
    expect(expanded).toMatchObject({ state: "expanded", top: 8 });
    if (!isRecord(expanded) || typeof expanded.isMac !== "boolean") throw new Error("Pane geometry was not readable.");
    await user.press("Meta+b");
    const collapsed = await probe.eventually(geometry, {
      within: 10_000,
      label: "collapsed pane settles against the macOS window edge",
      until: (value) => isRecord(value) && value.state === "collapsed" && value.left === (expanded.isMac ? 0 : 8),
    });
    expect(collapsed).toMatchObject({ top: expanded.isMac ? 0 : 8, left: expanded.isMac ? 0 : 8 });
    if (expanded.isMac) {
      if (!isRecord(collapsed) || typeof collapsed.centerOffset !== "number") throw new Error("Titlebar geometry was not readable.");
      expect(collapsed.centerOffset).toBeLessThanOrEqual(1);
    }
    await user.screenshot();
    await user.press("Meta+b");
    await probe.eventually(geometry, {
      within: 10_000,
      label: "reopened sidebar restores the original pane inset",
      until: (value) => isRecord(value) && value.state === "expanded" && value.left === expanded.left,
    });
    expect(await geometry()).toMatchObject({ top: expanded.top, left: expanded.left });
    await seed.evalIn(world.app, `(classes) => { document.documentElement.className = classes; }`, { args: [platformClasses] });
  });

  await step("the list fits the sidebar and does not scroll sideways", async () => {
    await expectListFits(probe);
  });

  await step("a fitting workspace row stays fully visible on hover", async () => {
    const fitting = await probe.eventually(() => titleState(probe, workspaceName), {
      within: 30_000,
      label: "fitting workspace title",
      until: (state) => state.scrollWidth <= state.clientWidth && state.hiddenEdges === "none",
    });
    expect(fitting.maskImage).toBe("none");
    await user.hover({ text: workspaceName });
    const hovered = await probe.eventually(() => titleState(probe, workspaceName), {
      within: 10_000,
      label: "fitting workspace title after hover",
      until: (state) => state.hiddenEdges === "none",
    });
    expect(hovered.scrollWidth).toBeLessThanOrEqual(hovered.clientWidth);
    expect(hovered.maskImage).toBe("none");
  });

  await step("hover reveals the clipped ending without fading it", async () => {
    await user.hover({ text: world.longTitle });
    const moving = await probe.eventually(() => titleState(probe, world.longTitle), {
      within: 10_000,
      label: "title moves between clipped edges",
      until: (state) => state.hiddenEdges === "both",
    });
    expect(moving.maskImage).not.toBe("none");
    const revealed = await probe.eventually(() => titleState(probe, world.longTitle), {
      within: 30_000,
      label: "title reveal reaches its final characters",
      until: (state) => state.hiddenEdges === "start",
    });
    expect(revealed.maskImage).not.toBe("none");
    await user.screenshot();
  });

  await step("widening the sidebar removes the fade", async () => {
    // TODO(primitive): user.drag should resize a visible rail using trusted pointer input.
    // TODO(primitive): probe.geometry should resolve the center of a visible target.
    const point = await probe.eval(`(() => {
      const rail = document.querySelector('[data-sidebar="rail"]');
      if (!(rail instanceof HTMLElement)) return null;
      const rect = rail.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`);
    if (!isRecord(point) || typeof point.x !== "number" || typeof point.y !== "number") throw new Error("Sidebar rail was not measurable.");
    await world.app.client.send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 });
    await world.app.client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x + 340, y: point.y, button: "left" });
    await world.app.client.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x + 340, y: point.y, button: "left", clickCount: 1 });
    const fitting = await probe.eventually(() => titleState(probe, world.longTitle), {
      within: 15_000,
      label: "expanded sidebar exposes full title",
      until: (state) => state.hiddenEdges === "none",
    });
    expect(fitting.clientWidth).toBeGreaterThanOrEqual(fitting.scrollWidth);
    expect(fitting.maskImage).toBe("none");
    const workspaceAfterResize = await titleState(probe, workspaceName);
    expect(workspaceAfterResize.hiddenEdges).toBe("none");
    expect(workspaceAfterResize.maskImage).toBe("none");
    await user.screenshot();
  });

  await step("the widened list still fits and does not scroll sideways", async () => {
    await expectListFits(probe);
  });

  await step("below the hover breakpoint, titles stop before the always-visible row actions", async () => {
    // TODO(primitive): user.resizeViewport should narrow a desktop surface below the hover breakpoint.
    await world.app.client.send("Emulation.setDeviceMetricsOverride", { width: 900, height: 800, deviceScaleFactor: 1, mobile: false });
    await user.press("Meta+b");
    const rows = await probe.eventually(() => rowStates(probe), {
      within: 15_000,
      label: "session rows with visible actions",
      until: (rows) => rows.length > 0 && rows.every((row) => row.actionsOpacity === "1"),
    });
    for (const row of rows) expect(row.titleRight, row.title).toBeLessThanOrEqual(row.actionsLeft);
    await user.screenshot();
  });
});
