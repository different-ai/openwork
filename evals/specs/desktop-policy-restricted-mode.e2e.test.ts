import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { defaultPolicyEditorAndMemberDesktop, readDefaultDesktopPolicy } from "../worlds/desktop-policies.ts";

// An organization that wants a vanilla OpenWork picks one decision, Restricted,
// in the Den policy editor. This spec drives the real editor as the admin and a
// real member desktop side by side: the editor locks every governed capability
// and stores plain booleans, and the member's settings and Library surfaces
// collapse to what the policy leaves reachable.
const test = spec.world(defaultPolicyEditorAndMemberDesktop, { timeout: 900_000 });

// The capability cards as the editor labels them. Restricted locks the first
// seven; the Welcome Page display preference stays editable in both modes.
const lockedCards = [
  "Custom providers",
  "Enable OpenCode Zen Models",
  "Multiple workspaces",
  "Control Settings",
  "Manage Extensions",
  "Built-in Extensions",
  "Alpha updates",
];
const editableCards = ["Welcome Page"];
const lockNote = "Locked by Restricted mode.";
// What Den must hold after saving a Restricted policy: plain booleans, not a
// mode flag, so older desktops keep reading the same keys.
const restrictedSavedValues: Record<string, boolean> = {
  allowCustomProviders: false,
  allowZenModel: false,
  allowMultipleWorkspaces: false,
  allowControlSettings: false,
  allowManageExtensions: false,
  allowBuiltInExtensions: false,
  allowAlphaUpdates: false,
  showWelcomePage: true,
};
const lockedKeys = Object.keys(restrictedSavedValues).filter((key) => key !== "showWelcomePage");

const settingsHub = { role: "button", label: "Settings" } as const;
const accountMenu = { testId: "account-status-menu" };
const settingsMenuItem = { role: "menuitem", label: "Settings" } as const;
const accountMenuItem = { role: "menuitem", label: "Account" } as const;
const policyBanner = { testId: "desktop-policy-banner" };
const manageExtensionsNotice = { testId: "manage-extensions-policy-notice" };
const builtInExtensionsNotice = "Built-in OpenWork extensions are disabled by your organization";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

