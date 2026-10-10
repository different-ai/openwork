import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { organizationDirectory, orgSelection, workspaceMemberships, workspaceSwitcherLayout, type WorkspaceSwitcherMeasurements } from "../worlds/org-selection.ts";

// No existing organization-chooser journey covers the signed-in auth redirect.
// This is Den's real Next browser surface, not the desktop/app-web runtime.
const test = spec.world(orgSelection, {
  resources: { surfaces: ["web"], services: ["den"] },
  timeout: 900_000,
});

test("an owner can choose an organization after sign-in and return from setup to its dashboard", async ({ world, user, probe, step, evidence }) => {
  const directory = async () => {
    const result = await probe.api(world.owner, "/v1/me/orgs");
    expect(result.response.ok).toBe(true);
    return organizationDirectory(result.body);
  };
  const expectSelectedOrganization = async () => {
    const current = await directory();
    expect(current.activeOrgId).toBe(world.second.id);
    expect(current.orgs).toHaveLength(2);
    expect(current.orgs).toEqual(expect.arrayContaining([world.first, world.second]));
    return current;
  };
  const seeDashboard = async () => {
    await user.see({ testId: "den-org-sidebar" }, { timeoutMs: 90_000 });
    await user.see({ role: "button", label: new RegExp(world.second.name) });
    await user.notSee({ testId: "org-chooser-root" });
    await user.notSee({ testId: "den-onboarding-shell" });
    await user.notSee({ text: "Application error" });
  };

  await step("a signed-in owner sees both organizations before choosing where to work", async () => {
    await user.see({ role: "heading", label: "Choose an organization" }, { timeoutMs: 90_000 });
    await user.see({ text: "You belong to 2 organizations. Select one to continue." });
    await user.see({ role: "button", label: new RegExp(world.first.name) });
    await user.see({ role: "button", label: new RegExp(world.second.name) });
    await user.notSee({ testId: "den-org-sidebar" });
    await user.notSee({ role: "textbox", label: "Password" });
    const current = await directory();
    expect(current.orgs).toHaveLength(2);
    expect(current.activeOrgId).toBe(world.first.id);
    evidence.recordAssertionEvidence(
      "Sign-in offers both organizations even when one was already active",
      `The browser started at / with a signed-in session and now shows the chooser with 2 organizations; ${world.first.name} is still active. No dashboard or password form is shown.`,
      true,
    );
    await user.screenshot();
  });

  await step("after: choosing the other organization opens its dashboard without reloading", async () => {
    // The same mounted shell must survive normal -> chooser -> normal renders.
    // Do not replace this click with navigate/reload: that would mask ENG-646.
    const documentStartedAt = await world.documentStartedAt();
    await user.click({ role: "button", label: new RegExp(world.second.name) });
    await seeDashboard();
    await expectSelectedOrganization();
    expect(await world.documentStartedAt()).toBe(documentStartedAt);
    evidence.recordAssertionEvidence(
      "Choosing an organization opens the selected dashboard",
      `${world.second.name} is visible in the dashboard switcher and active in the session; both memberships remain, and the chooser is gone without a document reload.`,
      true,
    );
    await user.screenshot();
  });

  await step("the owner can review optional setup without dashboard navigation", async () => {
    // Existing signup-workspace-intent covers the full signup wizard. Here only
    // revisit its final page to exercise the shell's other early-return branch.
    await user.navigate(new URL("/dashboard/onboarding", world.den.ref.webUrl).toString());
    await user.see({ testId: "den-onboarding-shell" }, { timeoutMs: 90_000 });
    await user.see({ text: "Your workspace is ready" });
    await user.see({ role: "button", label: "Complete setup" });
    await user.notSee({ testId: "den-org-sidebar" });
    await user.notSee({ testId: "org-chooser-root" });
    await expectSelectedOrganization();
    evidence.recordAssertionEvidence(
      "Optional setup belongs to the selected organization",
      `${world.second.name} remains active with 2 memberships; the ready page offers Complete setup without the dashboard sidebar or organization chooser.`,
      true,
    );
    await user.screenshot();
  });

  await step("after: completing setup restores the same organization's dashboard", async () => {
    // This client-side transition must add the normal shell without changing
    // hook order; a full document navigation would not test that boundary.
    const documentStartedAt = await world.documentStartedAt();
    await user.click({ role: "button", label: "Complete setup" });
    await seeDashboard();
    await expectSelectedOrganization();
    expect(await world.documentStartedAt()).toBe(documentStartedAt);
    evidence.recordAssertionEvidence(
      "Completing setup restores the dashboard without a reload",
      `${world.second.name} is visible and still active after Complete setup; the sidebar returns and the setup screen disappears.`,
      true,
    );
    await user.screenshot();
  });

  await step("reloading keeps the chosen organization instead of reopening the chooser", async () => {
    await user.reload();
    await seeDashboard();
    await expectSelectedOrganization();
    evidence.recordAssertionEvidence(
      "The organization choice survives reload",
      `Reload still shows ${world.second.name}'s dashboard with 2 unchanged memberships and no chooser or setup screen.`,
      true,
    );
    await user.screenshot();
  });
});

