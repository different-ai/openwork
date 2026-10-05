import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { organizationDirectory, orgSelection } from "../worlds/org-selection.ts";

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
