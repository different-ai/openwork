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
    const heading = document.querySelector('[data-session-header] h1');
     const toggle = [...document.querySelectorAll('[data-slot="sidebar-trigger"]')]
      .find((element) => !element.closest('[inert]') && element.getBoundingClientRect().width > 0);
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

  if (platformClasses.includes("openwork-platform-mac")) {
    await step("native macOS fullscreen removes traffic-light clearance and shortens the titlebar", async () => {
      await world.clearViewport();
      await world.fullscreen(true);
      await probe.eventually(() => probe.dom('html[data-window-fullscreen="true"] [data-sidebar-titlebar]'), {
        within: 10_000, label: "native fullscreen event reaches the titlebar", until: (value) => value.elements[0]?.rect.height === 40,
      });
      await user.see({ text: session.title });
      expect((await probe.dom('[data-sidebar-titlebar] [data-sidebar-toggle]')).elements[0]?.rect.left).toBe(8);
      await user.screenshot();
    });
    await step("leaving native fullscreen restores the traffic-light clearance", async () => {
      await world.fullscreen(false);
      await probe.eventually(() => probe.dom('html[data-window-fullscreen="false"] [data-sidebar-titlebar]'), {
        within: 10_000, label: "windowed titlebar returns", until: (value) => value.elements[0]?.rect.height === 48,
      });
      await user.see({ text: session.title });
      expect((await probe.dom('[data-sidebar-titlebar] [data-sidebar-toggle]')).elements[0]?.rect.left).toBe(88);
      await user.screenshot();
    });
  }
});

test("a desktop user sees one boundary below the conversation title in either appearance", async ({ world, user, agent, probe, step, evidence }) => {
  const [session] = world.sessions;
  if (!session) throw new Error("The sidebar world did not seed a session.");
  await user.resizeViewport({ width: 1400, height: 800, deviceScaleFactor: 1 });

  for (const theme of ["dark", "light"]) {
    await step(`the ${theme} desktop titlebar has no extra divider above the inset chat pane`, async () => {
      // Select the real setting so Electron's native vibrancy and the renderer
      // use the same theme; CDP media emulation changes only the renderer.
      await agent.run("route.settings.appearance");
      await user.click({ role: "button", label: theme === "dark" ? "Dark" : "Light" });
      await probe.eventually(() => probe.dom("html"), {
        within: 5_000, label: `${theme} appearance applied`, until: (value) => value.elements[0]?.style.colorScheme === theme,
      });
      await user.click({ role: "button", label: "Back to app" });
      await user.see({ text: session.title });
      const [header, pane] = (await probe.dom("[data-session-header], [data-session-pane]")).elements;
      if (!header || !pane) throw new Error("The session titlebar and pane must be visible");
      const geometry = {
        theme: header.style.colorScheme,
        headerBorder: header.style.borderBottomWidth,
        paneBorder: pane.style.borderTopWidth,
        paneRadius: pane.style.borderTopLeftRadius,
        inset: pane.rect.top - header.rect.bottom,
      };
      const cleanBoundary = geometry.theme === theme && geometry.headerBorder === "0px"
        && geometry.paneBorder === "1px" && geometry.paneRadius === "14px" && geometry.inset === 8;
      evidence.recordAssertionEvidence(
        "Only the rounded chat pane defines the boundary below the title",
        JSON.stringify(geometry), cleanBoundary,
      );
      // Renderer evidence only: macOS vibrancy is outside CDP's captured pixels.
      // Use a native window capture for presentation of the complete desktop.
      await user.screenshot();
      expect(cleanBoundary).toBe(true);
    });
  }

  await step("a narrow conversation keeps its titlebar separator", async () => {
    await user.resizeViewport({ width: 900, height: 800, deviceScaleFactor: 1 });
    await user.see({ text: session.title });
    const border = (await probe.dom("[data-session-header]")).elements[0]?.style.borderBottomWidth;
    evidence.recordAssertionEvidence("The narrow titlebar keeps its separator", `Border: ${border}`, border === "1px");
    await user.screenshot();
    expect(border).toBe("1px");
  });

  await step("flat pages keep their titlebar separator", async () => {
    await user.resizeViewport({ width: 1400, height: 800, deviceScaleFactor: 1 });
    await user.click({ text: "Dashboard" });
    await user.see({ role: "heading", label: "Dashboard" });
    const border = (await probe.dom("[data-session-header]")).elements[0]?.style.borderBottomWidth;
    evidence.recordAssertionEvidence("The Dashboard keeps its separator", `Border: ${border}`, border === "1px");
    await user.screenshot();
    expect(border).toBe("1px");
  });
});