// Same owner-selection journey; a different arrangement supplies the long-list
// condition before any acts, without changing the existing two-org redirect proof.
const switcherTest = spec.world(workspaceSwitcherLayout, {
  resources: { surfaces: ["web"], services: ["den"] },
  timeout: 900_000,
});

function switcherReachable(measured: WorkspaceSwitcherMeasurements): boolean {
  return measured.visibleMenuCount === 1
    && measured.menu.left >= 0 && measured.menu.top >= 0
    && measured.menu.right <= measured.viewport.width && measured.menu.bottom <= measured.viewport.height
    && [measured.email, measured.search, measured.firstWorkspace, measured.showMore, measured.create, measured.signOut]
      .every((control) => control !== null && control.hitTest && !control.disabled);
}

function switcherEvidence(measured: WorkspaceSwitcherMeasurements): string {
  const hits = [measured.email, measured.search, measured.firstWorkspace, measured.showMore, measured.create, measured.signOut]
    .map((control) => control?.hitTest ?? false);
  return `${measured.viewport.width}×${measured.viewport.height}: popup top=${measured.menu.top.toFixed(1)}, bottom=${measured.menu.bottom.toFixed(1)}, height=${measured.menu.height.toFixed(1)}px; trigger top=${measured.trigger?.top.toFixed(1)}px; native hits for account/search/first workspace/show more/create/sign out=${hits.join("/")}; list ${measured.list?.scrollHeight}/${measured.list?.clientHeight}px, scrollTop=${measured.list?.scrollTop}; clipping ancestors=${JSON.stringify(measured.clippingAncestors)}.`;
}