test("an admin controls default and team access while members can understand their permissions", async ({ world, user, agent, probe, step, evidence, seed }) => {
  const member = { user: user.on(world.member), agent: agent.on(world.member), probe: probe.on(world.member) };
  const admin = { user: user.on(world.admin), probe: probe.on(world.admin) };
  const lockNotes = () => admin.probe.text().then((text) => count(text, lockNote));
  const savedPolicy = async () => {
    const policy = await readDefaultDesktopPolicy(probe, world.den.admin);
    return isRecord(policy.policy) ? policy.policy : {};
  };

  // Phase 1 — the member's desktop before any restriction: the Library carries
  // no extension-management notice, and the settings hub and every settings
  // group are reachable. Settings comes last so the desktop is still on that
  // route when it reloads in phase 3. (The generic "Organization policies active"
  // banner is not a discriminator here: it already reacts to unrelated
  // organization flags such as Dashboards or Automations being off.)
  const libraryHashBefore = await step("the member opens the Library before the policy changes", async () => {
    await member.user.click("Library");
    await member.user.see({ text: "Library" }, { timeoutMs: 90_000 });
    await member.user.notSee(manageExtensionsNotice);
    return member.probe.hash();
  });
  expect(libraryHashBefore).toContain("/extensions");
  await member.user.looks([
    "The Library page is open and shows no notice that extension management was disabled by an organization administrator",
  ]);
  evidence.recordAssertionEvidence(
    "Before the policy change the Library carries no extension-management restriction",
    `hash=${libraryHashBefore}; manage-extensions notice absent`,
    libraryHashBefore.includes("/extensions"),
  );

  const hashBefore = await step("the member opens settings from the account menu before the policy changes", async () => {
    await member.user.click(accountMenu);
    await member.user.see(settingsMenuItem);
    await member.user.click(settingsMenuItem);
    await member.user.see(settingsHub, { timeoutMs: 60_000 });
    for (const group of ["Workspace", "Global", "Cloud"]) await member.user.see({ text: group });
    return member.probe.hash();
  });
  expect(hashBefore).toContain("/settings/general");
  await member.user.looks([
    "A settings page with a left navigation that lists Workspace, Global, and Cloud groups",
    "The main area shows settings cards such as Preferences, Permissions, or AI Providers",
  ]);
  evidence.recordAssertionEvidence(
    "Before the policy change the member reaches the full settings surface",
    `hash=${hashBefore}; Settings hub visible; Workspace, Global, and Cloud groups visible`,
    hashBefore.includes("/settings/general"),
  );

  // Phase 2 — the admin switches the default policy to Restricted in Den Web.
  await step("the default policy editor opens in Custom mode", async () => {
    await admin.user.see({ text: "Policy mode" }, { timeoutMs: 90_000 });
    for (const card of [...lockedCards, ...editableCards]) {
      await admin.user.see({ role: "checkbox", label: new RegExp(`^${card}`) });
    }
    await admin.user.notSee({ text: lockNote });
  });
  const customLockNotes = await lockNotes();
  expect(customLockNotes).toBe(0);
  await admin.user.looks([
    "A Policy mode selector with Custom and Restricted options appears above the capability list",
    "Custom is selected and the capability checkboxes are enabled",
  ]);
  evidence.recordAssertionEvidence(
    "The existing editor flow is unchanged: the default policy opens in Custom mode with every capability editable",
    `cards=${lockedCards.length + editableCards.length}; lockNotes=${customLockNotes}`,
    customLockNotes === 0,
  );

  const restrictedLockNotes = await step("the admin selects Restricted", async () => {
    await admin.user.click({ text: "Restricted" });
    await admin.user.see({ text: lockNote }, { timeoutMs: 30_000 });
    return lockNotes();
  });
  // One lock note per governed card and none under the Welcome Page card.
  expect(restrictedLockNotes).toBe(lockedCards.length);
  await admin.user.looks([
    "Restricted is the selected policy mode",
    "The seven cards from Custom providers through Alpha updates each show an unchecked checkbox and a Locked by Restricted mode note",
    "The Welcome Page card shows a checked checkbox and no Locked by Restricted mode note",
  ]);
  evidence.recordAssertionEvidence(
    "Restricted locks every governed capability in the editor and leaves the welcome page editable",
    `lockNotes=${restrictedLockNotes} of ${lockedCards.length} governed cards; editable=${JSON.stringify(editableCards)}`,
    restrictedLockNotes === lockedCards.length,
  );

  const savedRestricted = await step("the admin saves the policy", async () => {
    await admin.user.click("Save changes");
    await admin.user.see({ testId: "desktop-policy-restricted-badge" }, { timeoutMs: 60_000 });
    await admin.user.see({ text: /^default$/i });
    return savedPolicy();
  });
  await admin.user.looks([
    "A desktop policies list shows the default policy with both a Default badge and a Restricted badge next to its name",
  ]);
  for (const [key, value] of Object.entries(restrictedSavedValues)) {
    expect(savedRestricted[key]).toBe(value);
  }

  const { reopenedLockNotes, unlockedLockNotes, savedAfterCustom } = await step("the admin reopens the policy and returns it to Custom", async () => {
    await admin.user.navigate(new URL(world.editorPath, world.den.ref.webUrl).toString());
    await admin.user.see({ text: "Policy mode" }, { timeoutMs: 90_000 });
    await admin.user.see({ text: lockNote }, { timeoutMs: 30_000 });
    const reopenedLockNotes = await lockNotes();
    await admin.user.click({ text: "Custom" });
    await admin.user.notSee({ text: lockNote }, { timeoutMs: 15_000 });
    const unlockedLockNotes = await lockNotes();
    // Saving again from Custom without touching a checkbox must keep the same
    // booleans: Custom unlocks the controls, it does not rewrite the values.
    await admin.user.click("Save changes");
    await admin.user.see({ testId: "desktop-policy-restricted-badge" }, { timeoutMs: 60_000 });
    return { reopenedLockNotes, unlockedLockNotes, savedAfterCustom: await savedPolicy() };
  });
  expect(reopenedLockNotes).toBe(lockedCards.length);
  expect(unlockedLockNotes).toBe(0);
  for (const [key, value] of Object.entries(restrictedSavedValues)) {
    expect(savedAfterCustom[key]).toBe(value);
  }
  evidence.recordAssertionEvidence(
    "Saving stores plain booleans, the editor reopens in Restricted, and Custom unlocks the checkboxes without changing values",
    `saved=${JSON.stringify(lockedKeys.map((key) => [key, savedRestricted[key]]))}; reopenedLockNotes=${reopenedLockNotes}; unlockedLockNotes=${unlockedLockNotes}; savedAfterCustom unchanged=${lockedKeys.every((key) => savedAfterCustom[key] === savedRestricted[key])}`,
    reopenedLockNotes === lockedCards.length && unlockedLockNotes === 0 && lockedKeys.every((key) => savedAfterCustom[key] === false),
  );

  // Phase 3 — the member's desktop re-reads the effective policy. A reload
  // drives the same organization-config refresh as the Den settings-changed
  // event, an account refresh, or an organization switch; the hourly refresh
  // is the level-based safety net.
  const hashAfter = await step("the member's desktop refreshes on the settings route", async () => {
    await member.user.reload();
    await member.user.see(policyBanner, { timeoutMs: 90_000 });
    return member.probe.eventually(() => member.probe.hash(), {
      within: 90_000,
      label: "restricted settings navigation redirected to the Cloud account tab",
      until: (hash) => hash.includes("/settings/cloud-account"),
    });
  });
  expect(hashAfter).toContain("/settings/cloud-account");
  await member.user.see({ text: "Cloud" });
  await member.user.notSee({ text: "Workspace" });
  await member.user.notSee({ text: "Global" });
  await member.user.notSee(settingsHub);
  await member.user.looks([
    "The settings navigation shows only a Cloud group and no Workspace or Global group",
    "An Organization policies active notice is visible on the account page",
  ]);
  evidence.recordAssertionEvidence(
    "Under the Restricted default policy the settings surface collapses to the Cloud account page",
    `hash=${hashAfter}; Cloud group visible; Workspace and Global groups absent; Settings hub absent; policy banner visible`,
    hashAfter.includes("/settings/cloud-account"),
  );

  const redirectedHash = await step("a hidden settings tab redirects", async () => {
    await member.agent.run("route.settings.appearance");
    return member.probe.eventually(() => member.probe.hash(), {
      within: 60_000,
      label: "appearance route redirected",
      until: (hash) => hash.includes("/settings/cloud-account"),
    });
  });
  expect(redirectedHash).toContain("/settings/cloud-account");
  evidence.recordAssertionEvidence(
    "A route to a hidden settings tab lands on the Cloud account page instead",
    `requested=/settings/appearance; landed=${redirectedHash}`,
    redirectedHash.includes("/settings/cloud-account"),
  );

  await step("the account menu offers only the Account page", async () => {
    await member.user.click({ role: "button", label: "Back to app" });
    await member.user.click(accountMenu);
    await member.user.see(accountMenuItem);
    await member.user.notSee(settingsMenuItem);
    await member.user.press("Escape");
    await member.user.notSee(accountMenuItem, { timeoutMs: 10_000 });
  });
  evidence.recordAssertionEvidence(
    "Under the Restricted policy the account menu leads to the Account page instead of desktop settings",
    "account menu shows an Account item and no Settings item",
    true,
  );

  const { libraryHashAfter, builtInNoticeShown } = await step("the member opens the Library under the Restricted policy", async () => {
    await member.user.click("Library");
    await member.user.see(manageExtensionsNotice, { timeoutMs: 90_000, text: /disabled local extension management/ });
    // Restricted also turns off allowBuiltInExtensions, so the Library's
    // existing built-in banner appears alongside the new notice.
    const builtInNoticeShown = await member.probe.eventually(() => member.probe.has(builtInExtensionsNotice), {
      within: 30_000,
      label: "built-in extensions notice",
      until: (shown) => shown,
    });
    return { libraryHashAfter: await member.probe.hash(), builtInNoticeShown };
  });
  expect(libraryHashAfter).toContain("/extensions");
  expect(builtInNoticeShown).toBe(true);
  await member.user.looks([
    "The Library is open and shows a notice that the organization administrator disabled local extension management",
    "A notice says built-in OpenWork extensions are disabled by your organization",
  ]);
  evidence.recordAssertionEvidence(
    "The Library stays reachable but local extension and MCP add flows are disabled with the catalog notice",
    `hash=${libraryHashAfter}; manage-extensions notice visible; builtInNotice=${builtInNoticeShown}`,
    libraryHashAfter.includes("/extensions") && builtInNoticeShown,
  );

  // Team limits must win even when the organization grants every capability.
  await step("prepare an unrestricted organization with a focused-work team", async () => {
    const reset = await seed.api(world.den.admin, `/v1/desktop-policies/${world.policyId}`, {
      method: "PATCH",
      body: JSON.stringify({ policyName: "Default desktop policy", policy: Object.fromEntries(Object.keys(restrictedSavedValues).map((key) => [key, true])) }),
    });
    expect(reset.response.ok).toBe(true);
  });
  const org = await probe.api(world.den.members.jordan, "/v1/org");
  const currentMember = isRecord(org.body) && isRecord(org.body.currentMember) ? org.body.currentMember : null;
  expect(typeof currentMember?.id).toBe("string");
  const createdTeam = await seed.api(world.den.admin, "/v1/teams", {
    method: "POST",
    body: JSON.stringify({ name: "Focused work", memberIds: [currentMember?.id] }),
  });
  expect(createdTeam.response.ok).toBe(true);
  const team = isRecord(createdTeam.body) && isRecord(createdTeam.body.team) ? createdTeam.body.team : null;
  if (typeof team?.id !== "string") throw new Error("Expected a created team");
  const otherTeamResult = await seed.api(world.den.admin, "/v1/teams", {
    method: "POST", body: JSON.stringify({ name: "Additional tools", memberIds: [currentMember?.id] }),
  });
  const otherTeam = isRecord(otherTeamResult.body) && isRecord(otherTeamResult.body.team) ? otherTeamResult.body.team : null;
  if (typeof otherTeam?.id !== "string") throw new Error("Expected overlapping team");
  const overlappingGrant = await seed.api(world.den.admin, "/v1/desktop-policies", {
    method: "POST", body: JSON.stringify({ policyName: "Additional team grants", policy: Object.fromEntries(lockedKeys.map((key) => [key, true])), teamIds: [otherTeam.id] }),
  });
  expect(overlappingGrant.response.ok).toBe(true);
  const teamPath = new URL(`/dashboard/members/teams/${team.id}`, world.den.ref.webUrl).toString();
  const effective = async (identity: typeof world.den.admin) => {
    const result = await probe.api(identity, "/v1/me/desktop-config");
    expect(result.response.ok).toBe(true);
    if (!isRecord(result.body)) throw new Error("Expected effective permissions");
    return result.body;
  };
  await step("the admin locks the team from its Access page", async () => {
    await admin.user.navigate(teamPath);
    await admin.user.see({ text: "What this team can do" }, { timeoutMs: 90_000 });
    await admin.user.click({ role: "radio", label: /^Locked/ });
    await admin.user.click("Save permissions");
    await admin.probe.eventually(async () => (await effective(world.den.members.jordan)).allowManageExtensions, {
      within: 30_000, label: "team lock overrides the default grant", until: (value) => value === false,
    });
    await admin.user.reload();
    await admin.user.see({ text: "Locked for this team" }, { timeoutMs: 60_000 });
  });
  const lockedMember = await effective(world.den.members.jordan);
  const unlockedAdmin = await effective(world.den.admin);
  for (const key of lockedKeys) {
    expect(lockedMember[key]).toBe(false);
    expect(unlockedAdmin[key]).toBe(true);
  }
  await admin.user.looks([
    "The Focused work team Access page shows Locked selected, a list of blocked app capabilities, and Plugins & connections below",
  ]);
  evidence.recordAssertionEvidence("Team lock overrides organization and overlapping team grants without restricting someone outside the team", JSON.stringify({ lockedMember, unlockedAdmin }), lockedKeys.every((key) => lockedMember[key] === false && unlockedAdmin[key] === true));

  await step("the member can understand the restriction and how to get an MCP server", async () => {
    await member.user.reload();
    await member.user.see(manageExtensionsNotice, { timeoutMs: 90_000 });
    await member.user.see({ text: /Need an MCP server or skill/ });
    await member.user.click(accountMenu);
    await member.user.click(accountMenuItem);
    await member.user.see({ text: "What can I do?" }, { timeoutMs: 60_000 });
    await member.user.click({ text: "What can I do?" });
    await member.user.see({ text: "Add tools, skills & MCP servers" });
  });
  await member.user.looks(["The account page shows expanded app permissions with capabilities marked Blocked by organization"]);
  evidence.recordAssertionEvidence("Members can inspect app permissions and find instructions for requesting an MCP server", "Library MCP guidance and expanded account permission list visible", true);

  await step("the admin grants selected capabilities while keeping tool installation blocked", async () => {
    await admin.user.click({ role: "radio", label: /^Custom/ });
    await admin.user.click({ role: "checkbox", label: "Add and manage local tools, skills & MCP servers" });
    await admin.user.click("Save permissions");
    await admin.probe.eventually(async () => (await effective(world.den.members.jordan)).allowControlSettings, {
      within: 30_000, label: "custom mode restores selected capabilities", until: (value) => value === true,
    });
    await admin.user.reload();
    await admin.user.see({ text: "Fine-tune access" }, { timeoutMs: 60_000 });
  });
  const customMember = await effective(world.den.members.jordan);
  expect(customMember.allowManageExtensions).toBe(false);
  expect(customMember.allowControlSettings).toBe(true);
  expect(customMember.allowCustomProviders).toBe(true);
  await admin.user.looks(["The team Access page shows Custom selected, tool installation Blocked, and other capabilities Allowed"]);
  evidence.recordAssertionEvidence("Custom permissions persist independently: settings and providers allowed, tool installation blocked", JSON.stringify(customMember), customMember.allowManageExtensions === false && customMember.allowControlSettings === true && customMember.allowCustomProviders === true);

  const forbidden = await seed.api(world.den.members.jordan, "/v1/desktop-policies", {
    method: "POST", body: JSON.stringify({ policyName: "Unauthorized access change", policy: { access: { mode: "custom", capabilities: {} } }, teamIds: [team.id] }),
  });
  expect(forbidden.response.status).toBe(403);
  expect((await effective(world.den.members.jordan)).allowManageExtensions).toBe(false);
  evidence.recordAssertionEvidence("A member cannot change their own team permissions", `HTTP ${forbidden.response.status}; tool installation remains blocked`, forbidden.response.status === 403);

  const policyList = await probe.api(world.den.admin, "/v1/desktop-policies");
  const teamPolicy = isRecord(policyList.body) && Array.isArray(policyList.body.desktopPolicies)
    ? policyList.body.desktopPolicies.find((entry: unknown) => isRecord(entry) && isRecord(entry.policy) && isRecord(entry.policy.access))
    : undefined;
  if (!isRecord(teamPolicy) || typeof teamPolicy.id !== "string") throw new Error("Expected team policy");
  await admin.user.navigate(new URL(`/dashboard/desktop-policies/${teamPolicy.id}`, world.den.ref.webUrl).toString());
  await admin.user.see({ text: "Managed in Team access" }, { timeoutMs: 60_000 });
  await admin.user.notSee({ role: "button", label: "Save changes" });
  await admin.user.click("Open team access");
  await admin.user.see({ text: "What this team can do" }, { timeoutMs: 60_000 });
  evidence.recordAssertionEvidence("Advanced policy settings direct team permission changes back to Team Access", "Team access link reaches the team; legacy Save changes absent", true);

});
