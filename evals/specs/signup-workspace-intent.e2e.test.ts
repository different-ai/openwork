import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { signupWorkspace } from "../worlds/signup-workspace.ts";

// New journey: an account with no organization makes its first personal/team
// choice, then reviews and persists desktop access before inviting anyone.
const test = spec.world(signupWorkspace, { timeout: 600_000 });
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

test("signup distinguishes joining, personal work, and restricted team setup without changing another organization", async ({ world, user, probe, evidence, step }) => {
  const orgs = async () => {
    const result = await probe.api(world.den.admin, "/v1/me/orgs");
    expect(result.response.ok).toBe(true);
    if (!isRecord(result.body) || !Array.isArray(result.body.orgs)) throw new Error("Expected organization list");
    return result.body.orgs.filter(isRecord);
  };
  const policyFor = async (id: string) => {
    const result = await probe.api(world.den.admin, "/v1/desktop-policies", { headers: { "x-openwork-org-id": id } });
    expect(result.response.ok).toBe(true);
    if (!isRecord(result.body) || !Array.isArray(result.body.desktopPolicies)) throw new Error("Expected desktop policies");
    const policy = result.body.desktopPolicies.filter(isRecord).find((entry) => entry.isDefault === true);
    if (!policy || !isRecord(policy.policy)) throw new Error("Expected default desktop policy");
    return policy.policy;
  };

  await step("a fresh account can review joining without creating an organization", async () => {
    await user.see({ text: "Make room for your work." }, { timeoutMs: 90_000 });
    await user.see({ text: "How will you use OpenWork?" });
    await user.notSee({ role: "textbox", label: "Organization name" });
    expect(await orgs()).toEqual([]);
    await user.click({ text: "Join a team" });
    await user.type({ role: "textbox", label: /^Team invitation link/ }, "https://example.test/join-org?invite=not-valid");
    await user.click({ role: "button", label: "Review invitation" });
    await user.see({ text: /Paste the invitation link for this OpenWork Cloud/ });
    expect(await orgs()).toEqual([]);
    await user.type({ role: "textbox", label: /^Team invitation link/ }, new URL("/join-org?invite=missing-invitation", world.den.ref.webUrl).toString(), { replace: true });
    await user.click({ role: "button", label: "Review invitation" });
    await probe.eventually(() => world.pathname(), { within: 30_000, label: "existing invite review route", until: (path) => path === "/join-org" });
    expect(await orgs()).toEqual([]);
    evidence.recordAssertionEvidence("Join uses invitation review and neither an invalid link nor review creates an organization", "Foreign origin rejected; same-origin invitation opened /join-org; organization list remained empty", true);
  });

  let personalId = "";
  let personalPolicy: Record<string, unknown> = {};
  await step("personal work creates one organization and continues to tools", async () => {
    await user.navigate(new URL("/organization", world.den.ref.webUrl).toString());
    await user.see({ text: "Make room for your work." }, { timeoutMs: 90_000 });
    await user.click({ text: "On my own" });
    await user.notSee({ text: "How should your team’s desktop app work?" });
    await user.type({ role: "textbox", label: "Organization name" }, "Personal work");
    await user.click({ role: "button", label: "Continue" });
    await user.see({ testId: "marketplace-onboarding" }, { timeoutMs: 90_000 });
    const memberships = await orgs();
    expect(memberships).toHaveLength(1);
    const personal = memberships.find((entry) => entry.name === "Personal work");
    if (typeof personal?.id !== "string") throw new Error("Personal organization missing");
    personalId = personal.id;
    personalPolicy = await policyFor(personalId);
    expect(personalPolicy.allowMultipleWorkspaces).toBe(true);
    expect(personalPolicy.allowManageExtensions).toBe(true);
    evidence.recordAssertionEvidence("Personal setup creates one organization and preserves desktop workspace and tool defaults", JSON.stringify({ memberships: memberships.length, personalPolicy }), true);
  });

  await step("team signup prepares Restricted for explicit review, then persists it", async () => {
    await user.navigate(new URL("/organization", world.den.ref.webUrl).toString());
    await user.click({ role: "button", label: "+ Create New Organization" });
    await user.click({ text: "Create a team" });
    await user.type({ role: "textbox", label: "Team name" }, "Focused team");
    await user.see({ text: "How should your team’s desktop app work?" });
    await user.click({ text: "Flexible" });
    await user.see({ role: "button", label: "Continue" });
    await user.click({ text: "Set up Restricted" });
    await user.looks(["Team setup uses neutral cards with a selected Restricted option and clearly explains the Enterprise requirement and saving step"]);
    await user.click({ role: "button", label: "Create team & review policy" });
    await user.see({ text: "Review your team’s desktop access" }, { timeoutMs: 90_000 });
    await user.see({ text: /unsaved draft/ });
    await user.see({ text: /Locked by Restricted mode/ });
    const memberships = await orgs();
    expect(memberships).toHaveLength(2);
    const team = memberships.find((entry) => entry.name === "Focused team");
    if (typeof team?.id !== "string") throw new Error("Created team missing");
    const before = await policyFor(team.id);
    expect(before.allowMultipleWorkspaces).toBe(true);
    expect(before.allowManageExtensions).toBe(true);
    await user.reload();
    await user.see({ text: "Review your team’s desktop access" }, { timeoutMs: 90_000 });
    await user.click({ role: "button", label: "Save changes" });
    await user.see({ testId: "marketplace-onboarding" }, { timeoutMs: 90_000 });
    const after = await policyFor(team.id);
    for (const key of ["allowCustomProviders", "allowZenModel", "allowMultipleWorkspaces", "allowControlSettings", "allowManageExtensions", "allowBuiltInExtensions", "allowAlphaUpdates"]) expect(after[key]).toBe(false);
    expect(after.showWelcomePage).toBe(true);
    expect(await policyFor(personalId)).toEqual(personalPolicy);
    expect(await orgs()).toHaveLength(2);
    evidence.recordAssertionEvidence("Restricted stays a draft through reload until explicit save, persists the real desktop booleans, and leaves the personal organization unchanged", JSON.stringify({ before, after, personalPolicy, orgCount: 2 }), true);
  });
});
