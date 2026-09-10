import { browserScript } from "@openwork/testkit";
import { beforeEach, describe, expect } from "vitest";
import { spec, readSidebarOverflow, type Surface } from "@openwork/testkit";
import { sidebarExpansion, sidebarOverflow } from "../worlds/session-shell.ts";

type SidebarMode = "overflow" | "workspace" | "group" | "ungrouped";

// Shared with the legacy rail gesture below: real, paced pointer input, never DOM events.
async function dragPointer(app: Surface, from: { x: number; y: number }, to: { x: number; y: number }) {
  await app.client.send("Input.dispatchMouseEvent", { type: "mousePressed", ...from, button: "left", buttons: 1, clickCount: 1 });
  try {
    for (let index = 1; index <= 20; index++) {
      await app.client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: from.x + (to.x - from.x) * index / 20,
        y: from.y + (to.y - from.y) * index / 20, button: "left", buttons: 1 });
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  } finally {
    await app.client.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...to, button: "left", buttons: 0, clickCount: 1 });
  }
}

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

async function rowStates(app: Surface): Promise<RowState[]> {
  const value = (await readSidebarOverflow(app)).rows;
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

async function listState(app: Surface): Promise<ListState> {
  const value = (await readSidebarOverflow(app)).list;
  if (!isRecord(value)
    || typeof value.clientWidth !== "number"
    || typeof value.scrollLeft !== "number"
    || typeof value.scrollWidth !== "number") throw new Error(`Unexpected sidebar list state: ${JSON.stringify(value)}`);
  return { clientWidth: value.clientWidth, scrollLeft: value.scrollLeft, scrollWidth: value.scrollWidth };
}

/** Nothing in the sidebar list is hidden sideways, so there is nothing to scroll to. */
async function expectListFits(app: Surface): Promise<void> {
  const list = await listState(app);
  expect(list.scrollWidth).toBeLessThanOrEqual(list.clientWidth);
  expect(list.scrollLeft).toBe(0);
}

async function titleState(app: Surface, title: string): Promise<TitleState> {
  const overflow = await readSidebarOverflow(app, title);
  const value = overflow.title;
  if (!isRecord(value)
    || typeof value.clientWidth !== "number"
    || typeof value.hiddenEdges !== "string"
    || typeof value.maskImage !== "string"
    || typeof value.scrollWidth !== "number") {
    throw new Error(`Unexpected title state for ${JSON.stringify(title)}: ${JSON.stringify(value)}; rendered titles: ${JSON.stringify(overflow.titles)}`);
  }
  return {
    clientWidth: value.clientWidth,
    hiddenEdges: value.hiddenEdges,
    maskImage: value.maskImage,
    scrollWidth: value.scrollWidth,
  };
}

describe.sequential("sidebar expansion and title continuity", () => {
let selectedMode: SidebarMode = "overflow";
// Register one fixture: repeated extensions accumulate worlds in Vitest 3.
const test = spec.world(async seed => {
  const mode = selectedMode;
  if (mode === "overflow") return { mode, ...await sidebarOverflow(seed) };
  return { mode, ...await sidebarExpansion(seed, mode) };
});

describe("title overflow", () => {
beforeEach(() => { selectedMode = "overflow"; });
test("the sidebar title fade follows only the edges with hidden text", async ({ world, user, seed, probe, step }) => {
  if (world.mode !== "overflow") throw new Error("Unexpected sidebar fixture");
  const workspaceName = world.workspacePath.split("/").at(-1) ?? world.workspacePath;
  const resting = await probe.eventually(() => titleState(world.app, world.longTitle), {
    within: 60_000,
    label: "overflowing sidebar title",
    until: (state) => state.scrollWidth > state.clientWidth && state.hiddenEdges === "end",
  });
  expect(resting.maskImage).not.toBe("none");

  await step("collapsing the macOS sidebar aligns the pane with the window controls, and reopening restores its inset", async () => {
    await user.see({ text: world.longTitle });
    // Exercise the macOS titlebar layout even when the desktop host is Linux.
    const platformClasses = await seed.evalIn(world.app, () => (document.documentElement.className));
    if (typeof platformClasses !== "string") throw new Error("Desktop platform classes were not readable.");
    await seed.evalIn(world.app, () => {
      document.documentElement.classList.remove('openwork-platform-linux', 'openwork-platform-windows');
      document.documentElement.classList.add('openwork-electron', 'openwork-platform-mac');
    });
    // TODO(primitive): probe.geometry should compare a pane and its visible titlebar trigger.
    const geometry = () => probe.eval(() => {
      const pane = document.querySelector<HTMLElement>('[data-session-pane]');
      const header = pane?.querySelector('header');
      const trigger = [...document.querySelectorAll<HTMLElement>('[data-sidebar="trigger"]')]
        .find((element) => element.getBoundingClientRect().width > 0);
      const sidebar = document.querySelector<HTMLElement>('[data-slot="sidebar"][data-state]');
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
    });
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
    await seed.evalIn(world.app, browserScript((classes) => { document.documentElement.className = classes; }, [platformClasses]));
  });

  await step("the list fits the sidebar and does not scroll sideways", async () => {
    await expectListFits(world.app);
  });

  await step("a fitting workspace row stays fully visible on hover", async () => {
    const fitting = await probe.eventually(() => titleState(world.app, workspaceName), {
      within: 30_000,
      label: "fitting workspace title",
      until: (state) => state.scrollWidth <= state.clientWidth && state.hiddenEdges === "none",
    });
    expect(fitting.maskImage).toBe("none");
    await user.hover({ text: workspaceName });
    const hovered = await probe.eventually(() => titleState(world.app, workspaceName), {
      within: 10_000,
      label: "fitting workspace title after hover",
      until: (state) => state.hiddenEdges === "none",
    });
    expect(hovered.scrollWidth).toBeLessThanOrEqual(hovered.clientWidth);
    expect(hovered.maskImage).toBe("none");
  });

  await step("hover reveals the clipped ending without fading it", async () => {
    await user.hover({ text: world.longTitle });
    const moving = await probe.eventually(() => titleState(world.app, world.longTitle), {
      within: 10_000,
      label: "title moves between clipped edges",
      until: (state) => state.hiddenEdges === "both",
    });
    expect(moving.maskImage).not.toBe("none");
    const revealed = await probe.eventually(() => titleState(world.app, world.longTitle), {
      within: 30_000,
      label: "title reveal reaches its final characters",
      until: (state) => state.hiddenEdges === "start",
    });
    expect(revealed.maskImage).not.toBe("none");
    await user.screenshot();
  });

  await step("widening the sidebar removes the fade", async () => {
    // TODO(primitive): user.drag should resize a visible rail using trusted pointer input.
    const point = (await readSidebarOverflow(world.app)).rail;
    if (!isRecord(point) || typeof point.x !== "number" || typeof point.y !== "number") throw new Error("Sidebar rail was not measurable.");
    await dragPointer(world.app, { x: point.x, y: point.y }, { x: point.x + 340, y: point.y });
    const fitting = await probe.eventually(() => titleState(world.app, world.longTitle), {
      within: 15_000,
      label: "expanded sidebar exposes full title",
      until: (state) => state.hiddenEdges === "none",
    });
    expect(fitting.clientWidth).toBeGreaterThanOrEqual(fitting.scrollWidth);
    expect(fitting.maskImage).toBe("none");
    const workspaceAfterResize = await titleState(world.app, workspaceName);
    expect(workspaceAfterResize.hiddenEdges).toBe("none");
    expect(workspaceAfterResize.maskImage).toBe("none");
    await user.screenshot();
  });

  await step("the widened list still fits and does not scroll sideways", async () => {
    await expectListFits(world.app);
  });

  await step("below the hover breakpoint, titles stop before the always-visible row actions", async () => {
    // TODO(primitive): user.resizeViewport should narrow a desktop surface below the hover breakpoint.
    await world.app.client.send("Emulation.setDeviceMetricsOverride", { width: 900, height: 800, deviceScaleFactor: 1, mobile: false });
    await user.press("Meta+b");
    const rows = await probe.eventually(() => rowStates(world.app), {
      within: 15_000,
      label: "session rows with visible actions",
      until: (rows) => rows.length > 0 && rows.every((row) => row.actionsOpacity === "1"),
    });
    for (const row of rows) expect(row.titleRight, row.title).toBeLessThanOrEqual(row.actionsLeft);
    await user.screenshot();
  });
});

});

const expansionModes: ("workspace" | "group" | "ungrouped")[] = ["workspace", "group", "ungrouped"];
for (const mode of expansionModes) {
  describe(mode, () => {
  beforeEach(() => { selectedMode = mode; });
  test(`${mode} Show more keeps old rows anchored through every frame and still permits reordering`, async ({ world, user, probe, step }) => {
    if (world.mode === "overflow") throw new Error("Unexpected sidebar fixture");
    const first = world.sessions[0];
    if (!first) throw new Error("Missing expansion anchor session");
    await user.click({ role: "button", label: first.title });
    const initial = await probe.eventually(() => world.observation.read(), {
      within: 30_000, label: "expansion anchor selected",
      until: value => value.current.selected.length === 1 && value.current.selected[0] === first.sessionId,
    });
    const expectedIds = [...world.sessions, ...(mode === "workspace" ? [world.neighbor] : [])].map(session => `session:${session.sessionId}`);
    const listRows = (rows: typeof initial.current.rows) => rows.filter(row => expectedIds.includes(row.id));
    expect(listRows(initial.current.rows).map(row => row.id)).toEqual(expectedIds.slice(0, 6));
    let scrolledExpansions = 0;

    for (const [index, count] of [12, 18, expectedIds.length].entries()) {
      await step(`${mode} expansion ${index + 1} reveals ${count} rows without a scroll jump, floating rows, navigation, or reorder`, async () => {
        const label = `Show ${Math.min(6, expectedIds.length - (6 + index * 6))} more`;
        await user.click({ text: label });
        const observed = await probe.eventually(() => world.observation.read(), {
          within: 10_000, label: "complete expansion frame window",
          until: value => value.clicks === index + 1 && value.expansion?.complete === true,
        });
        const capture = observed.expansion;
        if (!capture) throw new Error("Trusted expansion click was not captured");
        expect(capture.label).toBe(label);
        expect(capture.before.selected).toEqual(initial.current.selected);
        expect(capture.before.hash).toBe(initial.current.hash);
        expect(listRows(capture.before.rows).map(row => row.id)).toEqual(expectedIds.slice(0, 6 + index * 6));
        if (capture.before.scrollTop > 0) scrolledExpansions++;
        const anchors = capture.before.rows.filter(row => row.top >= capture.before.viewport.top
          && row.bottom <= Math.min(capture.before.viewport.bottom, capture.triggerTop));
        expect(anchors.length, "visible old rows above the expansion control").toBeGreaterThan(0);
        expect(capture.frames.length).toBeGreaterThanOrEqual(20);
        expect(capture.frames[0]!.at - capture.before.at, "first expansion frame captured promptly").toBeLessThan(100);
        let previousAt = capture.before.at;
        let revealed = false;
        for (const frame of capture.frames) {
          expect(frame.at - previousAt, "no unobserved animation-sized frame gap").toBeLessThan(150);
          previousAt = frame.at;
          expect(frame.hash).toBe(capture.before.hash);
          expect(frame.selected).toEqual(capture.before.selected);
          expect(frame.management, "expanding must not mutate ordering, groups, or pins").toBe(capture.before.management);
          expect(Math.abs(frame.scrollTop - capture.before.scrollTop), "sidebar scroll position").toBeLessThanOrEqual(1);
          for (const anchor of anchors) {
            const row = frame.rows.find(row => row.id === anchor.id);
            expect(row, `old row ${anchor.id} remains rendered`).toBeDefined();
            expect(Math.abs(row!.top - anchor.top), `old row ${anchor.id} remains stationary: before ${JSON.stringify({
              top: anchor.top, bottom: anchor.bottom, viewport: capture.before.viewport, scrollTop: capture.before.scrollTop,
            })}, frame ${JSON.stringify({ top: row!.top, bottom: row!.bottom, viewport: frame.viewport, scrollTop: frame.scrollTop })}`).toBeLessThanOrEqual(1);
          }
          const visible = frame.rows.filter(row => row.bottom > frame.viewport.top && row.top < frame.viewport.bottom);
          for (const [rowIndex, row] of visible.entries()) {
            expect(Math.abs(row.projectionY), `${row.id} must not float during expansion`).toBeLessThanOrEqual(1);
            const next = visible[rowIndex + 1];
            if (next) expect(row.bottom, `${row.id} must not overlap ${next.id}`).toBeLessThanOrEqual(next.top + 1);
          }
          const ids = listRows(frame.rows).map(row => row.id);
          if (ids.length === count) revealed = true;
          expect(ids).toEqual(expectedIds.slice(0, revealed ? count : 6 + index * 6));
        }
        expect(revealed, "new batch appears within the observed frames").toBe(true);
        expect(listRows(observed.current.rows).map(row => row.id)).toEqual(expectedIds.slice(0, count));
      });
    }
    expect(scrolledExpansions, "exercise expansion in an already-scrolled sidebar").toBeGreaterThan(0);
    await user.notSee({ text: /^Show \d+ more$/ }, { timeoutMs: 500 });

    await step("drag still reorders after expansion without selecting another conversation", async () => {
      const last = world.sessions.at(-1)!;
      const preceding = world.sessions.at(-2)!;
      let sourceId = `session:${last.sessionId}`;
      let targetId = `session:${preceding.sessionId}`;
      if (mode === "group") {
        await user.click({ text: "Expansion group" });
        await user.click({ text: "Neighbor group" });
        await user.hover({ text: "Neighbor group" });
        sourceId = "group:grp_neighbor";
        targetId = "group:grp_expansion";
      } else {
        await user.hover({ role: "button", label: last.title });
      }
      // Hovering the last row scrolls the list to its end, where an integer scroll offset can leave
      // the row a fraction of a pixel past the list's fractional edge: same 1px tolerance as every
      // other geometry comparison here.
      const before = await probe.eventually(() => world.observation.read(), {
        within: 10_000, label: "reorder targets visible and settled",
        until: value => (mode !== "group" || value.current.rows.every(row => !row.id.startsWith("session:")))
          && [sourceId, targetId].every(id => value.current.rows.some(row => row.id === id
            && row.top >= value.current.viewport.top - 1 && row.bottom <= value.current.viewport.bottom + 1 && Math.abs(row.projectionY) < 1)),
      });
      const from = before.current.rows.find(row => row.id === sourceId)!;
      const to = before.current.rows.find(row => row.id === targetId)!;
      await dragPointer(world.app, from, { x: from.x, y: to.y - 4 });
      const reordered = await probe.eventually(() => world.observation.read(), {
        within: 10_000, label: "trusted drag changes row order and settles",
        until: value => {
          const ids = value.current.rows.map(row => row.id);
          return ids.indexOf(sourceId) < ids.indexOf(targetId)
            && value.current.rows.every(row => Math.abs(row.projectionY) < 1);
        },
      });
      const idsBefore = before.current.rows.map(row => row.id);
      const expected = [...idsBefore];
      expected.splice(expected.indexOf(sourceId), 1);
      expected.splice(expected.indexOf(targetId), 0, sourceId);
      expect(reordered.current.rows.map(row => row.id)).toEqual(expected);
      expect(reordered.current.hash).toBe(initial.current.hash);
      if (mode === "group") {
        // Collapsed panels unmount their session rows; restore the selection witness.
        await user.click({ text: "Expansion group" });
        await probe.eventually(() => world.observation.read(), {
          within: 10_000, label: "selected conversation remains selected after group reorder",
          until: value => value.current.selected.includes(first.sessionId),
        });
      }
      expect((await world.observation.read()).current.selected).toEqual(initial.current.selected);
      const management = await probe.storage("openwork.react.sessionManagement");
      if (mode === "group") expect(management).toMatchObject({ state: { groupsByWorkspace: {
        [world.workspace.workspaceId]: { groups: [{ id: "grp_neighbor" }, { id: "grp_expansion" }] },
      } } });
      else {
        const sessionOrder = [...world.sessions.map(session => session.sessionId), world.neighbor.sessionId];
        sessionOrder.splice(sessionOrder.indexOf(last.sessionId), 1);
        sessionOrder.splice(sessionOrder.indexOf(preceding.sessionId), 0, last.sessionId);
        expect(management).toMatchObject({ state: { orderByWorkspace: { [world.workspace.workspaceId]: sessionOrder } } });
      }
    });
  });
  });
}
});
