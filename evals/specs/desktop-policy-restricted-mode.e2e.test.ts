import { expect } from "vitest";
import { selectModel } from "@openwork/behaviors";
import { spec, type Agent, type User } from "@openwork/testkit";
import { defaultPolicyEditorAndMemberDesktop, managedPolicyRecovery, policyTransportRollback, readDefaultDesktopPolicy, teamAccess } from "../worlds/desktop-policies.ts";

// An organization that wants a vanilla OpenWork picks one decision, Restricted,
// in the Den policy editor. This spec drives the real editor as the admin and a
// real member desktop side by side: the editor locks every governed capability
// and stores plain booleans, and the member's settings and Library surfaces
// collapse to what the policy leaves reachable.
const defaultJourney = "an admin restricts the default policy and the member desktop enforces it";
const teamJourney = "team access overrides overlapping grants and restores only selected desktop capabilities";
const recoveryJourney = "managed policy evaluation bounds transient Den retries and never reuses stale access";
const rollbackJourney = "POLICY-ROLLBACK tools complete when policy HTTP fails and IPC is disconnected";
// Register one fixture extension: Vitest 3 accumulates fixtures when the same
// base is extended twice. Choose the setup at the test boundary, keeping the
// worlds framework-free and each sequential journey isolated.
const test = spec.world(async (seed) => {
  const name = expect.getState().currentTestName;
  if (name?.endsWith(rollbackJourney)) {
    const rollback = await policyTransportRollback(seed);
    return { app: rollback.app, rollback, defaultPolicy: null, team: null, recovery: null,
      [Symbol.asyncDispose]: () => rollback[Symbol.asyncDispose]() };
  }
  if (name?.endsWith(defaultJourney)) {
    return { defaultPolicy: await defaultPolicyEditorAndMemberDesktop(seed), team: null, recovery: null };
  }
  if (name?.endsWith(teamJourney)) {
    return { defaultPolicy: null, team: await teamAccess(seed), recovery: null };
  }
  if (name?.endsWith(recoveryJourney)) {
    return { defaultPolicy: null, team: null, recovery: await managedPolicyRecovery(seed) };
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
const removedPolicyBanner = { testId: "desktop-policy-banner" };
const permissionsTab: { role: "tab"; label: string } = { role: "tab", label: "App permissions" };
const accountTab: { role: "tab"; label: string } = { role: "tab", label: "Account" };
const signOut: { role: "button"; label: string } = { role: "button", label: "Sign out" };
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
  // route when it reloads in phase 3.
  const { libraryHashBefore, localMcpFormText } = await step("the member opens the Library before the policy changes", async () => {
    await member.user.click("Library");
    await member.user.see({ text: "Library" }, { timeoutMs: 90_000 });
    await member.user.notSee(manageExtensionsNotice);
    await member.user.click({ role: "button", label: /^MCPs$/ });
    await member.user.click({ role: "button", label: "Add workspace MCP" });
    await member.user.see({ text: "Add workspace MCP" });
    await member.user.see({ role: "textbox", label: "App name" });
    const localMcpFormText = await member.probe.text();
    await member.user.press("Escape");
    await member.user.notSee({ role: "textbox", label: "App name" });
    await member.user.click({ role: "button", label: /^All$/ });
    return { libraryHashBefore: await member.probe.hash(), localMcpFormText };
  });
  expect(libraryHashBefore).toContain("/extensions");
  await member.user.looks([
    "The Library page is open and shows no notice that extension management was disabled by an organization administrator",
  ]);
  evidence.recordAssertionEvidence(
    "Before the policy change the member can open the local workspace MCP add form",
    `hash=${libraryHashBefore}; manage-extensions notice absent; local form=${localMcpFormText}`,
    libraryHashBefore.includes("/extensions") && localMcpFormText.includes("Add workspace MCP") && localMcpFormText.includes("App name"),
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

  const { reopenedLockNotes, unlockedLockNotes, savedEnabled, savedAfterCustom } = await step("the admin reopens the policy and returns it to Custom", async () => {
    await admin.user.navigate(new URL(world.editorPath, world.den.ref.webUrl).toString());
    await admin.user.see({ text: "Policy mode" }, { timeoutMs: 90_000 });
    await admin.user.see({ text: lockNote }, { timeoutMs: 30_000 });
    const reopenedLockNotes = await lockNotes();
    await admin.user.click({ text: "Custom" });
    await admin.user.notSee({ text: lockNote }, { timeoutMs: 15_000 });
    const unlockedLockNotes = await lockNotes();
    for (const card of lockedCards) {
      await admin.user.see({ role: "checkbox", label: new RegExp(`^${card}`) }, { editable: true });
    }
    // Persist an actual edit, then restore it so the member still receives the
    // fully restricted policy in the next phase.
    for (const card of lockedCards) await admin.user.click({ role: "checkbox", label: new RegExp(`^${card}`) });
    await admin.user.click("Save changes");
    await admin.user.see({ text: /^default$/i }, { timeoutMs: 60_000 });
    const savedEnabled = await savedPolicy();
    for (const key of lockedKeys) expect(savedEnabled[key]).toBe(true);
    await admin.user.navigate(new URL(world.editorPath, world.den.ref.webUrl).toString());
    await admin.user.see({ role: "checkbox", label: /^Control Settings/ }, { editable: true, timeoutMs: 60_000 });
    for (const card of lockedCards) await admin.user.click({ role: "checkbox", label: new RegExp(`^${card}`) });
    await admin.user.click("Save changes");
    await admin.user.see({ testId: "desktop-policy-restricted-badge" }, { timeoutMs: 60_000 });
    return { reopenedLockNotes, unlockedLockNotes, savedEnabled, savedAfterCustom: await savedPolicy() };
  });
  expect(reopenedLockNotes).toBe(lockedCards.length);
  expect(unlockedLockNotes).toBe(0);
  for (const [key, value] of Object.entries(restrictedSavedValues)) {
    expect(savedAfterCustom[key]).toBe(value);
  }
  evidence.recordAssertionEvidence(
    "Custom lets the admin enable and save every governed capability before restoring the Restricted values",
    `saved=${JSON.stringify(lockedKeys.map((key) => [key, savedRestricted[key]]))}; reopenedLockNotes=${reopenedLockNotes}; unlockedLockNotes=${unlockedLockNotes}; savedEnabled=${JSON.stringify(savedEnabled)}; savedAfterCustom unchanged=${lockedKeys.every((key) => savedAfterCustom[key] === savedRestricted[key])}`,
    reopenedLockNotes === lockedCards.length && unlockedLockNotes === 0 && lockedKeys.every((key) => savedEnabled[key] === true) && lockedKeys.every((key) => savedAfterCustom[key] === false),
  );

  // Phase 3 — the member's desktop re-reads the effective policy. A reload
  // drives the same organization-config refresh as the Den settings-changed
  // event, an account refresh, or an organization switch; the hourly refresh
  // is the level-based safety net.
  const hashAfter = await step("the member's desktop refreshes on the settings route", async () => {
    await member.user.reload();
    await member.user.see(permissionsTab, { timeoutMs: 90_000 });
    await member.user.notSee(removedPolicyBanner);
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
    "The account page has Account and App permissions tabs without a policy banner",
  ]);
  evidence.recordAssertionEvidence(
    "Under the Restricted default policy the settings surface collapses to the Cloud account page",
    `hash=${hashAfter}; Cloud group visible; Workspace and Global groups absent; Settings hub absent; App permissions tab visible; policy banner absent`,
    hashAfter.includes("/settings/cloud-account"),
  );

  const redirectedHash = await step("a forced hidden appearance route redirects to the visible Account page", async () => {
    await member.agent.run("route.settings.appearance");
    return member.probe.eventually(() => member.probe.hash(), {
      within: 60_000,
      label: "appearance route redirected",
      until: (hash) => hash.includes("/settings/cloud-account"),
    });
  });
  expect(redirectedHash).toContain("/settings/cloud-account");
  await member.user.see(accountTab);
  await member.user.see(signOut);
  await member.user.notSee(settingsHub);
  evidence.recordAssertionEvidence(
    "A route to a hidden settings tab lands on the Cloud account page instead",
    `forced route=/settings/appearance; landed=${redirectedHash}; Account tab and Sign out visible; Settings hub absent`,
    redirectedHash.includes("/settings/cloud-account"),
  );

  const restrictedMenuText = await step("the account menu offers only the Account page", async () => {
    await member.user.click({ role: "button", label: "Back to app" });
    await member.user.click(accountMenu);
    await member.user.see(accountMenuItem);
    await member.user.notSee(settingsMenuItem);
    const menuText = await member.probe.text();
    await member.user.press("Escape");
    await member.user.notSee(accountMenuItem, { timeoutMs: 10_000 });
    return menuText;
  });
  evidence.recordAssertionEvidence(
    "Under the Restricted policy the account menu leads to the Account page instead of desktop settings",
    restrictedMenuText,
    restrictedMenuText.includes("Account") && !restrictedMenuText.includes("Settings"),
  );

  const { libraryHashAfter, builtInNoticeShown, restrictedMcpText } = await step("the member opens the Library under the Restricted policy", async () => {
    await member.user.click("Library");
    await member.user.see(manageExtensionsNotice, { timeoutMs: 90_000, text: /disabled local extension management/ });
    // Restricted also turns off allowBuiltInExtensions, so the Library's
    // existing built-in banner appears alongside the new notice.
    await member.user.see({ text: builtInExtensionsNotice });
    const builtInNoticeShown = await member.probe.eventually(() => member.probe.has(builtInExtensionsNotice), {
      within: 30_000,
      label: "built-in extensions notice",
      until: (shown) => shown,
    });
    await member.user.click({ role: "button", label: /^MCPs$/ });
    await member.user.notSee({ role: "button", label: "Add workspace MCP" });
    const mcpFilterText = await member.probe.text();
    expect(mcpFilterText).not.toContain("Add workspace MCP");
    await member.user.click({ role: "button", label: /^All$/ });
    await member.user.click({ role: "button", label: /^Add$/ });
    await member.user.see({ testId: "library-add-choices" });
    await member.user.see({ text: "Connection" });
    await member.user.notSee({ text: "Local MCP" });
    const choicesText = await member.probe.text();
    expect(choicesText).not.toContain("Local MCP");
    const restrictedMcpText = `${mcpFilterText}\n${choicesText}`;
    expect(restrictedMcpText).not.toContain("Add workspace MCP");
    await member.user.press("Escape");
    await member.user.notSee({ testId: "library-add-choices" });
    return { libraryHashAfter: await member.probe.hash(), builtInNoticeShown, restrictedMcpText };
  });
  expect(libraryHashAfter).toContain("/extensions");
  expect(builtInNoticeShown).toBe(true);
  await member.user.looks([
    "The Library is open and shows a notice that the organization administrator disabled local extension management",
    "A notice says built-in OpenWork extensions are disabled by your organization",
  ]);
  evidence.recordAssertionEvidence(
    "The Library removes local MCP creation while retaining Connection as a separate picker choice",
    `hash=${libraryHashAfter}; manage-extensions notice visible; builtInNotice=${builtInNoticeShown}; MCP filter and All picker=${restrictedMcpText}`,
    libraryHashAfter.includes("/extensions") && builtInNoticeShown && restrictedMcpText.includes("Connection") && !restrictedMcpText.includes("Local MCP") && !restrictedMcpText.includes("Add workspace MCP"),
  );

});

test(rollbackJourney, { timeout: 300_000 }, async ({ world, user, agent, probe, step, evidence }) => {
  if (!("rollback" in world) || !world.rollback) throw new Error("Expected the rollback world");
  const rollback = world.rollback;
  await step("the isolated engine starts with a failing policy transport", async () => {
    expect(await rollback.faultReceipt()).toBe("HTTP fault configured; IPC fd closed");
    expect(await rollback.checkFault()).toMatchObject({ status: 503 });
    expect(rollback.policyRequests()).toHaveLength(1);
  });
  await user.type("composer", `Copy the supplied local file using the requested tools. ${rollback.marker}`);
  await agent.run("composer.send");
  const snapshot = await step("real read and command tools complete despite the fault", async () => {
    return probe.eventually(async () => {
      await rollback.approve();
      return rollback.native();
    }, {
      within: 120_000, label: "read and shell completed in native engine history",
      until: (snapshot) => snapshot.ok && snapshot.data.messages.flatMap((message) => message.parts)
        .filter((part) => ["read", "bash", "shell"].includes(part.tool) && part.status === "completed").length === 2,
    });
  });
  expect(snapshot.ok).toBe(true);
  expect(await rollback.output()).toBe(rollback.content);
  expect(rollback.policyRequests()).toHaveLength(1);
  await user.see({ text: "The requested file was copied successfully." }, { timeoutMs: 30_000 });
  evidence.recordAssertionEvidence(
    `${rollback.engine} executes read and shell with policy HTTP 503 and disconnected IPC`,
    JSON.stringify({ engine: rollback.engine, snapshot, output: await rollback.output(), policyRequests: rollback.policyRequests() }),
    true,
  );
});

test(recoveryJourney, { timeout: 300_000 }, async ({ world: selectedWorld, step, evidence }) => {
  const world = selectedWorld.recovery;
  if (!world) throw new Error("Expected the managed-policy recovery world");
  const policyPath = "/v1/me/desktop-config";
  const catalogPath = "/v1/llm-providers";
  const builtInModel = { action: "model", input: { providerID: "opencode", id: "policy-retry-proof" } };
  const assignedModel = { action: "model", input: { providerID: world.providerId, id: world.modelId } };
  const code = (body: unknown) => isRecord(body) && typeof body.code === "string" ? body.code : null;
  const runtimeProvider = (body: unknown) => {
    const providers = isRecord(body) && isRecord(body.provider) ? body.provider : null;
    const provider = providers?.[world.providerId];
    return isRecord(provider) ? provider : null;
  };
  const statusProvider = (body: unknown) => isRecord(body) && Array.isArray(body.providers)
    ? body.providers.filter(isRecord).find((provider) => provider.cloudProviderId === world.providerId) ?? null
    : null;
  const waitForRequests = async (start: number, path: string, expected: number) => {
    const deadline = Date.now() + 5_000;
    while (true) {
      const requests = (await world.proxy.requestLog()).slice(start).filter((request) => request.path === path);
      if (requests.length >= expected || Date.now() >= deadline) return requests;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };
  const faultedEvaluation = async (
    path: string,
    evaluation: Record<string, unknown>,
    statusCode: number,
    times: number,
    body?: unknown,
  ) => {
    await world.proxy.faults.clear();
    const start = (await world.proxy.requestLog()).length;
    await world.proxy.faults.status(path, statusCode, { times, body });
    const startedAt = performance.now();
    const result = await world.evaluate(evaluation);
    const elapsedMs = performance.now() - startedAt;
    const requests = await waitForRequests(start, path, statusCode === 503 ? 2 : 1);
    return { result, requests, elapsedMs };
  };
  const latencyEvaluation = async (path: string, evaluation: Record<string, unknown>, times: number) => {
    await world.proxy.faults.clear();
    const start = (await world.proxy.requestLog()).length;
    await world.proxy.faults.latency(path, 5_000, { times });
    const startedAt = performance.now();
    let evaluationComplete = false;
    const evaluationPromise = world.evaluate(evaluation).finally(() => { evaluationComplete = true; });
    await new Promise((resolve) => setTimeout(resolve, 250));
    const requestsBeforeCompletion = (await world.proxy.requestLog()).slice(start).filter((request) => request.path === path);
    const completedBeforeRequestProbe = evaluationComplete;
    const result = await evaluationPromise;
    const elapsedMs = Math.round(performance.now() - startedAt);
    const logAfterEvaluation = await world.proxy.requestLog();
    const afterEvaluation = logAfterEvaluation.length;
    const requests = logAfterEvaluation.slice(start, afterEvaluation).filter((request) => request.path === path);
    const freshBeforeCompletion = requestsBeforeCompletion.filter((request) => request.faulted === false).length;
    const freshWithinEvaluation = requests.filter((request) => request.faulted === false).length;
    // Aborted requests are not completed-response log entries. Give every
    // five-second latency handler a bounded drain window, then prove that a
    // fault-free evaluation is healthy before starting the next case.
    await new Promise((resolve) => setTimeout(resolve, 5_250));
    await world.proxy.faults.clear();
    const healthy = await world.evaluate(evaluation);
    return { result, healthy, elapsedMs, start, afterEvaluation, requests, completedBeforeRequestProbe, freshBeforeCompletion, freshWithinEvaluation };
  };

  await step("the assigned model is materialized and allowed while custom providers are disabled", async () => {
    const synced = await world.syncProviders();
    const provider = runtimeProvider(synced.runtime.body);
    const models = provider && isRecord(provider.models) ? provider.models : null;
    const status = statusProvider(synced.status.body);
    const statusModels = status && Array.isArray(status.modelIds) ? status.modelIds : [];
    const catalog = await world.memberCatalog();
    const catalogIds = catalog.providers.flatMap((item) => typeof item.id === "string" ? [item.id] : []);
    const allowed = await world.evaluate(assignedModel);
    expect(world.providerId).toMatch(/^lpr_/);
    expect(synced.run.status).toBe(200);
    expect(synced.runtime.status).toBe(200);
    expect(synced.status.status).toBe(200);
    expect(models).not.toBeNull();
    expect(models && Object.hasOwn(models, world.modelId)).toBe(true);
    expect(statusModels).toContain(world.modelId);
    expect(catalog.status).toBe(200);
    expect(catalogIds).toContain(world.providerId);
    expect(allowed.status).toBe(200);
    evidence.recordAssertionEvidence(
      "A directly assigned lpr_ model is materialized and passes live catalog authorization when custom providers are disabled",
      JSON.stringify({ providerId: world.providerId, modelId: world.modelId, syncHttp: synced.run.status, runtimeHttp: synced.runtime.status, syncStatusHttp: synced.status.status, statusModels, catalogIds, evaluation: allowed }),
      /^lpr_/.test(world.providerId) && Boolean(models && Object.hasOwn(models, world.modelId))
        && statusModels.includes(world.modelId) && catalogIds.includes(world.providerId) && allowed.status === 200,
    );
  });

  await step("one transient policy response backs off before retrying once and applies the live allow", async () => {
    const recovered = await faultedEvaluation(policyPath, builtInModel, 503, 1);
    expect(recovered.result.status).toBe(200);
    expect(recovered.requests).toMatchObject([
      { status: 503, faulted: true },
      { status: 200, faulted: false },
    ]);
    expect(recovered.requests).toHaveLength(2);
    expect(recovered.elapsedMs).toBeGreaterThanOrEqual(190);
    evidence.recordAssertionEvidence(
      "A transient Den policy failure backs off before retrying exactly once and the real OpenWork server applies the live allow",
      JSON.stringify(recovered),
      recovered.result.status === 200 && recovered.requests.length === 2 && recovered.elapsedMs >= 190
        && recovered.requests[0]?.status === 503 && recovered.requests[1]?.status === 200,
    );
  });

  await step("persistent and non-retryable policy verification failures stay closed", async () => {
    const outage = await faultedEvaluation(policyPath, builtInModel, 503, 2);
    expect(outage.result.status).toBe(403);
    expect(code(outage.result.body)).toBe("policy_unavailable");
    expect(outage.requests).toHaveLength(2);
    expect(outage.requests.map((request) => request.status)).toEqual([503, 503]);

    const nonRetryable = [];
    for (const fault of [
      { name: "unauthenticated", status: 401 },
      { name: "forbidden", status: 403 },
      { name: "rate limited", status: 429 },
      { name: "invalid schema", status: 200, body: { allowZenModel: "invalid" } },
    ]) {
      const observed = await faultedEvaluation(policyPath, builtInModel, fault.status, 2, fault.body);
      expect(observed.result.status, fault.name).toBe(403);
      expect(code(observed.result.body), fault.name).toBe("policy_unavailable");
      expect(observed.requests, fault.name).toHaveLength(1);
      nonRetryable.push({ fault: fault.name, ...observed });
    }
    evidence.recordAssertionEvidence(
      "Persistent outage, authentication, authorization, rate limit, and invalid policy responses fail closed without stale access",
      JSON.stringify({ outage, nonRetryable }),
      outage.result.status === 403 && code(outage.result.body) === "policy_unavailable" && outage.requests.length === 2
        && nonRetryable.every((item) => item.result.status === 403 && code(item.result.body) === "policy_unavailable" && item.requests.length === 1),
    );
  });

  await step("assigned-model catalog verification has the same bounded retry and fail-closed behavior", async () => {
    const recovered = await faultedEvaluation(catalogPath, assignedModel, 503, 1);
    expect(recovered.result.status).toBe(200);
    expect(recovered.requests).toMatchObject([
      { status: 503, faulted: true },
      { status: 200, faulted: false },
    ]);
    expect(recovered.requests).toHaveLength(2);

    const outage = await faultedEvaluation(catalogPath, assignedModel, 503, 2);
    expect(outage.result.status).toBe(403);
    expect(code(outage.result.body)).toBe("policy_unavailable");
    expect(outage.requests).toHaveLength(2);
    expect(outage.requests.map((request) => request.status)).toEqual([503, 503]);

    const nonRetryable = [];
    for (const fault of [
      { name: "unauthenticated", status: 401 },
      { name: "forbidden", status: 403 },
      { name: "rate limited", status: 429 },
      { name: "invalid schema", status: 200, body: { llmProviders: "invalid" } },
    ]) {
      const observed = await faultedEvaluation(catalogPath, assignedModel, fault.status, 2, fault.body);
      expect(observed.result.status, fault.name).toBe(403);
      expect(code(observed.result.body), fault.name).toBe("policy_unavailable");
      expect(observed.requests, fault.name).toHaveLength(1);
      nonRetryable.push({ fault: fault.name, ...observed });
    }
    evidence.recordAssertionEvidence(
      "Assigned-model catalog verification recovers from one 503, then fails closed after exactly two persistent attempts or one non-retryable response",
      JSON.stringify({ recovered, outage, nonRetryable }),
      recovered.result.status === 200 && recovered.requests.map((request) => request.status).join(",") === "503,200"
        && outage.result.status === 403 && code(outage.result.body) === "policy_unavailable" && outage.requests.length === 2
        && nonRetryable.every((item) => item.result.status === 403 && code(item.result.body) === "policy_unavailable" && item.requests.length === 1),
    );
  });

  await step("single policy and assigned-model catalog timeouts recover while repeated timeouts exhaust within the shared deadline", async () => {
    const policyRecovered = await latencyEvaluation(policyPath, builtInModel, 1);
    const policyExhausted = await latencyEvaluation(policyPath, builtInModel, 2);
    const catalogRecovered = await latencyEvaluation(catalogPath, assignedModel, 1);
    const catalogExhausted = await latencyEvaluation(catalogPath, assignedModel, 2);
    for (const { name, observed } of [
      { name: "policy recovery", observed: policyRecovered },
      { name: "catalog recovery", observed: catalogRecovered },
    ]) {
      expect(observed.result.status, name).toBe(200);
      expect(observed.healthy.status, `${name} healthy follow-up`).toBe(200);
      expect(observed.elapsedMs, name).toBeGreaterThan(3_000);
      expect(observed.elapsedMs, name).toBeLessThan(8_000);
      expect(observed.completedBeforeRequestProbe, name).toBe(false);
      expect(observed.freshBeforeCompletion, name).toBe(0);
      expect(observed.freshWithinEvaluation, name).toBe(1);
      expect(observed.requests.filter((request) => request.faulted === false), name).toMatchObject([{ faulted: false, status: 200 }]);
    }
    for (const { name, observed } of [
      { name: "policy exhaustion", observed: policyExhausted },
      { name: "catalog exhaustion", observed: catalogExhausted },
    ]) {
      expect(observed.result.status, name).toBe(403);
      expect(code(observed.result.body), name).toBe("policy_unavailable");
      expect(observed.healthy.status, `${name} healthy follow-up`).toBe(200);
      expect(observed.elapsedMs, name).toBeGreaterThan(5_500);
      expect(observed.elapsedMs, name).toBeLessThan(8_000);
      expect(observed.completedBeforeRequestProbe, name).toBe(false);
      expect(observed.freshBeforeCompletion, name).toBe(0);
      expect(observed.freshWithinEvaluation, name).toBe(0);
    }
    evidence.recordAssertionEvidence(
      "One policy or assigned-model catalog transport timeout recovers after three seconds, repeated timeouts fail closed after five and a half seconds, and every response arrives before eight seconds with a healthy fault-free follow-up",
      JSON.stringify({ policyRecovered, policyExhausted, catalogRecovered, catalogExhausted }),
      policyRecovered.result.status === 200 && catalogRecovered.result.status === 200
        && code(policyExhausted.result.body) === "policy_unavailable" && code(catalogExhausted.result.body) === "policy_unavailable"
        && policyRecovered.elapsedMs > 3_000 && catalogRecovered.elapsedMs > 3_000
        && policyExhausted.elapsedMs > 5_500 && catalogExhausted.elapsedMs > 5_500
        && [policyRecovered, catalogRecovered].every((item) => !item.completedBeforeRequestProbe && item.freshBeforeCompletion === 0 && item.freshWithinEvaluation === 1)
        && [policyExhausted, catalogExhausted].every((item) => !item.completedBeforeRequestProbe && item.freshBeforeCompletion === 0 && item.freshWithinEvaluation === 0)
        && [policyRecovered, policyExhausted, catalogRecovered, catalogExhausted]
          .every((item) => item.elapsedMs < 8_000 && item.healthy.status === 200),
    );
  });

  await step("revoked catalog access overrides a stale materialized model until the next sync removes it", async () => {
    await world.proxy.faults.clear();
    expect(await world.revokeProviderAccess()).toBe(204);
    const catalog = await world.memberCatalog();
    const catalogIds = catalog.providers.flatMap((item) => typeof item.id === "string" ? [item.id] : []);
    expect(catalog.status).toBe(200);
    expect(catalogIds).not.toContain(world.providerId);

    const stale = await world.readProviderState();
    const staleProvider = runtimeProvider(stale.runtime.body);
    const staleModels = staleProvider && isRecord(staleProvider.models) ? staleProvider.models : null;
    expect(staleModels && Object.hasOwn(staleModels, world.modelId)).toBe(true);
    expect(statusProvider(stale.status.body)).not.toBeNull();

    const denied = await faultedEvaluation(catalogPath, assignedModel, 503, 1);
    expect(denied.result.status).toBe(403);
    expect(code(denied.result.body)).toBe("organization_model_denied");
    expect(code(denied.result.body)).not.toBe("organization_policy_denied");
    expect(denied.requests).toHaveLength(2);
    expect(denied.requests.map((request) => request.status)).toEqual([503, 200]);

    await world.proxy.faults.clear();
    const synced = await world.syncProviders();
    expect(synced.run.status).toBe(200);
    expect(runtimeProvider(synced.runtime.body)).toBeNull();
    expect(statusProvider(synced.status.body)).toBeNull();
    evidence.recordAssertionEvidence(
      "A revoked direct assignment is denied as organization_model_denied even while runtime config is stale, then a fresh sync removes it",
      JSON.stringify({ providerId: world.providerId, modelId: world.modelId, memberCatalogIds: catalogIds, staleRuntimeModel: Boolean(staleModels && Object.hasOwn(staleModels, world.modelId)), denial: denied, removedFromRuntime: runtimeProvider(synced.runtime.body) === null, removedFromSyncStatus: statusProvider(synced.status.body) === null }),
      !catalogIds.includes(world.providerId) && Boolean(staleModels && Object.hasOwn(staleModels, world.modelId))
        && denied.result.status === 403 && code(denied.result.body) === "organization_model_denied"
        && denied.requests.length === 2 && runtimeProvider(synced.runtime.body) === null && statusProvider(synced.status.body) === null,
    );
  });

  await step("a retry reads and applies a fresh denial instead of the prior allow", async () => {
    const updated = await world.updateBuiltInModel(false);
    expect(updated.response.ok).toBe(true);
    const denied = await faultedEvaluation(policyPath, builtInModel, 503, 1);
    expect(denied.result.status).toBe(403);
    expect(code(denied.result.body)).toBe("organization_policy_denied");
    expect(denied.requests).toHaveLength(2);
    expect(denied.requests.map((request) => request.status)).toEqual([503, 200]);
    evidence.recordAssertionEvidence(
      "After an earlier allow, the retry uses the fresh Den denial rather than stale policy",
      JSON.stringify(denied),
      denied.result.status === 403 && code(denied.result.body) === "organization_policy_denied"
        && denied.requests.length === 2 && denied.requests[0]?.status === 503 && denied.requests[1]?.status === 200,
    );
  });
});

test(teamJourney, { timeout: 20 * 60_000 }, async ({ world: selectedWorld, user, agent, probe, step, evidence, seed }) => {
  const world = selectedWorld.team;
  if (!world) throw new Error("Expected the Team Access world");
  const member = { user: user.on(world.member), agent: agent.on(world.member), probe: probe.on(world.member) };
  const admin = { user: user.on(world.admin), probe: probe.on(world.admin) };
  const openOwnedPolicyTab = async (tabAgent: Agent, tabUser: User, title: string, url: string) => {
    const sessionId = await tabAgent.createSession(title);
    const opening = tabAgent.run("browser.open_url", { url, provider: "builtin" });
    await tabUser.click({ role: "button", label: "Allow origin in this tab" });
    expect(await opening).toMatchObject({ owner_session_id: sessionId });
  };
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
  const capabilityFields = [
    ["allowCustomProviders", "Add AI providers"],
    ["allowZenModel", "Use OpenCode models"],
    ["allowMultipleWorkspaces", "Create more workspaces"],
    ["allowControlSettings", "Change app settings"],
    ["allowManageExtensions", "Add local tools, skills & MCP servers"],
    ["allowBuiltInExtensions", "Use built-in extensions"],
    ["allowAlphaUpdates", "Try experimental updates"],
  ];
  const choose = async (label: string, allowed: boolean) => {
    const target = { role: "combobox", label };
    await admin.user.click(target);
    await admin.user.press(allowed ? "Home" : "End");
    await admin.user.press("Enter");
    await admin.user.see(target, { value: allowed ? "allow" : "deny" });
  };
  const openAppGroups = async () => {
    for (const text of ["Tools & connections", "AI setup", "Settings, workspaces & updates"]) await admin.user.click({ text });
  };
  type ReviewChange = { label: string; before: string; after: string };
  const reviewChanges = async (expected: ReviewChange[]) => {
    await admin.user.click("Review changes");
    await admin.user.see({ text: "Members of Focused work" });
    await admin.user.see({ text: `${expected.length} permission ${expected.length === 1 ? "change" : "changes"}` });
    const text = (await admin.probe.text()).replace(/\s+/g, " ");
    for (const change of expected) expect(text).toContain(`${change.label} Before ${change.before} After ${change.after}`);
    evidence.recordAssertionEvidence(`Change review shows the requested values for ${expected.map((change) => change.label).join(", ")}`, JSON.stringify({ expected, text }), expected.every((change) => text.includes(`${change.label} Before ${change.before} After ${change.after}`)));
    return text;
  };
  const saveReviewed = async (expected: ReviewChange[]) => {
    await reviewChanges(expected);
    await admin.user.click("Save permissions");
    await admin.user.see({ text: "No unsaved changes" }, { timeoutMs: 30_000 });
  };
  const initialRestrictions = capabilityFields.map(([, label]) => ({ label, before: "Allowed", after: "Blocked" }));

  const targetBaseline = await effective(world.den.members.jordan);
  const controlBaseline = await effective(world.den.members.casey);
  const memberships = [];
  for (const [teamId, memberId] of [[world.teamId, world.memberId], [world.controlTeamId, world.controlMemberId]]) {
    const result = await probe.api(world.den.admin, `/v1/teams/${teamId}`);
    expect(result.response.status).toBe(200);
    if (!isRecord(result.body) || !isRecord(result.body.team)) throw new Error("Expected team membership");
    expect(result.body.team.memberIds).toEqual([memberId]);
    memberships.push(result.body.team);
  }
  evidence.recordAssertionEvidence("The two ordinary members belong to different teams", JSON.stringify(memberships), memberships.length === 2 && world.teamId !== world.controlTeamId);
  const defaultPolicy = await readDefaultDesktopPolicy(probe, world.den.admin);
  if (!isRecord(defaultPolicy.policy)) throw new Error("Expected default policy capabilities");
  expect(defaultPolicy.policy.allowAlphaUpdates).toBe(false);
  const grantPolicy = (await policies()).find((entry) => Array.isArray(entry.assignments)
    && entry.assignments.some((assignment: unknown) => isRecord(assignment) && assignment.teamId === world.grantTeamId));
  if (!grantPolicy || !isRecord(grantPolicy.policy)) throw new Error("Expected overlapping grant policy");
  expect(grantPolicy.policy.allowAlphaUpdates).toBe(true);
  await step("the target receives Alpha access only from the overlapping grant and can open Settings", async () => {
    const roles = [];
    for (const identity of [world.den.members.jordan, world.den.members.casey]) {
      const org = await probe.api(identity, "/v1/org");
      expect(org.response.ok).toBe(true);
      if (!isRecord(org.body) || !isRecord(org.body.currentMember)) throw new Error("Expected member role");
      roles.push(org.body.currentMember.role);
      expect(org.body.currentMember.role).toBe("member");
      const config = await effective(identity);
      for (const key of lockedKeys) {
        expect(config[key]).toBe(identity === world.den.members.jordan || key !== "allowAlphaUpdates");
      }
    }
    await member.user.click(accountMenu);
    await member.user.click(settingsMenuItem);
    await member.user.see(settingsHub, { timeoutMs: 60_000 });
    await member.user.click({ role: "button", label: /^Account$/ });
    await member.user.click(permissionsTab);
    await member.user.notSee(signOut);
    for (const key of lockedKeys) {
      await member.user.see({ testId: `app-permission-${key}` }, { text: /Allowed/ });
    }
    const baselinePermissions = await member.probe.text();
    expect(count(baselinePermissions, "Allowed")).toBe(lockedKeys.length);
    expect(baselinePermissions).not.toContain("Blocked");
    await member.user.click(accountTab);
    await member.user.see(signOut);
    await member.user.click(settingsHub);
    await member.user.see(settingsHub);
    const hash = await member.probe.hash();
    expect(hash).toContain("/settings/general");
    evidence.recordAssertionEvidence("The same-role target receives grant-only Alpha access while the outside control does not, and the target can inspect all Allowed permissions", JSON.stringify({ roles, hash, baselinePermissions, targetBaseline, controlBaseline, defaultPolicy, grantPolicy }), roles.every((role) => role === "member") && targetBaseline.allowAlphaUpdates === true && controlBaseline.allowAlphaUpdates === false && hash.includes("/settings/general") && count(baselinePermissions, "Allowed") === lockedKeys.length && !baselinePermissions.includes("Blocked"));
  });

  await step("the admin reviews app restrictions for the named team before saving", async () => {
    await admin.user.see({ text: "What this team can do" }, { timeoutMs: 90_000 });
    await openAppGroups();
    for (const [, label] of capabilityFields) await choose(label, false);
    await admin.user.click("Preview member experience");
    await admin.user.see({ text: "What these choices mean for members" });
    await admin.user.see({ text: "This team’s choices are shown below. Other team and organization restrictions may further limit access." });
    for (const [key] of capabilityFields) await admin.user.see({ testId: `team-permission-preview-${key}` }, { text: /Blocked/ });
    await choose("Change app settings", true);
    await admin.user.see({ testId: "team-permission-preview-allowControlSettings" }, { text: /Allowed/ });
    for (const [key] of capabilityFields) if (key !== "allowControlSettings") await admin.user.see({ testId: `team-permission-preview-${key}` }, { text: /Blocked/ });
    const selectivePreview = await admin.probe.text();
    await choose("Change app settings", false);
    await admin.user.see({ testId: "team-permission-preview-allowControlSettings" }, { text: /Blocked/ });
    const previewText = await admin.probe.text();
    evidence.recordAssertionEvidence("The member preview follows the draft: Settings can change to Allowed while every other capability stays Blocked, then back to Blocked", JSON.stringify({ selectivePreview, previewText }), /Change app settings\s+Allowed/.test(selectivePreview) && /Change app settings\s+Blocked/.test(previewText) && capabilityFields.every(([, label]) => previewText.replace(/\s+/g, " ").includes(`${label} Blocked`)));
    const before = await policies();
    const reviewText = await reviewChanges(initialRestrictions);
    await admin.user.notSee({ text: "Members of Everyday work" });
    expect(await policies()).toEqual(before);
    expect(await effective(world.den.members.jordan)).toEqual(targetBaseline);
    expect(await effective(world.den.members.casey)).toEqual(controlBaseline);
    await admin.user.looks(["Review changes identifies Focused work and shows seven app capabilities changing from Allowed to Blocked, with Keep editing and Save permissions actions"]);
    await admin.user.click("Keep editing");
    await openAppGroups();
    for (const [, label] of capabilityFields) await admin.user.see({ role: "combobox", label }, { value: "deny" });
    expect(await policies()).toEqual(before);
    evidence.recordAssertionEvidence("Preview and review show the selected team and seven changes without saving; Keep editing retains the draft", JSON.stringify({ previewText, reviewText, before }), reviewText.includes("7 permission changes") && reviewText.includes("Members of Focused work") && !reviewText.includes("Members of Everyday work"));
    await saveReviewed(initialRestrictions);
    await admin.user.reload();
    await admin.user.see({ text: "No unsaved changes" }, { timeoutMs: 60_000 });
  });
  const lockedMember = await effective(world.den.members.jordan);
  const control = await effective(world.den.members.casey);
  for (const key of lockedKeys) {
    expect(lockedMember[key]).toBe(false);
    expect(control[key]).toBe(controlBaseline[key]);
  }
  evidence.recordAssertionEvidence("Team blocks override the grant-only Alpha permission while the outside ordinary member keeps their baseline", JSON.stringify({ targetBaseline, lockedMember, controlBaseline, control }), targetBaseline.allowAlphaUpdates === true && lockedKeys.every((key) => lockedMember[key] === false && control[key] === controlBaseline[key]));
  await admin.user.looks(["The Focused work team Access page groups Work permissions and App customization, with tools and app groups marked Admin managed"]);

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
    // Force a hidden route to test the guard, rather than a user navigation path.
    await member.agent.run("route.settings.appearance");
    const forbiddenRoute = await member.probe.eventually(() => member.probe.hash(), {
      within: 60_000, label: "forbidden appearance route redirects", until: (hash) => hash.includes("/settings/cloud-account"),
    });
    await member.user.see(accountTab);
    await member.user.see(signOut);
    await member.user.click(permissionsTab);
    await member.user.see({ text: "Your app permissions" });
    await member.user.notSee(signOut);
    await member.user.notSee(removedPolicyBanner);
    for (const key of lockedKeys) {
      await member.user.see({ testId: `app-permission-${key}` }, { text: /Blocked/ });
    }
    const permissionsText = await member.probe.text();
    expect(count(permissionsText, "Blocked")).toBe(lockedKeys.length);
    expect(permissionsText).not.toContain("Allowed");
    await member.user.looks([
      "App permissions is the selected account tab and seven read-only capability rows show Blocked",
      "The permissions page uses the app settings layout with no colored policy banner and no account sign-out controls",
    ]);
    await member.user.click(accountTab);
    await member.user.see(signOut);
    await member.user.notSee({ text: "Your app permissions" });
    const accountText = await member.probe.text();
    evidence.recordAssertionEvidence("Account and App permissions are separate working tabs under Locked access", JSON.stringify({ permissionsText, accountText }), count(permissionsText, "Blocked") === lockedKeys.length && !permissionsText.includes("Allowed") && !accountText.includes("Your app permissions"));
    await member.user.click({ role: "button", label: "Back to app" });
    await member.user.click(accountMenu);
    await member.user.see(accountMenuItem);
    await member.user.notSee(settingsMenuItem);
    const menuText = await member.probe.text();
    await member.user.press("Escape");
    await member.user.click("Library");
    await member.user.see(manageExtensionsNotice, { timeoutMs: 90_000 });
    await member.user.see({ text: /Need an MCP server or skill/ });
    await member.user.click({ role: "button", label: /^MCPs$/ });
    await member.user.notSee({ role: "button", label: "Add workspace MCP" });
    const mcpFilterText = await member.probe.text();
    expect(mcpFilterText).not.toContain("Add workspace MCP");
    await member.user.click({ role: "button", label: /^All$/ });
    await member.user.click({ role: "button", label: /^Add$/ });
    await member.user.see({ testId: "library-add-choices" });
    await member.user.see({ text: "Connection" });
    await member.user.notSee({ text: "Local MCP" });
    const choicesText = await member.probe.text();
    expect(choicesText).not.toContain("Local MCP");
    const mcpText = `${mcpFilterText}\n${choicesText}`;
    expect(mcpText).not.toContain("Add workspace MCP");
    await member.user.press("Escape");
    await member.user.notSee({ testId: "library-add-choices" });
    evidence.recordAssertionEvidence("Blocked local tool management removes local MCP creation while retaining Connection as a separate picker choice", mcpText, mcpText.includes("Connection") && !mcpText.includes("Local MCP") && !mcpText.includes("Add workspace MCP"));
    const libraryText = await member.probe.text();
    evidence.recordAssertionEvidence("The locked desktop hides Settings, redirects forbidden routes, and explains how to get an MCP server", JSON.stringify({ redirected, forbiddenRoute, permissionsText, menuText, libraryText }), redirected.includes("/settings/cloud-account") && forbiddenRoute.includes("/settings/cloud-account") && count(permissionsText, "Blocked") === lockedKeys.length && libraryText.includes("Need an MCP server or skill"));
    await member.user.looks(["The Library shows organization restrictions and guidance for requesting an MCP server or skill"]);
    const deniedProviders = await member.agent.desktopApi(`/workspace/${world.member.workspaceId}/runtime-config/disabled-providers`, {
      method: "POST", body: { providers: [] },
    });
    const allowedProviders = await agent.on(world.control).desktopApi(`/workspace/${world.control.workspaceId}/runtime-config/disabled-providers`, {
      method: "POST", body: { providers: [] },
    });
    expect(deniedProviders.status).toBe(403);
    expect(allowedProviders.status).toBe(200);
    evidence.recordAssertionEvidence("Locked settings block provider-visibility configuration only for the assigned team", JSON.stringify({ deniedProviders, allowedProviders }), deniedProviders.status === 403 && allowedProviders.status === 200);
  });

  await step("editing a legacy Locked policy restores only the explicitly chosen app capabilities", async () => {
    // Arrange data written by the previous editor. Its stored custom grants
    // are all true, while Locked keeps the actual permissions false.
    const stored = await teamPolicy();
    if (!isRecord(stored.policy)) throw new Error("Expected stored policy");
    const legacy = await seed.api(world.den.admin, `/v1/desktop-policies/${stored.id}`, {
      method: "PATCH", body: JSON.stringify({ policyName: stored.policyName, teamIds: [world.teamId], policy: { ...stored.policy, access: { mode: "locked", capabilities: Object.fromEntries(capabilityFields.map(([key]) => [key, true])) } } }),
    });
    expect(legacy.response.ok, JSON.stringify({ status: legacy.response.status, body: legacy.body })).toBe(true);
    expect(accessOf(await teamPolicy()).mode).toBe("locked");
    const legacyEffective = await effective(world.den.members.jordan);
    for (const key of lockedKeys) expect(legacyEffective[key]).toBe(false);
    await admin.user.reload();
    await admin.user.see({ text: "No unsaved changes" }, { timeoutMs: 60_000 });
    await openAppGroups();
    for (const [, label] of capabilityFields) await admin.user.see({ role: "combobox", label }, { value: "deny" });
    await choose("Change app settings", true);
    await saveReviewed([{ label: "Change app settings", before: "Blocked", after: "Allowed" }]);
    const settingsOnly = await effective(world.den.members.jordan);
    for (const key of lockedKeys) expect(settingsOnly[key]).toBe(key === "allowControlSettings");
    expect(await effective(world.den.members.casey)).toEqual(controlBaseline);
    evidence.recordAssertionEvidence("Opening a legacy Locked policy preserves its restrictions; allowing Settings does not restore hidden grants or affect the other team", JSON.stringify({ legacyEffective, settingsOnly }), lockedKeys.every((key) => legacyEffective[key] === false && settingsOnly[key] === (key === "allowControlSettings")));
    await openAppGroups();
    for (const [key, label] of capabilityFields) if (key !== "allowManageExtensions" && key !== "allowControlSettings") await choose(label, true);
    await saveReviewed(capabilityFields.filter(([key]) => key !== "allowManageExtensions" && key !== "allowControlSettings").map(([, label]) => ({ label, before: "Blocked", after: "Allowed" })));
    await admin.user.reload();
    await admin.user.see({ text: "No unsaved changes" }, { timeoutMs: 60_000 });
    const restored = accessOf(await teamPolicy());
    expect(restored.mode).toBe("custom");
    expect(restored.capabilities.allowManageExtensions).toBe(false);
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
    evidence.recordAssertionEvidence("The explicit app choices survive reload with tools still blocked while Settings returns on the real desktop", JSON.stringify({ restored, config, hash, libraryText }), restored.capabilities.allowManageExtensions === false && config.allowControlSettings === true && config.allowManageExtensions === false && hash.includes("/settings/general"));
    await member.user.click({ role: "button", label: /^Account$/ });
    await member.user.click(permissionsTab);
    await member.user.notSee(signOut);
    await member.user.notSee(removedPolicyBanner);
    await member.user.see({ testId: "app-permission-allowControlSettings" }, { text: /Change app settings\s*Allowed/ });
    await member.user.see({ testId: "app-permission-allowManageExtensions" }, { text: /Add tools, skills & MCP servers\s*Blocked/ });
    const permissionsText = await member.probe.text();
    expect(count(permissionsText, "Blocked")).toBe(1);
    expect(count(permissionsText, "Allowed")).toBe(lockedKeys.length - 1);
    evidence.recordAssertionEvidence("The Custom account permissions tab shows Settings Allowed and tools Blocked", permissionsText, count(permissionsText, "Blocked") === 1 && count(permissionsText, "Allowed") === lockedKeys.length - 1);
    await member.user.looks(["The dedicated App permissions tab shows Change app settings Allowed and Add tools, skills & MCP servers Blocked, without a policy banner"]);
    // Wait for the Library data before checking its filtered and All add controls.
    await member.user.click({ role: "button", label: "Back to app" });
    await member.user.click("Library");
    await member.user.see(manageExtensionsNotice, { timeoutMs: 90_000 });
    await member.user.see({ text: world.pluginName }, { timeoutMs: 90_000 });
    await member.user.see({ text: "No MCP servers configured yet." }, { timeoutMs: 90_000 });
    await member.user.click({ role: "button", label: /^MCPs$/ });
    await member.user.notSee({ role: "button", label: "Add workspace MCP" });
    const mcpFilterText = await member.probe.text();
    expect(mcpFilterText).not.toContain("Add workspace MCP");
    await member.user.click({ role: "button", label: /^All$/ });
    await member.user.click({ role: "button", label: /^Add$/ });
    await member.user.see({ testId: "library-add-choices" });
    await member.user.see({ text: "Connection" });
    await member.user.notSee({ text: "Local MCP" });
    const choicesText = await member.probe.text();
    expect(choicesText).not.toContain("Local MCP");
    const mcpText = `${mcpFilterText}\n${choicesText}`;
    expect(mcpText).not.toContain("Add workspace MCP");
    await member.user.press("Escape");
    await member.user.notSee({ testId: "library-add-choices" });
    evidence.recordAssertionEvidence("Blocked local tool management removes local MCP creation while retaining Connection as a separate picker choice", mcpText, mcpText.includes("Connection") && !mcpText.includes("Local MCP") && !mcpText.includes("Add workspace MCP"));
    await admin.user.looks(["Tools and connections is Admin managed while AI setup and Settings, workspaces and updates are Allowed"]);
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
  await step("the admin restricts commands and browsing for one team while the other desktop stays unrestricted", async () => {
    await admin.user.reload();
    await admin.user.see({ role: "combobox", label: "Website access" }, { timeoutMs: 60_000 });
    const beforeExecution = await effective(world.den.members.jordan);
    await admin.user.click({ role: "combobox", label: "Website access" });
    await admin.user.press("Home");
    await admin.user.press("ArrowDown");
    await admin.user.press("Enter");
    await admin.user.see({ role: "combobox", label: "Website access" }, { value: "approved" });
    await admin.user.type({ role: "textbox", label: "Website address to approve" }, "https://portal.example.com/private", { replace: true });
    await admin.user.click("Add site");
    await admin.user.see({ text: "Enter complete website addresses" });
    await admin.user.see({ text: "Add or clear the website address before reviewing changes." });
    await admin.user.notSee({ role: "button", label: "Save permissions" });
    const invalidText = await admin.probe.text();
    expect(await effective(world.den.members.jordan)).toEqual(beforeExecution);
    await admin.user.type({ role: "textbox", label: "Website address to approve" }, new URL(world.den.mocks.witness.url).origin, { replace: true });
    await admin.user.click("Add site");
    await admin.user.see({ role: "button", label: `Remove ${new URL(world.den.mocks.witness.url).origin}` });
    await admin.user.type({ role: "textbox", label: "Website address to approve" }, new URL(world.den.mocks.witness.url).origin, { replace: true });
    await admin.user.click("Add site");
    await admin.user.see({ text: "This website is already approved." });
    await admin.user.click({ role: "button", label: `Remove ${new URL(world.den.mocks.witness.url).origin}` });
    await admin.user.see({ text: "No websites are approved, so browsing is blocked" });
    await admin.user.notSee({ role: "button", label: `Remove ${new URL(world.den.mocks.witness.url).origin}` });
    const emptySites = await admin.probe.text();
    await admin.user.click("Add site");
    await admin.user.see({ role: "button", label: `Remove ${new URL(world.den.mocks.witness.url).origin}` });
    await admin.user.notSee({ text: "This website is already approved." });
    evidence.recordAssertionEvidence("Duplicate sites are rejected and removing the last site shows the blocked-browsing warning in the unsaved draft", emptySites, emptySites.includes("No websites are approved, so browsing is blocked"));
    await admin.user.see({ text: "Computer commands can still access other websites and send data." });
    await admin.user.click("Block computer commands too");
    await admin.user.notSee({ text: "Computer commands can still access other websites and send data." });
    await admin.user.click({ text: "Run computer commands" });
    await admin.user.see({ role: "combobox", label: "Computer commands" }, { value: "deny" });
    await choose("Upload files & submit forms", false);
    await admin.user.click({ text: "AI setup" });
    await choose("Add AI providers", false);
    await admin.user.click("Preview member experience");
    await admin.user.see({ testId: "team-permission-preview-browserOrigins" }, { text: /1 approved site/ });
    await admin.user.see({ testId: "team-permission-preview-commands" }, { text: /Blocked/ });
    await admin.user.see({ testId: "team-permission-preview-blockBrowserUploads" }, { text: /Blocked/ });
    await admin.user.see({ testId: "team-permission-preview-allowCustomProviders" }, { text: /Blocked/ });
    const executionPreview = await admin.probe.text();
    expect(await effective(world.den.members.jordan)).toEqual(beforeExecution);
    evidence.recordAssertionEvidence("The admin sees invalid-site feedback, adds a complete site, and closes the command bypass before saving", JSON.stringify({ invalidText, executionPreview }), invalidText.includes("Enter complete website addresses") && executionPreview.includes("1 approved site") && !executionPreview.includes("Computer commands can still access other websites and send data."));
    await saveReviewed([
      { label: "Browse websites", before: "All websites", after: new URL(world.den.mocks.witness.url).origin },
      { label: "Run computer commands", before: "Allowed", after: "Blocked" },
      { label: "Upload files & submit forms", before: "Allowed", after: "Blocked" },
      { label: "Add AI providers", before: "Allowed", after: "Blocked" },
    ]);
    await admin.probe.eventually(async () => (await effective(world.den.members.jordan)).execution, {
      within: 30_000, label: "team execution policy saved", until: (value) => isRecord(value) && value.commands === "deny",
    });
    const other = { user: user.on(world.control), agent: agent.on(world.control), probe: probe.on(world.control) };
    const targetPolicy = await member.probe.desktopApi("/managed-policy");
    const otherPolicy = await other.probe.desktopApi("/managed-policy");
    expect(targetPolicy.status).toBe(200);
    expect(otherPolicy.status).toBe(200);
    const builtInModel = { action: "model", input: { providerID: "opencode", id: "policy-proof-model" } };
    const beforeBuiltIn = await member.agent.desktopApi("/managed-policy/evaluate", { method: "POST", body: builtInModel });
    expect(beforeBuiltIn.status).toBe(200);
    await admin.user.click({ text: "AI setup" });
    await choose("Use OpenCode models", false);
    await saveReviewed([{ label: "Use OpenCode models", before: "Allowed", after: "Blocked" }]);
    await admin.probe.eventually(async () => (await effective(world.den.members.jordan)).allowZenModel, {
      within: 30_000, label: "built-in model restriction saved", until: (allowed) => allowed === false,
    });
    const deniedBuiltIn = await member.agent.desktopApi("/managed-policy/evaluate", { method: "POST", body: builtInModel });
    const allowedBuiltIn = await other.agent.desktopApi("/managed-policy/evaluate", { method: "POST", body: builtInModel });
    expect(deniedBuiltIn.status).toBe(403);
    expect(allowedBuiltIn.status).toBe(200);
    evidence.recordAssertionEvidence("The separate built-in model permission remains allowed until the admin blocks it for this team", JSON.stringify({ beforeBuiltIn, deniedBuiltIn, allowedBuiltIn }), beforeBuiltIn.status === 200 && deniedBuiltIn.status === 403 && allowedBuiltIn.status === 200);
    const attempts = [
      { action: "shell", input: { command: "printf TEAM_POLICY_EXECUTED" } },
      { action: "terminal", input: {} },
      { action: "saved_command", input: {} },
      { action: "model", input: { providerID: "unassigned-provider", id: "unassigned-model" } },
      { action: "webfetch", input: { url: world.den.mocks.witness.url } },
      { action: "browser", input: { url: "https://unapproved.example.org", method: "GET" } },
      { action: "browser", input: { url: world.den.mocks.witness.url, method: "POST", hasUpload: true } },
    ];
    for (const attempt of attempts) {
      const denied = await member.agent.desktopApi("/managed-policy/evaluate", { method: "POST", body: attempt });
      const allowed = await other.agent.desktopApi("/managed-policy/evaluate", { method: "POST", body: attempt });
      expect(denied.status).toBe(403);
      expect(allowed.status).toBe(200);
      evidence.recordAssertionEvidence(`Team policy isolates ${attempt.action} ${JSON.stringify(attempt.input)}`, JSON.stringify({ denied, allowed }), denied.status === 403 && allowed.status === 200);
    }
    for (const desktop of [member, other]) {
      expect((await desktop.agent.desktopApi("/managed-policy/evaluate", { method: "POST", body: { action: "misspelled-action", input: {} } })).status).toBe(400);
    }
    const permittedSite = await member.agent.desktopApi("/managed-policy/evaluate", { method: "POST", body: { action: "browser", input: { url: world.den.mocks.witness.url, method: "GET" } } });
    expect(permittedSite.status).toBe(200);
    await other.user.reload();
    await other.user.click(accountMenu);
    await other.user.see(settingsMenuItem);
    await other.user.press("Escape");
    await other.user.click("Library");
    await other.user.notSee(manageExtensionsNotice);
    await admin.user.reload();
    await admin.user.see({ role: "button", label: `Remove ${new URL(world.den.mocks.witness.url).origin}` }, { timeoutMs: 60_000 });
    await admin.user.looks(["Team access shows Browse websites with Approved sites only and a saved website, uploads and forms Blocked, and Run computer commands Blocked"]);
    await member.user.reload();
    await member.user.see(manageExtensionsNotice, { timeoutMs: 90_000 });
    await member.user.click(accountMenu);
    await member.user.click(settingsMenuItem);
    await member.user.see(settingsHub, { timeoutMs: 60_000 });
    await member.user.click({ role: "button", label: /^Account$/ });
    await member.user.click(permissionsTab);
    await member.user.see({ text: "OS commands" });
    await member.user.see({ text: "Approved websites" });
    await member.user.see({ text: "Browser uploads and form submissions" });
    await member.user.looks(["App permissions shows OS commands and browser uploads Blocked and lists the approved website as read-only information"]);
    await member.user.click({ role: "button", label: "Back to app" });
    const forbiddenConfig = await member.agent.desktopApi(`/workspace/${world.member.workspaceId}/opencode-config`, {
      method: "POST", body: { scope: "project", content: JSON.stringify({ permission: { "*": "allow" }, plugin: [] }) },
    });
    expect(forbiddenConfig.status).toBe(403);
    for (const engine of ["opencode", "opencode2/api"]) {
      const savedCommand = await member.agent.desktopApi(`/workspace/${world.member.workspaceId}/${engine}/session/policy-proof/command`, {
        method: "POST", body: { command: "policy-proof", arguments: "" },
      });
      expect(savedCommand.status).toBe(403);
      evidence.recordAssertionEvidence(`Saved command substitution is blocked before ${engine} dispatch`, JSON.stringify(savedCommand), savedCommand.status === 403);
    }
    const forbiddenImport = await member.agent.desktopApi(`/workspace/${world.member.workspaceId}/cloud-plugins`, {
      method: "POST", body: { resolved: {} },
    });
    const permittedImport = await other.agent.desktopApi(`/workspace/${world.control.workspaceId}/cloud-plugins`, {
      method: "POST", body: { resolved: {} },
    });
    expect(forbiddenImport.status).toBe(403);
    expect(permittedImport.status).toBe(400);
    evidence.recordAssertionEvidence("A submitted plugin bundle is rejected before import for the restricted member", JSON.stringify({ forbiddenImport, permittedImport }), forbiddenImport.status === 403 && permittedImport.status === 400);
    const extension = { name: "policy-proof-connection", config: { type: "remote", url: world.den.mocks.witness.mcpUrl, oauth: false } };
    const deniedExtension = await member.agent.desktopApi(`/workspace/${world.member.workspaceId}/mcp`, { method: "POST", body: extension });
    const permittedExtension = await other.agent.desktopApi(`/workspace/${world.control.workspaceId}/mcp`, { method: "POST", body: extension });
    expect(deniedExtension.status).toBe(403);
    expect(permittedExtension.status).toBe(200);
    evidence.recordAssertionEvidence("Direct config and extension requests cannot bypass the restricted member's UI", JSON.stringify({ forbiddenConfig, deniedExtension, permittedExtension }), forbiddenConfig.status === 403 && deniedExtension.status === 403 && permittedExtension.status === 200);
    await openOwnedPolicyTab(member.agent, member.user, "Restricted browsing policy proof", world.den.mocks.witness.url);
    await openOwnedPolicyTab(other.agent, other.user, "Control browsing policy proof", world.den.mocks.witness.url);
    const allowedBrowser = await member.agent.browserRequest({ url: `${world.den.mocks.witness.url}/health` });
    expect(allowedBrowser.reached).toBe(true);
    const outside = new URL("/health", world.den.ref.apiUrl).toString();
    const blockedBrowser = await member.agent.browserRequest({ url: outside });
    const otherBrowser = await other.agent.browserRequest({ url: outside });
    expect(blockedBrowser.reached).toBe(false);
    expect(otherBrowser.reached).toBe(true);
    const blockedUpload = await member.agent.browserRequest({ url: `${world.den.mocks.witness.url}/token`, method: "POST", body: "grant_type=invalid_policy_witness" });
    const otherUpload = await other.agent.browserRequest({ url: `${world.den.mocks.witness.url}/token`, method: "POST", body: "grant_type=invalid_policy_witness" });
    expect(blockedUpload.reached).toBe(false);
    expect(otherUpload.reached).toBe(true);
    evidence.recordAssertionEvidence("Real browser requests obey the team website and upload rules", JSON.stringify({ allowedBrowser, blockedBrowser, otherBrowser, blockedUpload, otherUpload }), allowedBrowser.reached && !blockedBrowser.reached && otherBrowser.reached && !blockedUpload.reached && otherUpload.reached);
    for (const [index, desktop] of [member, other].entries()) {
      const surface = index === 0 ? world.member : world.control;
      const proof = world.commandProofs[index];
      if (!proof) throw new Error("Missing command witness");
      const filePath = `/workspace/${surface.workspaceId}/files/content?path=${encodeURIComponent(proof.file)}`;
      expect((await desktop.probe.desktopApi(filePath)).status).toBe(404);
      await desktop.agent.createSession(`Team policy ${index === 0 ? "restricted" : "control"}`);
      await selectModel(surface, "mock-agent-workload-model", { provider: "Team access model" });
      await desktop.agent.send(`Write the policy test witness by running this OS command: ${proof.command}. Request ${proof.marker}.`);
      try {
        await desktop.probe.eventually(async () => {
          if (await desktop.probe.has("Allow once")) await desktop.user.click("Allow once");
          if (await desktop.probe.has(proof.reply)) return true;
          // A rejected unadvertised call can end the turn without another
          // model response. Require the attempted call and file witnesses
          // below in either case; the control must finish and write its file.
          return index === 0 && desktop.probe.has(/denied|blocked|no such tool|unknown tool|invalid tool|unavailable tool|tool.*(?:not found|not available|invalid)/i);
        }, { within: 120_000, label: "real engine finishes the command attempt", until: Boolean });
      } catch (error) {
        const screen = await desktop.probe.text();
        const requests = await world.den.mocks.witness.agentRequests({ promptMarker: proof.marker, atLeast: 0 });
        evidence.recordAssertionEvidence("Command attempt did not finish", JSON.stringify({ screen, requests }), false);
        await desktop.user.screenshot();
        throw error;
      }
      const witness = await desktop.probe.desktopApi(filePath);
      expect(witness.status).toBe(index === 0 ? 404 : 200);
      if (index === 1) expect(isRecord(witness.body) && witness.body.content).toBe(world.nonce);
      const requests = await world.den.mocks.witness.agentRequests({ promptMarker: proof.marker, atLeast: 1 });
      expect(requests.some((request) => request.kind === "tool")).toBe(true);
      evidence.recordAssertionEvidence(`Real command attempt ${index === 0 ? "blocked before writing" : "writes for the other member"}`, JSON.stringify({ witness, requests }), witness.status === (index === 0 ? 404 : 200));
    }
    const target = await effective(world.den.members.jordan);
    const unaffected = await effective(world.den.members.casey);
    expect(isRecord(target.execution) && target.execution.commands).toBe("deny");
    expect(isRecord(unaffected.execution) && unaffected.execution.commands).toBe("allow");
    evidence.recordAssertionEvidence("The admin's saved team policy persists while the second member retains Settings and local tool management", JSON.stringify({ target, unaffected, targetPolicy, otherPolicy }), isRecord(target.execution) && target.execution.commands === "deny" && isRecord(unaffected.execution) && unaffected.execution.commands === "allow");
  });

  await step("saving an empty approved-site list blocks the previously allowed website only for this team", async () => {
    const origin = new URL(world.den.mocks.witness.url).origin;
    const url = `${origin}/health`;
    const other = agent.on(world.control);
    await openOwnedPolicyTab(member.agent, member.user, "Restricted empty-site policy proof", origin);
    await openOwnedPolicyTab(other, user.on(world.control), "Control empty-site policy proof", origin);
    const controlBefore = await effective(world.den.members.casey);
    const before = await member.agent.browserRequest({ url });
    expect(before.reached).toBe(true);
    await admin.user.click({ role: "button", label: `Remove ${origin}` });
    await admin.user.see({ text: "No websites are approved, so browsing is blocked" });
    await admin.user.click("Preview member experience");
    await admin.user.see({ testId: "team-permission-preview-browserOrigins" }, { text: /Browsing blocked/ });
    const unsaved = await member.agent.browserRequest({ url });
    expect(unsaved.reached).toBe(true);
    evidence.recordAssertionEvidence("Removing the final site changes the preview but leaves the member's browsing available until Save", JSON.stringify({ before, unsaved }), before.reached && unsaved.reached);
    await saveReviewed([{ label: "Browse websites", before: origin, after: "Browsing blocked" }]);
    const saved = await effective(world.den.members.jordan);
    expect(isRecord(saved.execution) && saved.execution.browserOrigins).toEqual([]);
    const denied = await member.agent.desktopApi("/managed-policy/evaluate", { method: "POST", body: { action: "browser", input: { url, method: "GET" } } });
    expect(denied.status).toBe(403);
    expect(isRecord(denied.body) && denied.body.code).toBe("organization_policy_denied");
    const policyMessage = "Error invoking remote method 'openwork:browser:openUrl': Error: Your organization does not allow this website.";
    const blocked = await member.agent.browserRequest({ url }).then(
      () => { throw new Error("Expected the browser request to reject under the empty website allowlist"); },
      (error: unknown) => {
        if (!(error instanceof Error)) throw error;
        expect(error.message).toContain(policyMessage);
        return error.message;
      },
    );
    const unaffected = await other.browserRequest({ url });
    expect(unaffected.reached).toBe(true);
    expect(await effective(world.den.members.casey)).toEqual(controlBefore);
    await admin.user.reload();
    await admin.user.see({ role: "combobox", label: "Website access" }, { value: "blocked", timeoutMs: 60_000 });
    await admin.user.notSee({ role: "button", label: `Remove ${origin}` });
    evidence.recordAssertionEvidence("Saving an empty approved-site list persists browsing Blocked and rejects real requests to the formerly approved site only for the assigned team", JSON.stringify({ saved, denied, before, unsaved, blocked, unaffected, controlBefore }), denied.status === 403 && before.reached && unsaved.reached && blocked.includes(policyMessage) && unaffected.reached);
    await admin.user.looks(["Team Access shows Website access Blocked and says no websites are approved"]);
  });

});
