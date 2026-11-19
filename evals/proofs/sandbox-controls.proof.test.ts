import { spec, type Probe, type User } from "@openwork/testkit";
import { expect } from "vitest";
import { desktopRules, sandboxControls, sandboxControlsFlagOff, sandboxHeaders, sandboxSignedOutSettings } from "../worlds/sandbox-only.ts";

// Native policy handoff, but no guest execution or virtualization dependency.
const controls = spec.world(sandboxControls, { timeout: 600_000,
  resources: { surfaces: ["web", "desktop"], services: ["den"], nativeReason: "The embedded desktop server receives the signed-in member's verified Den policy." } });
const flagOff = spec.world(sandboxControlsFlagOff, { timeout: 600_000,
  resources: { surfaces: ["web", "desktop"], services: ["den"], nativeReason: "The embedded desktop server receives the signed-in member's verified Den policy." } });
const signedOut = spec.world(sandboxSignedOutSettings, { timeout: 600_000, resources: { surfaces: ["appWeb"], services: [] } });
const configPath = "/v1/me/desktop-config";
const onlyHeader = { "X-OpenWork-Sandbox-Only": "1" };
const settingsReady = '[data-testid="sandbox-panel"][data-ready="true"]';
const managedText = "Managed by your organization";
const legacyActions = ["computer", "computer_clipboard", "computer_files", "edit", "external_directory", "mcp", "script", "shell", "webfetch"];
const deniedModes = (body: unknown) => desktopRules(body).filter(rule => rule.effect === "deny" && (rule.action === "host_execution" || rule.action === "sandbox_opt_out"));
const legacyBlocks = (body: unknown) => desktopRules(body).filter(rule => rule.effect === "deny" && rule.resource === "*" && rule.source === "Sandbox-only policy requires an updated OpenWork app").map(rule => rule.action).sort();

async function switches(person: User, probe: Probe, use: boolean, force: boolean, lockUse: boolean, lockForce: boolean) {
  await person.see({ testId: "sandbox-use-switch" }, { timeoutMs: 60_000 });
  const selector = (mode: string, on: boolean, locked: boolean) => `[data-testid="sandbox-${mode}-switch"][aria-checked="${on}"]${locked ? ':is(:disabled,[aria-disabled="true"])' : ':not(:disabled,[aria-disabled="true"])'}`;
  await probe.eventually(async () => (await probe.dom(selector("use", use, lockUse))).elements.length === 1 && (await probe.dom(selector("force", force, lockForce))).elements.length === 1, {
    within: 45_000, label: `Use ${use ? "on" : "off"} ${lockUse ? "locked" : "editable"}; Force ${force ? "on" : "off"} ${lockForce ? "locked" : "editable"}`, until: Boolean,
  });
  return `Use ${use ? "on" : "off"} (${lockUse ? "locked" : "editable"}); Force ${force ? "on" : "off"} (${lockForce ? "locked" : "editable"})`;
}

