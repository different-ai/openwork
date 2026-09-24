import { expect } from "vitest";
import type { Target } from "@openwork/cdp";
import { spec } from "@openwork/testkit";
import { sidebarChrome } from "../worlds/sidebar-chrome.ts";

const test = spec.world(sidebarChrome, {
  resources: { surfaces: ["desktop"], services: ["den"], nativeReason: "The sidebar shares the native Electron titlebar, traffic-light clearance and platform shortcuts." },
});

test("a member can search and read notifications from either titlebar while session selection follows the destination", async ({ world, user, agent, probe, step }) => {
  const search: Target = { role: "button", label: "Search sessions" };
  const bell: Target = { role: "button", label: /^Notifications/ };
  const hideSidebar: Target = { testId: "sidebar-sidebar-toggle" };
  const showSidebar: Target = { testId: "main-sidebar-toggle" };
  const newSession: Target = { role: "button", label: "New session" };
  const sessionsBefore = await agent.list();
  const selected = () => probe.dom('[data-sidebar="menu-button"][aria-current="page"]');
  const openNotifications = async () => {
    await user.click(bell);
    await user.see({ text: "1 new provider available" });
    await probe.eventually(world.presentation, {
      within: 5_000, label: "notifications finish opening", until: (value) => value.panelSettled,
    });
  };
  const closeNotifications = async () => {
    await user.press("Escape");
    await probe.eventually(() => probe.dom('[data-notification-panel]'), {
      within: 5_000, label: "notifications finish closing", until: (value) => value.elements.length === 0,
    });
    await user.notSee({ text: "1 new provider available" });
  };

  await step("before: Dashboard and New session have separate destinations and only Dashboard is selected", async () => {
    await user.click({ role: "button", label: "Dashboard" });
    await user.see({ role: "heading", label: "Dashboard" });
    await user.see(newSession);
    await user.see({ role: "button", label: "Automations" });
    await user.see({ role: "button", label: "Library" });
    expect((await selected()).elements.map((element) => element.text)).toEqual(["Dashboard"]);
    expect((await probe.dom('[data-sidebar-actions] button')).elements).toHaveLength(2);
    expect((await probe.dom('[data-notification-unread]')).elements).toHaveLength(1);
    await user.screenshot();
  });

  await step("after: starting a draft leaves navigation unselected and creates no empty session", async () => {
    await user.click(newSession);
    await user.see("composer", { editable: true });
    await user.hover({ role: "heading", label: "What do you need done?" });
    expect((await selected()).elements).toHaveLength(0);
    expect(await agent.list()).toEqual(sessionsBefore);
    // The regression was a permanent background, despite inactive navigation.
    expect((await world.presentation()).newSessionBackground).toBe("rgba(0, 0, 0, 0)");
    await user.screenshot();
    await user.click({ role: "button", label: "Dashboard" });
    await user.press(`${world.modifier}+n`);
    await user.see("composer", { editable: true });
    expect((await selected()).elements).toHaveLength(0);
    expect(await agent.list()).toEqual(sessionsBefore);
  });

  await step("the search icon opens the existing session search and the result selects its session", async () => {
    await user.click(search);
    await user.type({ placeholder: "Search all sessions and messages…" }, "Planning");
    await user.see({ role: "option", label: /Planning notes/ });
    await user.screenshot();
    await user.press("Enter");
    await user.see({ role: "heading", label: "Planning notes" });
    expect((await probe.dom(`[data-testid="sidebar-session-${world.session.sessionId}"][data-session-tab-active="true"]`)).elements).toHaveLength(1);
    await user.screenshot();
  });

  await step("opening the bell clears its unread dot while the notification is still visible", async () => {
    await openNotifications();
    expect((await probe.dom('[data-notification-unread]')).elements).toHaveLength(0);
    await user.screenshot();
    await closeNotifications();
    expect((await probe.dom('[data-notification-bell]')).elements[0]?.focused).toBe(true);
  });

  await step("hiding the sidebar keeps search and notifications in the main titlebar", async () => {
    await user.click(hideSidebar);
    await probe.eventually(() => probe.dom('[data-slot="sidebar-gap"]'), {
      within: 5_000, label: "sidebar finishes closing", until: (value) => value.elements[0]?.rect.width === 0,
    });
    expect((await probe.dom('[data-session-header] [data-sidebar-actions] button')).elements).toHaveLength(2);
    await openNotifications();
    await user.screenshot();
    await closeNotifications();
    await user.click(search);
    await user.see({ placeholder: "Search all sessions and messages…" });
    await user.press("Escape");
    await probe.eventually(() => probe.dom('[placeholder="Search all sessions and messages…"]'), {
      within: 5_000, label: "session search closes", until: (value) => value.elements.length === 0,
    });
    await user.screenshot();
    await user.click(showSidebar);
    await user.see(newSession);
  });

  await step("reduced motion keeps the same controls and disables sidebar movement", async () => {
    await world.reducedMotion(true);
    await user.click(hideSidebar);
    expect((await world.presentation()).sidebarTransitions).toEqual(["none", "none"]);
    await openNotifications();
    expect((await world.presentation()).panelAnimation).toBe("none");
    await user.screenshot();
    await closeNotifications();
    await user.click(showSidebar);
    await world.reducedMotion(false);
  });
});
