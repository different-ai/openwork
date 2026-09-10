import { expect } from "vitest";
import { browserScript, spec, type Probe } from "@openwork/testkit";
import { macSidebar } from "../worlds/session-shell.ts";

const test = spec.world(macSidebar);

/**
 * On macOS the session title shares the titlebar with the native window
 * controls and the floating show/hide sidebar toggle. Whenever the sidebar is
 * not an expanded inline panel — collapsed on a desktop-width window, or a
 * sheet below the desktop breakpoint — the header must reserve the room those
 * controls occupy, or the first word of the title is drawn under them.
 *
 * The `mac:` variant is CSS-only (`html.openwork-electron.openwork-platform-mac`),
 * so the titlebar layout is exercised by adding those classes even when the
 * desktop host is Linux.
 */
const minimumClearancePx = 16;

interface TitlebarGeometry {
  width: number;
  inlineSidebar: boolean;
  sheetOpen: boolean;
  sidebarState: string;
  toggleRight: number;
  titleLeft: number;
  titleText: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function titlebar(probe: Probe): Promise<TitlebarGeometry> {
  // TODO(primitive): probe.geometry should compare the session title with the painted titlebar toggle.
  const value = await probe.eval(() => {
    const heading = document.querySelector('[data-session-pane] header h1');
    const toggle = [...document.querySelectorAll('[data-slot="sidebar-trigger"]')]
      .find((element) => element.getBoundingClientRect().width > 0);
    if (!(heading instanceof HTMLElement) || !(toggle instanceof HTMLElement)) return null;
    const inline = document.querySelector('[data-slot="sidebar"][data-state]');
    return {
      width: window.innerWidth,
      inlineSidebar: inline !== null,
      sheetOpen: document.querySelector('[data-slot="sidebar"][data-mobile="true"]') !== null,
      sidebarState: inline?.getAttribute('data-state') ?? "",
      toggleRight: toggle.getBoundingClientRect().right,
      titleLeft: heading.getBoundingClientRect().left,
      titleText: (heading.textContent ?? "").trim(),
    };
  });
  if (!isRecord(value)
    || typeof value.width !== "number"
    || typeof value.inlineSidebar !== "boolean"
    || typeof value.sheetOpen !== "boolean"
    || typeof value.sidebarState !== "string"
    || typeof value.toggleRight !== "number"
    || typeof value.titleLeft !== "number"
    || typeof value.titleText !== "string") throw new Error(`Titlebar geometry was not readable: ${JSON.stringify(value)}`);
  return {
    width: value.width,
    inlineSidebar: value.inlineSidebar,
    sheetOpen: value.sheetOpen,
    sidebarState: value.sidebarState,
    toggleRight: value.toggleRight,
    titleLeft: value.titleLeft,
    titleText: value.titleText,
  };
}

function clearance(geometry: TitlebarGeometry): number {
  return geometry.titleLeft - geometry.toggleRight;
}

test("the macOS session title stays clear of the titlebar controls in every sidebar state and window width", async ({ world, user, seed, probe, step }) => {
  const [session] = world.sessions;
  if (!session) throw new Error("The mac sidebar world did not seed a session.");
  await user.see({ text: session.title });
  const platformClasses = await seed.evalIn(world.app, () => document.documentElement.className);
  if (typeof platformClasses !== "string") throw new Error("Desktop platform classes were not readable.");
  await seed.evalIn(world.app, () => {
    document.documentElement.classList.remove('openwork-platform-linux', 'openwork-platform-windows');
    document.documentElement.classList.add('openwork-electron', 'openwork-platform-mac');
  });
  // TODO(primitive): user.resizeViewport should set a desktop surface's width.
  const resize = (width: number) => world.app.client.send("Emulation.setDeviceMetricsOverride", {
    width,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
  });
  // The header animates its reserved padding, so hold until the title rests.
  const settled = (predicate: (geometry: TitlebarGeometry) => boolean, label: string) => probe.eventually(async () => {
    const first = await titlebar(probe);
    await new Promise((resolve) => setTimeout(resolve, 250));
    const second = await titlebar(probe);
    return first.titleLeft === second.titleLeft && predicate(second) ? second : null;
  }, {
    within: 15_000,
    label,
    until: (geometry) => geometry !== null,
  });

  await step("below the desktop breakpoint with the sidebar hidden, the title clears the traffic lights and toggle", async () => {
    await resize(900);
    const hidden = await settled((geometry) => geometry.width === 900 && !geometry.inlineSidebar && !geometry.sheetOpen, "narrow window with the sidebar hidden");
    if (!hidden) throw new Error("Narrow titlebar geometry did not settle.");
    expect(hidden.titleText).toBe(session.title);
    expect(clearance(hidden)).toBeGreaterThanOrEqual(minimumClearancePx);
    await user.screenshot();
  });

  await step("opening the sidebar sheet does not move the title", async () => {
    const before = await titlebar(probe);
    await user.press("Meta+b");
    const open = await settled((geometry) => geometry.sheetOpen, "narrow window with the sidebar sheet open");
    if (!open) throw new Error("Sheet-open titlebar geometry did not settle.");
    expect(open.inlineSidebar).toBe(false);
    expect(open.titleLeft).toBe(before.titleLeft);
    expect(clearance(open)).toBeGreaterThanOrEqual(minimumClearancePx);
    await user.press("Meta+b");
    await settled((geometry) => !geometry.sheetOpen, "narrow window after closing the sidebar sheet");
  });

  await step("on a desktop-width window the title follows the inline sidebar and clears the toggle once it collapses", async () => {
    await resize(1400);
    const expanded = await settled((geometry) => geometry.width === 1400 && geometry.sidebarState === "expanded", "desktop window with the sidebar expanded");
    if (!expanded) throw new Error("Expanded titlebar geometry did not settle.");
    // TODO(primitive): probe.geometry should read the inline sidebar's right edge.
    const sidebarRight = await probe.eval(() => document.querySelector('[data-slot="sidebar-gap"]')?.getBoundingClientRect().right ?? null);
    if (typeof sidebarRight !== "number") throw new Error("The inline sidebar had no measurable width.");
    expect(sidebarRight).toBeGreaterThan(expanded.toggleRight);
    expect(expanded.titleLeft).toBeGreaterThan(sidebarRight);
    await user.press("Meta+b");
    const collapsed = await settled((geometry) => geometry.sidebarState === "collapsed", "desktop window with the sidebar collapsed");
    if (!collapsed) throw new Error("Collapsed titlebar geometry did not settle.");
    expect(collapsed.titleLeft).toBeLessThan(expanded.titleLeft);
    expect(clearance(collapsed)).toBeGreaterThanOrEqual(minimumClearancePx);
    await user.screenshot();
    await user.press("Meta+b");
    await settled((geometry) => geometry.sidebarState === "expanded", "desktop window after reopening the sidebar");
  });

  await seed.evalIn(world.app, browserScript((classes: string) => { document.documentElement.className = classes; }, [platformClasses]));
});