controls("an owner requires a sandbox for Contractors without removing another member's choice", async ({ world, user, agent, probe, step, evidence }) => {
  const admin = user.on(world.web);
  const member = user.on(world.member);
  const memberProbe = probe.on(world.member);
  const openSettings = () => agent.on(world.member).run("route.settings.authorized_folders");
  const save = async (mode: string) => {
    await admin.click({ testId: `sandbox-${mode}-requirement` });
    await admin.click("Save changes");
  };
  const rules = async (persona: typeof world.riley, actions: string[]) => {
    const result = await probe.eventually(() => probe.api(persona, configPath, { headers: sandboxHeaders }), {
      within: 30_000, label: `member requirements: ${actions.join(", ") || "none"}`,
      until: result => result.response.status === 200 && JSON.stringify(deniedModes(result.body).map(rule => rule.action).sort()) === JSON.stringify(actions),
    });
    return deniedModes(result.body);
  };
  await step("before: Contractors can choose either sandbox setting", async () => {
    await openSettings();
    const state = await switches(member, memberProbe, false, false, false, false);
    expect(await rules(world.riley, [])).toEqual([]);
    evidence.recordAssertionEvidence("The member starts with both settings off", state, state.includes("Force off (editable)"));
    await member.screenshot();
  });
  await step("when the owner requires Use for Contractors", async () => {
    await admin.see({ testId: "sandbox-force-requirement" }, { timeoutMs: 60_000 });
    await save("use");
    const use = await rules(world.riley, ["sandbox_opt_out"]);
    expect(use).toContainEqual(expect.objectContaining({ source: "Contractors" }));
    const old = await probe.api(world.riley, configPath, { headers: onlyHeader });
    const oldest = await probe.api(world.riley, configPath);
    const staff = await rules(world.morgan, []);
    expect([old.response.status, oldest.response.status]).toEqual([200, 200]);
    expect(deniedModes(old.body)).toEqual([]);
    expect(deniedModes(oldest.body)).toEqual([]);
    expect(legacyBlocks(oldest.body)).toEqual([]);
    evidence.recordAssertionEvidence("Use is scoped to Contractors and does not block old clients", `Contractors: ${JSON.stringify(use)}; staff: ${JSON.stringify(staff)}; older clients: no new rules`, use.length === 1 && staff.length === 0);
    await admin.screenshot();
  });
  await step("after: the member sees an organization lock on Use but can still choose Force", async () => {
    await member.reload();
    await openSettings();
    const state = await switches(member, memberProbe, true, false, true, false);
    await member.see({ testId: "sandbox-use-managed" }, { text: managedText });
    await member.notSee({ testId: "sandbox-force-managed" });
    evidence.recordAssertionEvidence("Only Use is managed", `${state}; ${managedText}`, state.includes("Use on (locked)"));
    await member.screenshot();
  });
  await step("after: a staff member outside Contractors receives neither sandbox requirement", async () => {
    await admin.see({ testId: "sandbox-use-requirement" });
    const staff = await probe.api(world.morgan, configPath, { headers: sandboxHeaders });
    const rules = deniedModes(staff.body);
    evidence.recordAssertionEvidence("The staff member's own desktop configuration carries neither lock", `HTTP ${staff.response.status}; sandbox requirements: ${JSON.stringify(rules)}`, staff.response.status === 200 && rules.length === 0);
    expect(staff.response.status).toBe(200);
    expect(rules).toEqual([]);
    await admin.screenshot();
  });
  await step("when the member chooses Force locally under a Use requirement", async () => {
    await member.click({ testId: "sandbox-force-switch" });
    await member.reload();
    await openSettings();
    const state = await switches(member, memberProbe, true, true, true, false);
    const result = await memberProbe.desktopApi(world.memberSettings);
    expect(result.body).toMatchObject({ forceSandbox: true, managedUse: true, managedForce: false });
    evidence.recordAssertionEvidence("The stricter local choice survives reload", state, result.status === 200 && state.includes("Force on (editable)"));
    await member.screenshot();
  });
  await step("when the owner also requires Force, older desktops receive conservative blocks", async () => {
    await save("force");
    const current = await rules(world.riley, ["host_execution", "sandbox_opt_out"]);
    const old = await probe.api(world.riley, configPath, { headers: onlyHeader });
    const oldest = await probe.api(world.riley, configPath);
    expect([old.response.status, oldest.response.status]).toEqual([200, 200]);
    expect(deniedModes(old.body).map(rule => rule.action)).toEqual(["host_execution"]);
    expect(legacyBlocks(old.body)).toEqual([]);
    expect(deniedModes(oldest.body)).toEqual([]);
    expect(legacyBlocks(oldest.body)).toEqual(legacyActions);
    expect(await rules(world.morgan, [])).toEqual([]);
    evidence.recordAssertionEvidence("Current clients receive both requirements; only Force needs a legacy block", `${JSON.stringify(current)}; oldest client blocks: ${legacyBlocks(oldest.body).join(", ")}`, current.length === 2 && legacyBlocks(oldest.body).length === legacyActions.length);
    await admin.screenshot();
  });
  await step("after: both switches show Managed by your organization", async () => {
    await member.reload();
    await openSettings();
    const state = await switches(member, memberProbe, true, true, true, true);
    await member.see({ testId: "sandbox-use-managed" }, { text: managedText });
    await member.see({ testId: "sandbox-force-managed" }, { text: managedText });
    evidence.recordAssertionEvidence("Both requirements are visible and locked", `${state}; ${managedText}`, state.includes("Force on (locked)"));
    await member.screenshot();
  });
  await step("after: removing both requirements unlocks Force without clearing the member's choice", async () => {
    await save("force");
    await rules(world.riley, ["sandbox_opt_out"]);
    await save("use");
    await rules(world.riley, []);
    await member.reload();
    await openSettings();
    const state = await switches(member, memberProbe, true, true, true, false);
    await member.notSee({ text: managedText });
    await member.see({ text: "Included in Force OpenWork Sandbox" });
    evidence.recordAssertionEvidence("Only the local Force choice keeps Use included", state, state.includes("Force on (editable)"));
    await member.screenshot();
  });
  await step("after: an explicit team exception survives Everyone's Force requirement", async () => {
    await admin.navigate(world.everyoneUrl);
    await admin.see({ testId: "sandbox-force-requirement" }, { timeoutMs: 60_000 });
    await save("force");
    const staff = await rules(world.morgan, ["host_execution"]);
    const contractor = await rules(world.riley, []);
    const read = await probe.api(world.riley, "/v1/agent-permissions");
    const write = await world.tryMemberPolicyWrite();
    expect(read.response.status).toBe(403);
    expect(write.response.status).toBe(403);
    expect(await rules(world.riley, [])).toEqual([]);
    evidence.recordAssertionEvidence("Everyone's default does not overwrite the team exception and a member cannot edit policy", `staff: ${JSON.stringify(staff)}; contractor: ${JSON.stringify(contractor)}; member read/write: HTTP ${read.response.status}/${write.response.status}`, staff.length === 1 && contractor.length === 0 && write.response.status === 403);
    await admin.screenshot();
  });
});

