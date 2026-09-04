import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { defaultPolicyEditorAndMemberDesktop, readDefaultDesktopPolicy, teamAccess } from "../worlds/desktop-policies.ts";

// An organization that wants a vanilla OpenWork picks one decision, Restricted,
// in the Den policy editor. This spec drives the real editor as the admin and a
// real member desktop side by side: the editor locks every governed capability
// and stores plain booleans, and the member's settings and Library surfaces
// collapse to what the policy leaves reachable.
const defaultJourney = "an admin restricts the default policy and the member desktop enforces it";
const teamJourney = "team access overrides overlapping grants and restores only selected desktop capabilities";
// Register one fixture extension: Vitest 3 accumulates fixtures when the same
// base is extended twice. Choose the setup at the test boundary, keeping the
// worlds framework-free and each sequential journey isolated.
const test = spec.world(async (seed) => {
  const name = expect.getState().currentTestName;
  if (name?.endsWith(defaultJourney)) {
    return { defaultPolicy: await defaultPolicyEditorAndMemberDesktop(seed), team: null };
  }
  if (name?.endsWith(teamJourney)) {
    return { defaultPolicy: null, team: await teamAccess(seed) };
  }
  throw new Error(`No desktop policy world selected for ${name}`);
}, { timeout: 900_000 });

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

test(defaultJourney, async ({ world: selectedWorld, user, agent, probe, step, evidence }) => {
  const world = selectedWorld.defaultPolicy;
  if (!world) throw new Error("Expected the default-policy world");
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

});

