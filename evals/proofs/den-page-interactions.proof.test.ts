import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { denPageInteractionsWorld } from "../worlds/den-page-interactions.ts";

const test = spec.world(denPageInteractionsWorld, {
  timeout: 600_000,
  resources: { surfaces: ["web"], services: ["den"] },
});

const auditRows = '[data-testid="audit-compact-operation"]';

test("an owner uses the new page interactions while an opted-out administrator and a read-only teammate retain their boundaries", async ({ world, user, probe, step, evidence }) => {
  const owner = user.on(world.owner);
  const legacy = user.on(world.legacy);
  const viewer = user.on(world.viewer);
  const ownerProbe = probe.on(world.owner);
  const legacyProbe = probe.on(world.legacy);
  const viewerProbe = probe.on(world.viewer);

  await step("before: an opted-out administrator keeps the persistent settings save action", async () => {
    await legacy.see({ role: "heading", label: "Org settings" }, { timeoutMs: 60_000 });
    await legacy.see({ role: "button", label: "Save settings" });
    await legacy.notSee({ role: "button", label: "Discard" });
    const saved = await world.organizationName();
    evidence.recordAssertionEvidence("Opting out preserves the save action without changing saved settings", String(saved), saved === "Page consistency studio");
    expect(saved).toBe("Page consistency studio");
    await legacy.screenshot();
  });

  await step("after: an owner can discard an unsaved name without writing it", async () => {
    await owner.see({ role: "heading", label: "Org settings" }, { timeoutMs: 60_000 });
    await owner.notSee({ testId: "org-settings-save-bar" });
    await owner.type({ role: "textbox", label: "Name" }, "Discarded name", { replace: true });
    await owner.see({ testId: "org-settings-save-bar" });
    await owner.screenshot();
    await owner.click({ role: "button", label: "Discard" });
    await owner.notSee({ testId: "org-settings-save-bar" });
    const saved = await world.organizationName();
    evidence.recordAssertionEvidence("Discard removes the save bar and leaves the persisted name untouched", String(saved), saved === "Page consistency studio");
    expect(saved).toBe("Page consistency studio");
    await owner.screenshot();
  });

  await step("the owner saves a name and it survives a reload", async () => {
    await owner.type({ role: "textbox", label: "Name" }, "Page consistency saved", { replace: true });
    await owner.click({ role: "button", label: "Save changes" });
    await owner.see({ text: "Workspace settings updated." }, { timeoutMs: 30_000 });
    await owner.notSee({ testId: "org-settings-save-bar" });
    const saved = await probe.eventually(() => world.organizationName(), {
      within: 10_000, label: "the new name is persisted", until: value => value === "Page consistency saved",
    });
    await owner.reload();
    await owner.see({ role: "heading", label: "Org settings" });
    await owner.notSee({ testId: "org-settings-save-bar" });
    evidence.recordAssertionEvidence("A successful save remains clean after reloading", String(saved), saved === "Page consistency saved");
    expect(saved).toBe("Page consistency saved");
    await owner.screenshot();
  });

  await step("a read-only teammate cannot edit settings or the team", async () => {
    await viewer.reload();
    await viewer.see({ role: "heading", label: "Org settings" }, { timeoutMs: 30_000 });
    const settings = await viewerProbe.dom('main main input[disabled]');
    await viewer.notSee({ testId: "org-settings-save-bar" });
    await viewer.navigate(world.url(`/dashboard/members/teams/${world.teamId}?tab=overview`));
    await viewer.see({ testId: "team-edit-locked" }, { timeoutMs: 30_000 });
    const locked = await viewerProbe.dom('[data-testid="team-edit-locked"][disabled]');
    const saved = await world.organizationName();
    const ok = settings.elements.length > 0 && locked.elements.length === 1 && saved === "Page consistency saved";
    evidence.recordAssertionEvidence("Read-only controls stay disabled and the owner's saved value is unchanged", `disabled fields=${settings.elements.length}; locked team action=${locked.elements.length}; name=${saved}`, ok);
    expect(ok).toBe(true);
    await viewer.screenshot();
  });

  await step("the owner opens the existing team editor while the opted-out administrator keeps the old entry points", async () => {
    const teamUrl = world.url(`/dashboard/members/teams/${world.teamId}?tab=overview`);
    await legacy.navigate(teamUrl);
    await legacy.see({ role: "heading", label: "Readers" });
    await legacy.notSee({ testId: "team-edit" });
    await owner.navigate(world.url("/dashboard/members?tab=teams"));
    await owner.see({ testId: "team-row" });
    await owner.click({ role: "button", label: "Actions for Readers" });
    await owner.see({ role: "menuitem", label: "Edit" });
    await owner.press("Escape");
    // Closing the menu restores keyboard focus to its trigger; Enter must reopen it without following the row link.
    await owner.press("Enter");
    await owner.see({ role: "menuitem", label: "Edit" });
    await owner.press("Escape");
    // The row's centre includes plain lane text, not just its name link.
    await owner.click({ testId: "team-row" });
    await owner.see({ role: "heading", label: "Readers" });
    await owner.see({ testId: "team-edit" });
    await owner.click({ testId: "team-edit" });
    await owner.see({ testId: "team-dialog" }, { timeoutMs: 30_000 });
    const dialog = await ownerProbe.dom('[data-testid="team-dialog"] input[value="Readers"]');
    const ok = dialog.elements.length === 1;
    evidence.recordAssertionEvidence("Edit team opens the existing form with the selected team's name", `prefilled Readers fields=${dialog.elements.length}`, ok);
    expect(ok).toBe(true);
    await owner.screenshot();
    await owner.press("Escape");
  });

  await step("the owner shares a plugin with a team while a viewer cannot change either sharing editor", async () => {
    await owner.navigate(world.url(`/dashboard/plugins/${world.pluginId}`));
    await owner.see({ testId: "who-can-use-it" }, { timeoutMs: 30_000 });
    await owner.click({ testId: "access-add-team" });
    await owner.click({ testId: `access-add-team-option-${world.teamId}` });
    await owner.click({ testId: "access-add-team-confirm" });
    const grants = await probe.eventually(() => world.pluginAudience(), { within: 15_000, label: "the Readers grant is saved", until: items => items.some(item => item.teamId === world.teamId) });
    await viewer.navigate(world.url(`/dashboard/plugins/${world.pluginId}`));
    await viewer.see({ testId: "plugin-manage-locked" }, { timeoutMs: 30_000 });
    const audienceButtons = await viewerProbe.dom('[data-testid="who-can-use-it"] button:not([disabled])');
    await viewer.navigate(world.url(`/dashboard/plugins/${world.pluginId}/details`));
    await viewer.see({ testId: "plugin-access-read-only" }, { timeoutMs: 30_000 });
    const editorButtons = await viewerProbe.dom('[data-testid^="plugin-access-add-"]:not([disabled])');
    const after = await world.pluginAudience();
    const ok = grants.some(item => item.teamId === world.teamId) && audienceButtons.elements.length === 0
      && editorButtons.elements.length === 0 && after.length === grants.length;
    evidence.recordAssertionEvidence("Shared viewers keep read-only controls in both audience and role-grant views", `grants=${grants.length}; after=${after.length}; enabled audience controls=${audienceButtons.elements.length}; enabled grant pickers=${editorButtons.elements.length}`, ok);
    expect(ok).toBe(true);
    await viewer.screenshot();
  });

  await step("after: Analytics removes the personal-runs tab only for the enabled owner", async () => {
    const analytics = world.url("/dashboard/analytics");
    await legacy.navigate(analytics);
    await legacy.see({ role: "link", label: "Workflow Runs" }, { timeoutMs: 30_000 });
    await owner.navigate(analytics);
    await owner.see({ role: "heading", label: "Analytics" });
    await owner.notSee({ role: "link", label: "Workflow Runs" });
    const tabs = await ownerProbe.dom('nav[aria-label="Analytics views"] a');
    const ok = tabs.elements.length > 0 && !tabs.elements.some(entry => entry.text === "Workflow Runs");
    evidence.recordAssertionEvidence("The new navigation does not leak to an opted-out member", tabs.elements.map(entry => entry.text).join(" | "), ok);
    expect(ok).toBe(true);
    await owner.screenshot();
    await owner.navigate(world.url("/dashboard/analytics/workflow-runs"));
    await owner.see({ role: "link", label: "Workflow Runs" });
  });

  await step("an opted-out administrator applies audit filters explicitly", async () => {
    await legacy.navigate(world.url("/dashboard/audit-logs"));
    await legacy.see({ role: "button", label: "Apply filters" }, { timeoutMs: 30_000 });
    await legacy.type({ placeholder: "Filter by exact ID" }, "synthetic-no-such-id", { replace: true });
    await legacy.click({ role: "button", label: "Apply filters" });
    await legacy.see({ text: "Nothing matches these filters" });
    const result = await legacyProbe.dom(auditRows);
    evidence.recordAssertionEvidence("Explicit apply removes nonmatching audit operations", `rows=${result.elements.length}`, result.elements.length === 0);
    expect(result.elements).toHaveLength(0);
    await legacy.screenshot();
  });

  await step("after: the owner filters audit history without an Apply step", async () => {
    await owner.navigate(world.url("/dashboard/audit-logs"));
    await owner.see({ placeholder: "Filter by exact ID" }, { timeoutMs: 30_000 });
    await owner.notSee({ role: "button", label: "Apply filters" });
    await owner.type({ placeholder: "Filter by exact ID" }, "synthetic-no-such-id", { replace: true });
    await owner.see({ text: "Nothing matches these filters" });
    const result = await ownerProbe.dom(auditRows);
    evidence.recordAssertionEvidence("Immediate filters return only matching history", `rows=${result.elements.length}`, result.elements.length === 0);
    expect(result.elements).toHaveLength(0);
    await owner.screenshot();
  });
});