flagOff("an owner outside the rollout can remove an old requirement but cannot add a new one", async ({ world, user, agent, probe, step, evidence }) => {
  const admin = user.on(world.web);
  const member = user.on(world.member);
  await step("before: the old Use requirement is visible but Force is not offered", async () => {
    await admin.see({ testId: "sandbox-use-requirement" }, { timeoutMs: 60_000 });
    await admin.notSee({ testId: "sandbox-force-requirement" });
    const config = await probe.api(world.riley, configPath, { headers: sandboxHeaders });
    expect(config.response.status).toBe(200);
    expect(deniedModes(config.body).map(rule => rule.action)).toEqual(["sandbox_opt_out"]);
    evidence.recordAssertionEvidence("The stored setting can still be removed", "Use is visible; Force is absent", deniedModes(config.body).length === 1);
    await admin.screenshot();
  });
  await step("after: removing the stored requirement leaves no sandbox requirements in the editor", async () => {
    await admin.click({ testId: "sandbox-use-requirement" });
    await admin.click("Save changes");
    const config = await probe.eventually(() => probe.api(world.riley, configPath, { headers: sandboxHeaders }), {
      within: 30_000, label: "the old requirement is removed", until: result => result.response.status === 200 && deniedModes(result.body).length === 0,
    });
    await admin.reload();
    await admin.see({ testId: "agent-permissions-editor" }, { timeoutMs: 60_000 });
    await admin.notSee({ testId: "sandbox-use-requirement" });
    await admin.notSee({ testId: "sandbox-force-requirement" });
    const write = await world.tryMemberPolicyWrite();
    expect(write.response.status).toBe(403);
    evidence.recordAssertionEvidence("No sandbox requirement reaches the member and policy remains admin-only", `desktop config HTTP ${config.response.status}, zero requirements; member write HTTP ${write.response.status}`, deniedModes(config.body).length === 0 && write.response.status === 403);
    await admin.screenshot();
  });
  await step("after: the member's Permissions page has Authorized folders but no sandbox section", async () => {
    await member.reload();
    await agent.on(world.member).run("route.settings.authorized_folders");
    await member.see({ testId: "authorized-folders-panel" }, { timeoutMs: 60_000 });
    const desktop = probe.on(world.member);
    await desktop.eventually(() => desktop.dom(`${settingsReady}[hidden]`), { within: 45_000, label: "Permissions settles without a visible sandbox section", until: state => state.elements.length === 1 });
    await member.notSee({ testId: "sandbox-panel" });
    await member.notSee({ testId: "sandbox-use-switch" });
    await member.notSee({ testId: "sandbox-force-switch" });
    const settings = await desktop.desktopApi(world.memberSettings);
    expect(settings.body).toMatchObject({ featureEnabled: false, managedUse: false, managedForce: false, effectiveForceSandbox: false });
    evidence.recordAssertionEvidence("The desktop omits the sandbox section outside the rollout", JSON.stringify(settings.body), settings.status === 200);
    await member.screenshot();
  });
});

signedOut("a signed-out person keeps a local Force choice until they turn off the sandbox", async ({ world, user, probe, step, evidence }) => {
  await step("before: the saved local restriction remains visible after sign-out", async () => {
    const state = await switches(user, probe, true, true, true, false);
    const settings = await probe.desktopApi(world.settingsPath);
    expect(settings.body).toMatchObject({ forceSandbox: true, effectiveForceSandbox: true, managedForce: false, featureEnabled: false, effectiveAllowHostExecution: false });
    evidence.recordAssertionEvidence("Sign-out does not re-enable tools on the computer", `${state}; ${JSON.stringify(settings.body)}`, settings.status === 200 && state.includes("Force on (editable)"));
    await user.screenshot();
  });
  await step("when the signed-out person explicitly turns off the sandbox", async () => {
    await user.click({ testId: "sandbox-force-switch" });
    await switches(user, probe, true, false, false, false);
    await user.click({ testId: "sandbox-use-switch" });
    const settings = await probe.eventually(() => probe.desktopApi(world.settingsPath), { within: 30_000, label: "the sandbox is off and the change has applied", until: result => JSON.stringify(result.body).includes('"useSandbox":false') && JSON.stringify(result.body).includes('"pending":false') });
    expect(settings.body).toMatchObject({ useSandbox: false, forceSandbox: false, effectiveAllowHostExecution: true, managedForce: false });
    evidence.recordAssertionEvidence("An explicit local choice restores ordinary tools", JSON.stringify(settings.body), settings.status === 200 && JSON.stringify(settings.body).includes('"effectiveAllowHostExecution":true'));
    await user.screenshot();
  });
  await step("after: reloading does not bring back the old restriction", async () => {
    await user.reload();
    await user.see({ testId: "authorized-folders-panel" }, { timeoutMs: 60_000 });
    await user.notSee({ testId: "sandbox-force-switch" });
    const settings = await probe.desktopApi(world.settingsPath);
    expect(settings.body).toMatchObject({ useSandbox: false, forceSandbox: false, effectiveAllowHostExecution: true, featureEnabled: false });
    evidence.recordAssertionEvidence("The signed-out choice persists", JSON.stringify(settings.body), settings.status === 200 && JSON.stringify(settings.body).includes('"effectiveAllowHostExecution":true'));
    await user.screenshot();
  });
});