test(teamJourney, async ({ world: selectedWorld, user, agent, probe, step, evidence, seed }) => {
  const world = selectedWorld.team;
  if (!world) throw new Error("Expected the Team Access world");
  const member = { user: user.on(world.member), agent: agent.on(world.member), probe: probe.on(world.member) };
  const admin = { user: user.on(world.admin), probe: probe.on(world.admin) };
  const effective = async (identity: typeof world.den.admin) => {
    const result = await probe.api(identity, "/v1/me/desktop-config");
    expect(result.response.ok).toBe(true);
    if (!isRecord(result.body)) throw new Error("Expected effective permissions");
    return result.body;
  };
  const policies = async () => {
    const result = await probe.api(world.den.admin, "/v1/desktop-policies");
    expect(result.response.ok).toBe(true);
    if (!isRecord(result.body) || !Array.isArray(result.body.desktopPolicies)) throw new Error("Expected policies");
    return result.body.desktopPolicies.filter(isRecord);
  };
  const teamPolicy = async () => {
    const policy = (await policies()).find((entry) => Array.isArray(entry.assignments)
      && entry.assignments.some((assignment: unknown) => isRecord(assignment) && assignment.teamId === world.teamId)
      && isRecord(entry.policy) && isRecord(entry.policy.access));
    if (!policy || typeof policy.id !== "string") throw new Error("Expected team access policy");
    return policy;
  };
  const accessOf = (policy: Record<string, unknown>) => {
    if (!isRecord(policy.policy) || !isRecord(policy.policy.access) || !isRecord(policy.policy.access.capabilities)) throw new Error("Expected saved access capabilities");
    return { mode: policy.policy.access.mode, capabilities: policy.policy.access.capabilities };
  };
  const saveMode = async (mode: "Locked" | "Custom") => {
    await admin.user.click({ text: mode });
    await admin.user.click("Save permissions");
    await admin.probe.eventually(async () => accessOf(await teamPolicy()).mode, {
      within: 30_000, label: `${mode} saved`, until: (value) => value === mode.toLowerCase(),
    });
    await admin.user.reload();
    await admin.user.see({ text: mode === "Locked" ? "Locked for this team" : "Fine-tune access" }, { timeoutMs: 60_000 });
  };

  await step("both ordinary members start unrestricted and the target can open Settings", async () => {
    const roles = [];
    for (const identity of [world.den.members.jordan, world.den.members.casey]) {
      const org = await probe.api(identity, "/v1/org");
      expect(org.response.ok).toBe(true);
      if (!isRecord(org.body) || !isRecord(org.body.currentMember)) throw new Error("Expected member role");
      roles.push(org.body.currentMember.role);
      expect(org.body.currentMember.role).toBe("member");
      const config = await effective(identity);
      for (const key of lockedKeys) expect(config[key]).toBe(true);
    }
    await member.user.click(accountMenu);
    await member.user.click(settingsMenuItem);
    await member.user.see(settingsHub, { timeoutMs: 60_000 });
    const hash = await member.probe.hash();
    expect(hash).toContain("/settings/general");
    evidence.recordAssertionEvidence("The target and control have the same ordinary role and unrestricted baseline", JSON.stringify({ roles, hash }), roles.every((role) => role === "member") && hash.includes("/settings/general"));
  });

  await step("the admin locks the team through Team Access", async () => {
    await admin.user.see({ text: "What this team can do" }, { timeoutMs: 90_000 });
    await saveMode("Locked");
  });
  const lockedMember = await effective(world.den.members.jordan);
  const control = await effective(world.den.members.casey);
  for (const key of lockedKeys) {
    expect(lockedMember[key]).toBe(false);
    expect(control[key]).toBe(true);
  }
  evidence.recordAssertionEvidence("Team blocks override overlapping grants while an ordinary member outside the team stays unrestricted", JSON.stringify({ lockedMember, control }), lockedKeys.every((key) => lockedMember[key] === false && control[key] === true));
  await admin.user.looks(["The Focused work team Access page shows Locked selected and blocked app capabilities"]);

  await step("locked members retain their approved team skill without exposing it outside the team", async () => {
    const allowed = await probe.api(world.den.members.jordan, `/v1/plugins/${world.pluginId}/resolved`);
    const denied = await probe.api(world.den.members.casey, `/v1/plugins/${world.pluginId}/resolved`);
    expect(allowed.response.ok).toBe(true);
    const items = isRecord(allowed.body) && Array.isArray(allowed.body.items) ? allowed.body.items.filter(isRecord) : [];
    const skill = items.find((item) => isRecord(item.configObject) && item.configObject.objectType === "skill"
      && isRecord(item.configObject.latestVersion) && item.configObject.latestVersion.rawSourceText === world.rawSourceText);
    expect(skill).toBeDefined();
    expect([403, 404]).toContain(denied.response.status);
    expect(denied.text).not.toContain(world.rawSourceText);
    const listed = await probe.api(world.den.members.jordan, `/v1/plugins?q=${encodeURIComponent(world.pluginName)}`);
    const outside = await probe.api(world.den.members.casey, `/v1/plugins?q=${encodeURIComponent(world.pluginName)}`);
    expect(listed.response.ok).toBe(true);
    expect(outside.response.ok).toBe(true);
    const pluginIds = (body: unknown) => isRecord(body) && Array.isArray(body.items) ? body.items.filter(isRecord).map((item) => item.id) : [];
    expect(pluginIds(listed.body)).toContain(world.pluginId);
    expect(pluginIds(outside.body)).not.toContain(world.pluginId);
    evidence.recordAssertionEvidence("Lock preserves read access to an approved team skill while another ordinary member cannot discover or resolve it", JSON.stringify({ skill, deniedStatus: denied.response.status, memberPlugins: pluginIds(listed.body), outsidePlugins: pluginIds(outside.body) }), skill !== undefined && [403, 404].includes(denied.response.status) && pluginIds(listed.body).includes(world.pluginId) && !pluginIds(outside.body).includes(world.pluginId));
  });

  await step("the target desktop enforces the team lock and explains MCP access", async () => {
    await member.user.reload();
    const redirected = await member.probe.eventually(() => member.probe.hash(), {
      within: 90_000, label: "team lock redirects settings", until: (hash) => hash.includes("/settings/cloud-account"),
    });
    await member.user.notSee(settingsHub);
    await member.user.notSee({ text: "Workspace" });
    await member.user.notSee({ text: "Global" });
    await member.agent.run("route.settings.appearance");
    const forbiddenRoute = await member.probe.eventually(() => member.probe.hash(), {
      within: 60_000, label: "forbidden appearance route redirects", until: (hash) => hash.includes("/settings/cloud-account"),
    });
    await member.user.see({ text: "What can I do?" });
    await member.user.click({ text: "What can I do?" });
    await member.user.see({ text: "Add tools, skills & MCP servers" });
    const permissionsText = await member.probe.text();
    expect(permissionsText).toContain("Blocked by organization");
    await member.user.click({ role: "button", label: "Back to app" });
    await member.user.click(accountMenu);
    await member.user.see(accountMenuItem);
    await member.user.notSee(settingsMenuItem);
    const menuText = await member.probe.text();
    await member.user.press("Escape");
    await member.user.click("Library");
    await member.user.see(manageExtensionsNotice, { timeoutMs: 90_000 });
    await member.user.see({ text: /Need an MCP server or skill/ });
    const libraryText = await member.probe.text();
    evidence.recordAssertionEvidence("The locked desktop hides Settings, redirects forbidden routes, and explains how to get an MCP server", JSON.stringify({ redirected, forbiddenRoute, permissionsText, menuText, libraryText }), redirected.includes("/settings/cloud-account") && forbiddenRoute.includes("/settings/cloud-account") && permissionsText.includes("Blocked by organization") && libraryText.includes("Need an MCP server or skill"));
    await member.user.looks(["The Library shows organization restrictions and guidance for requesting an MCP server or skill"]);
  });

  await step("Custom allows Settings but keeps local tools blocked", async () => {
    await admin.user.click({ text: "Custom" });
    await admin.user.click({ role: "checkbox", label: "Add and manage local tools, skills & MCP servers" });
    await admin.user.click("Save permissions");
    await admin.probe.eventually(async () => accessOf(await teamPolicy()).mode, {
      within: 30_000, label: "custom permissions saved", until: (mode) => mode === "custom",
    });
    await admin.user.reload();
    await admin.user.see({ text: "Fine-tune access" }, { timeoutMs: 60_000 });
    const chosen = accessOf(await teamPolicy());
    expect(chosen.capabilities.allowManageExtensions).toBe(false);
    await saveMode("Locked");
    const locked = accessOf(await teamPolicy());
    expect(locked.capabilities).toEqual(chosen.capabilities);
    const lockedAgain = await effective(world.den.members.jordan);
    for (const key of lockedKeys) expect(lockedAgain[key]).toBe(false);
    await saveMode("Custom");
    const restored = accessOf(await teamPolicy());
    expect(restored).toEqual(chosen);
    const config = await effective(world.den.members.jordan);
    expect(config.allowManageExtensions).toBe(false);
    for (const key of lockedKeys.filter((key) => key !== "allowManageExtensions")) expect(config[key]).toBe(true);
    await member.user.reload();
    await member.user.see(manageExtensionsNotice, { timeoutMs: 90_000 });
    const libraryText = await member.probe.text();
    await member.user.click(accountMenu);
    await member.user.see(settingsMenuItem);
    await member.user.click(settingsMenuItem);
    await member.user.see(settingsHub, { timeoutMs: 60_000 });
    for (const group of ["Workspace", "Global", "Cloud"]) await member.user.see({ text: group });
    const hash = await member.probe.hash();
    expect(hash).toContain("/settings/general");
    evidence.recordAssertionEvidence("Custom survives Locked and reloads with tools still blocked while Settings returns on the real desktop", JSON.stringify({ chosen, locked, restored, config, hash, libraryText }), restored.capabilities.allowManageExtensions === false && config.allowControlSettings === true && config.allowManageExtensions === false && hash.includes("/settings/general"));
    await admin.user.looks(["Custom is selected with tool installation Blocked and other capabilities Allowed"]);
  });

  await step("an ordinary member cannot create or overwrite team permissions", async () => {
    const before = await policies();
    const stored = await teamPolicy();
    const effectiveBefore = await effective(world.den.members.jordan);
    const statuses = [];
    for (const method of ["POST", "PATCH"]) {
      const result = await seed.api(world.den.members.jordan, method === "POST" ? "/v1/desktop-policies" : `/v1/desktop-policies/${stored.id}`, {
        method, body: JSON.stringify({ policyName: "Unauthorized access change", policy: { access: { mode: "custom", capabilities: { allowManageExtensions: true } } }, teamIds: [world.teamId] }),
      });
      statuses.push(result.response.status);
      expect(result.response.status).toBe(403);
      expect(await policies()).toEqual(before);
      expect(await effective(world.den.members.jordan)).toEqual(effectiveBefore);
    }
    const after = await policies();
    const effectiveAfter = await effective(world.den.members.jordan);
    evidence.recordAssertionEvidence("Member POST and PATCH are rejected without changing stored or effective permissions", JSON.stringify({ statuses, before, after, effectiveBefore, effectiveAfter }), statuses.every((status) => status === 403) && JSON.stringify(before) === JSON.stringify(after) && JSON.stringify(effectiveBefore) === JSON.stringify(effectiveAfter));
  });

  const saved = await teamPolicy();
  await admin.user.navigate(new URL(`/dashboard/desktop-policies/${saved.id}`, world.den.ref.webUrl).toString());
  await admin.user.see({ text: "Managed in Team access" }, { timeoutMs: 60_000 });
  await admin.user.notSee({ role: "button", label: "Save changes" });
  const legacyText = await admin.probe.text();
  await admin.user.click("Open team access");
  await admin.user.see({ text: "What this team can do" }, { timeoutMs: 60_000 });
  const teamText = await admin.probe.text();
  evidence.recordAssertionEvidence("Advanced policy settings direct changes to Team Access", JSON.stringify({ legacyText, teamText }), legacyText.includes("Managed in Team access") && teamText.includes("What this team can do"));
});