switcherTest("an owner with many workspaces can switch workspaces on short and narrow screens without losing choices or permissions", async ({ world, user, probe, step, evidence }) => {
  const owner = user.on(world.web);
  const page = probe.on(world.web);
  // Den mounts the desktop and mobile sidebar independently. The mobile trigger
  // is the second DOM instance; the first remains hidden below the md breakpoint.
  const mobileTrigger = { testId: "workspace-switcher-trigger", nth: 1 };
  const captures: WorkspaceSwitcherMeasurements[] = [];
  const directory = async () => {
    const result = await probe.api(world.owner, "/v1/me/orgs");
    expect(result.response.ok).toBe(true);
    return workspaceMemberships(result.body);
  };
  const settledMeasurements = async () => {
    let previousGeometry = "";
    let stableSamples = 0;
    return page.eventually(world.measurements, {
      within: 5_000, intervalMs: 100, label: "native popup and drawer geometry to settle after their motion",
      until: (measured) => {
        const geometry = JSON.stringify({ viewport: measured.viewport, menu: measured.menu, trigger: measured.trigger, list: measured.list });
        stableSamples = !measured.motionRunning && geometry === previousGeometry ? stableSamples + 1 : 0;
        previousGeometry = geometry;
        // Three matching observations, with no running drawer/popup animation,
        // cover the drawer's 200ms transition without a blind sleep or scroll.
        return stableSamples >= 3;
      },
    });
  };
  const openSwitcher = async () => {
    await owner.click(mobileTrigger);
    // Read-only polling, NOT user.see on a popup child: even a visibility check
    // could mask clipping by scrolling. The following hit test stays native.
    return settledMeasurements();
  };

  await step("the owner opens 24 real workspace choices on a short landscape screen", async () => {
    await owner.see({ role: "button", label: "Open menu" }, { timeoutMs: 90_000 });
    const current = await directory();
    expect(current.orgs).toEqual(world.initialMemberships);
    expect(current.activeOrgId).toBe(world.first.id);
    await owner.click({ role: "button", label: "Open menu" });
    const measured = await openSwitcher();
    captures.push(measured);
    expect(measured.viewport).toMatchObject({ width: 667, height: 375 });
    expect(measured.workspaceNames).toHaveLength(20);
    expect(measured.search).not.toBeNull();
    expect(measured.showMore?.text).toBe("Show more (4)");
    expect(measured.list?.scrollHeight).toBeGreaterThan(measured.list?.clientHeight ?? 0);
    expect(measured.list?.scrollTop).toBe(0);
    expect(measured.menu.scrollTop).toBe(0);
    evidence.recordAssertionEvidence("24 authorized memberships exercise a genuinely overflowing workspace list", `Den returned exactly 24 owner memberships; 20 choices are rendered with 4 behind Show more and no scroll or popup-child act has occurred. ${switcherEvidence(measured)}`, true);
    // Capture the ACTUAL OPEN popup even when the following reachability claim
    // will fail. A closed-menu screenshot would not witness this cutoff.
    await owner.screenshot();
  });

  await step("the same owner opens the long workspace list on a narrow portrait screen", async () => {
    await owner.press("Escape");
    await owner.resizeViewport({ width: 320, height: 568, deviceScaleFactor: 1 });
    const measured = await openSwitcher();
    captures.push(measured);
    expect(measured.viewport).toMatchObject({ width: 320, height: 568 });
    expect(measured.workspaceNames).toHaveLength(20);
    expect(measured.list?.scrollTop).toBe(0);
    expect(measured.menu.scrollTop).toBe(0);
    expect((await directory()).orgs).toEqual(world.initialMemberships);
    evidence.recordAssertionEvidence("the same authorized long list is opened at 320×568 before any scrolling", switcherEvidence(measured), true);
    await owner.screenshot();
  });

  await step("after: workspace search and account actions are reachable in both screens without scrolling", async () => {
    await owner.notSee({ text: "Application error" });
    const reachable = captures.every(switcherReachable);
    evidence.recordAssertionEvidence("the whole workspace popup fits and its account actions accept native pointer input", captures.map(switcherEvidence).join("\n"), reachable);
    // The first two steps deliberately collect BOTH open-menu screenshots and
    // native height/hit witnesses before this assertion can stop the baseline.
    for (const measured of captures) {
      expect(measured.visibleMenuCount).toBe(1);
      expect(measured.menu.top).toBeGreaterThanOrEqual(0);
      expect(measured.menu.bottom).toBeLessThanOrEqual(measured.viewport.height);
      expect(measured.menu.left).toBeGreaterThanOrEqual(0);
      expect(measured.menu.right).toBeLessThanOrEqual(measured.viewport.width);
      expect(measured.viewport.documentWidth).toBeLessThanOrEqual(measured.viewport.width);
      expect(measured.email?.text).toBe(world.owner.email);
      expect(measured.createHref).toBe("/organization");
      for (const control of [measured.email, measured.search, measured.firstWorkspace, measured.showMore, measured.create, measured.signOut]) {
        expect(control?.hitTest).toBe(true);
      }
    }
  });

  await step("Escape returns focus to the current workspace and the keyboard can reopen its choices", async () => {
    await owner.press("Escape");
    await owner.notSee({ testId: "workspace-switcher-menu" });
    let triggers = (await page.dom('[data-testid="workspace-switcher-trigger"]')).elements.filter((element) => element.rect.width > 0);
    expect(triggers).toHaveLength(1);
    expect(triggers[0]?.focused).toBe(true);
    await owner.press("Enter");
    await page.eventually(async () => (await page.dom('[data-testid="workspace-switcher-menu"]')).elements.some((element) => element.rect.width > 0), {
      within: 10_000, label: "keyboard-opened workspace choices", until: (visible) => visible,
    });
    const reopened = await world.measurements();
    expect(reopened.visibleMenuCount).toBe(1);
    expect(reopened.focusInside).toBe(true);
    await owner.press("Escape");
    await owner.notSee({ testId: "workspace-switcher-menu" });
    triggers = (await page.dom('[data-testid="workspace-switcher-trigger"]')).elements.filter((element) => element.rect.width > 0);
    expect(triggers[0]?.focused).toBe(true);
    evidence.recordAssertionEvidence("keyboard dismissal restores the visible workspace control", "Escape closed the popup and focused the mobile workspace trigger; Enter opened one popup with focus inside it, and a second Escape returned focus to the same trigger.", true);
    await owner.screenshot();
  });

  await step("the owner can reveal all authorized choices and switch to a workspace found by search", async () => {
    await openSwitcher();
    await owner.click({ role: "button", label: "Show more (4)" });
    const expanded = await world.measurements();
    expect(expanded.workspaceNames).toHaveLength(24);
    expect([...expanded.workspaceNames].sort()).toEqual(world.initialMemberships.map((org) => org.name).sort());
    expect(expanded.workspaceNames).not.toContain(world.outside.name);
    await owner.type({ placeholder: "Search workspaces" }, world.last.name, { replace: true });
    await owner.see({ role: "button", label: new RegExp(world.last.name) });
    await owner.click({ role: "button", label: new RegExp(world.last.name) });
    await owner.notSee({ testId: "workspace-switcher-menu" });
    await page.eventually(directory, {
      within: 30_000, label: "the selected workspace to become active", until: (current) => current.activeOrgId === world.last.id,
    });
    const current = await directory();
    expect(current.orgs).toEqual(world.initialMemberships);
    const visibleTrigger = (await page.dom('[data-testid="workspace-switcher-trigger"]')).elements.find((element) => element.rect.width > 0);
    expect(visibleTrigger?.text).toContain(world.last.name);
    evidence.recordAssertionEvidence("search switches only the active workspace, not memberships or roles", `Show more exposed all 24 authorized choices. Searching and choosing ${world.last.name} made it active; all 24 membership IDs, workspace identities and roles are unchanged, and ${world.outside.name} was never offered.`, true);
    await owner.screenshot();
  });

  await step("an outside account's workspace is never offered to the owner", async () => {
    await openSwitcher();
    await owner.type({ placeholder: "Search workspaces" }, world.outside.name, { replace: true });
    await owner.see({ text: "No organizations match your search." });
    await owner.notSee({ role: "button", label: new RegExp(world.outside.name) });
    const outsideResult = await probe.api(world.outsider, "/v1/me/orgs");
    expect(outsideResult.response.ok).toBe(true);
    const outside = workspaceMemberships(outsideResult.body);
    expect(outside.orgs.map((org) => ({ id: org.id, name: org.name }))).toEqual([world.outside]);
    const current = await directory();
    expect(current.activeOrgId).toBe(world.last.id);
    expect(current.orgs).toEqual(world.initialMemberships);
    const empty = await world.measurements();
    expect(empty.workspaceNames).toEqual([]);
    expect(empty.createHref).toBe("/organization");
    expect(empty.create?.hitTest).toBe(true);
    expect(empty.signOut?.hitTest).toBe(true);
    evidence.recordAssertionEvidence("workspace search is scoped to verified memberships, including its empty state", `${world.outside.name} belongs only to the separately signed-in outside account. The owner's search is empty, their selected workspace and 24 memberships stay unchanged, and Create or join workspace and Sign out remain reachable.`, true);
    await owner.screenshot();
  });

  await step("an outside press closes workspace choices and create or join keeps its existing destination", async () => {
    await owner.click({ role: "button", label: "Close menu", nth: 1 });
    await owner.notSee({ testId: "workspace-switcher-menu" });
    await owner.click({ role: "button", label: "Open menu" });
    await openSwitcher();
    await owner.click({ role: "link", label: /Create or join workspace/ });
    await owner.see({ role: "heading", label: "Settings" }, { timeoutMs: 30_000 });
    await owner.see({ role: "button", label: "Organizations" });
    expect((await directory()).orgs).toEqual(world.initialMemberships);
    evidence.recordAssertionEvidence("outside dismissal and the existing membership-management action still work", "Pressing the drawer's close button dismissed the popup; reopening and choosing Create or join workspace opened the existing Settings page with Organizations and left every owner membership unchanged.", true);
    await owner.screenshot();
  });

  await step("the selected workspace's account menu can still sign the owner out", async () => {
    await owner.navigate(new URL("/dashboard", world.den.ref.webUrl).toString());
    await owner.see({ role: "button", label: "Open menu" }, { timeoutMs: 30_000 });
    await owner.click({ role: "button", label: "Open menu" });
    const measured = await openSwitcher();
    expect(measured.trigger?.text).toContain(world.last.name);
    expect(measured.email?.text).toBe(world.owner.email);
    await owner.click({ role: "button", label: "Sign out" });
    await owner.see({ testId: "auth-landing-form" }, { timeoutMs: 30_000 });
    await owner.notSee({ testId: "workspace-switcher-menu" });
    await owner.notSee({ testId: "den-org-sidebar" });
    evidence.recordAssertionEvidence("sign out still acts on the selected workspace's signed-in account", `${world.last.name}'s menu showed the owner's email; Sign out returned to the real signed-out account form with no workspace popup or dashboard sidebar.`, true);
    await owner.screenshot();
  });
});
