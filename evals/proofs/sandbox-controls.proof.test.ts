import { spec } from "@openwork/testkit";
import { expect } from "vitest";
import { hostRules, sandboxControls, sandboxControlsFlagOff, sandboxSignedOutSettings } from "../worlds/sandbox-only.ts";

// Run this file on Daytona without KVM. It proves the real settings UI and
// per-identity Den contract, NOT microVM execution or filesystem isolation.
const controls = spec.world(sandboxControls, { timeout: 600_000,
  resources: { surfaces: ["web"], services: ["den"] } });
const flagOff = spec.world(sandboxControlsFlagOff, { timeout: 600_000,
  resources: { surfaces: ["web"], services: ["den"] } });
const signedOut = spec.world(sandboxSignedOutSettings, { timeout: 600_000,
  resources: { surfaces: ["appWeb"], services: [] } });
const row = '[data-testid="agent-permission-hostExecution"]';
const location = { label: "Where the agent runs commands" };

controls("an owner enables host tools for one team without giving other members the same exception", async ({ world, user, probe, step, evidence }) => {
  await step("before: Contractors cannot run tools on their computers but a staff member is unaffected", async () => {
    await user.see(location, { timeoutMs: 60_000 });
    const contractor = await probe.api(world.riley, "/v1/me/desktop-config", { headers: { "X-OpenWork-Sandbox-Only": "1" } });
    const staff = await probe.api(world.morgan, "/v1/me/desktop-config", { headers: { "X-OpenWork-Sandbox-Only": "1" } });
    const rules = hostRules(contractor.body);
    const otherRules = hostRules(staff.body);
    const ok = rules.some(rule => rule.effect === "deny" && rule.source === "Contractors") && !otherRules.some(rule => rule.effect === "deny");
    evidence.recordAssertionEvidence("Only the restricted team receives the host-execution denial", `Contractors: ${JSON.stringify(rules)}; staff: ${JSON.stringify(otherRules)}`, ok);
    expect(rules).toContainEqual(expect.objectContaining({ action: "host_execution", effect: "deny", source: "Contractors" }));
    expect(otherRules.some(rule => rule.effect === "deny")).toBe(false);
    expect((await probe.dom(`${row}[data-decision="deny"]`)).elements).toHaveLength(1);
    // DenSelect mounts its public role=option buttons in a portal only while open;
    // there are no native <option> elements to inspect in the closed row.
    await user.click(location);
    await user.see({ role: "option", text: "Member chooses" });
    expect((await probe.dom('[role="listbox"] [role="option"]')).elements.map(option => option.text)).toEqual(["Member chooses", "On this computer", "In a sandbox (isolated)"]);
    expect((await probe.dom('[role="listbox"] [role="option"][aria-selected="true"]')).elements.map(option => option.text)).toEqual(["In a sandbox (isolated)"]);
    expect((await probe.dom('[role="listbox"] [role="option"][disabled]')).elements).toHaveLength(0);
    await user.screenshot();
    await user.press("Escape");
  });

  await step("when the owner selects On this computer for Contractors and saves", async () => {
    await user.click(location);
    await user.press("Home");
    await user.press("ArrowDown");
    await user.press("Enter");
    await user.click("Save changes");
    const rules = await probe.eventually(async () => hostRules((await probe.api(world.riley, "/v1/me/desktop-config", { headers: { "X-OpenWork-Sandbox-Only": "1" } })).body), {
      within: 30_000, label: "Contractors no longer receives a host-execution denial", until: value => !value.some(rule => rule.effect === "deny"),
    });
    const decision = (await probe.dom(`${row}[data-decision="allow"]`)).elements.length === 1 ? "allow" : "deny";
    evidence.recordAssertionEvidence("The saved location explicitly selects this computer for the team", `team setting: ${decision}; member's rules: ${JSON.stringify(rules)}`, decision === "allow" && rules.some(rule => rule.effect === "allow" && rule.source === "Contractors"));
    expect(decision).toBe("allow");
    expect(rules).toContainEqual(expect.objectContaining({ action: "host_execution", effect: "allow", source: "Contractors" }));
    expect((await probe.dom(`${row} [aria-haspopup="listbox"]`)).elements.map(control => control.text)).toEqual(["On this computer"]);
    await user.screenshot();
  });

  await step("when the owner selects In a sandbox (isolated) for Everyone", async () => {
    await user.navigate(world.everyoneUrl);
    await user.see(location, { timeoutMs: 60_000 });
    await user.click(location);
    await user.press("End");
    await user.press("Enter");
    await user.click("Save changes");
    const rules = await probe.eventually(async () => hostRules((await probe.api(world.riley, "/v1/me/desktop-config", { headers: { "X-OpenWork-Sandbox-Only": "1" } })).body), {
      within: 30_000, label: "the team's explicit exception remains in effect", until: value => !value.some(rule => rule.effect === "deny"),
    });
    const staff = await probe.eventually(async () => hostRules((await probe.api(world.morgan, "/v1/me/desktop-config", { headers: { "X-OpenWork-Sandbox-Only": "1" } })).body), {
      within: 30_000, label: "Everyone's default restriction reaches the staff member", until: value => value.some(rule => rule.effect === "deny"),
    });
    evidence.recordAssertionEvidence("Everyone's default applies outside the team's explicit exception", `contractor: ${JSON.stringify(rules)}; staff: ${JSON.stringify(staff)}`, !rules.some(rule => rule.effect === "deny") && staff.some(rule => rule.effect === "deny"));
    expect(rules.some(rule => rule.effect === "deny")).toBe(false);
    expect(staff).toContainEqual(expect.objectContaining({ action: "host_execution", effect: "deny" }));
    expect((await probe.dom(`${row} [aria-haspopup="listbox"]`)).elements.map(control => control.text)).toEqual(["In a sandbox (isolated)"]);
    await user.screenshot();
  });

  await step("after: only Contractors keep their exception and the ordinary member cannot open the team's policy", async () => {
    await user.navigate(world.teamUrl);
    await user.see(location, { timeoutMs: 60_000 });
    const contractor = hostRules((await probe.api(world.riley, "/v1/me/desktop-config", { headers: { "X-OpenWork-Sandbox-Only": "1" } })).body);
    const staff = hostRules((await probe.api(world.morgan, "/v1/me/desktop-config", { headers: { "X-OpenWork-Sandbox-Only": "1" } })).body);
    const forbidden = await probe.api(world.riley, "/v1/agent-permissions");
    const ok = !contractor.some(rule => rule.effect === "deny") && staff.some(rule => rule.effect === "deny") && forbidden.response.status === 403;
    evidence.recordAssertionEvidence("A team's exception is scoped to its members and cannot be edited by an ordinary member", `contractor: ${JSON.stringify(contractor)}; staff: ${JSON.stringify(staff)}; member team-policy access: HTTP ${forbidden.response.status}`, ok);
    expect(contractor.some(rule => rule.effect === "deny")).toBe(false);
    expect(staff.some(rule => rule.effect === "deny")).toBe(true);
    expect(forbidden.response.status).toBe(403);
    await user.screenshot();
  });
  await step("when the owner restores Member chooses for Everyone the team's explicit computer choice remains", async () => {
    await user.navigate(world.everyoneUrl);
    await user.see(location, { timeoutMs: 60_000 });
    await user.click(location);
    await user.press("Home");
    await user.press("Enter");
    await user.click("Save changes");
    const staff = await probe.eventually(async () => hostRules((await probe.api(world.morgan, "/v1/me/desktop-config", { headers: { "X-OpenWork-Sandbox-Only": "1" } })).body), {
      within: 30_000, label: "the ordinary staff member chooses their own execution location again", until: value => value.length === 0,
    });
    const contractor = hostRules((await probe.api(world.riley, "/v1/me/desktop-config", { headers: { "X-OpenWork-Sandbox-Only": "1" } })).body);
    evidence.recordAssertionEvidence("Member chooses removes the default mandate without clearing the team's explicit location", `staff: ${JSON.stringify(staff)}; contractor: ${JSON.stringify(contractor)}`, staff.length === 0 && contractor.some(rule => rule.effect === "allow" && rule.source === "Contractors"));
    expect(staff).toHaveLength(0);
    expect(contractor).toContainEqual(expect.objectContaining({ action: "host_execution", effect: "allow", source: "Contractors" }));
    expect((await probe.dom(`${row} [aria-haspopup="listbox"]`)).elements.map(control => control.text)).toEqual(["Member chooses"]);
    await user.screenshot();
  });
});

flagOff("an owner outside the rollout does not see a new host-tools switch", async ({ world, user, probe, step, evidence }) => {
  await step("before: the team's existing agent permissions remain available without the new row", async () => {
    await user.see({ testId: "agent-permissions-editor" }, { timeoutMs: 60_000 });
    const rows = await probe.dom(row);
    evidence.recordAssertionEvidence("The default-off rollout adds no host-tools control", `host-tools rows: ${rows.elements.length}`, rows.elements.length === 0);
    expect(rows.elements).toHaveLength(0);
    await user.screenshot();
  });
  await step("after: the member receives no new host-execution restriction", async () => {
    await user.see({ testId: "agent-permissions-editor" });
    const config = await probe.api(world.riley, "/v1/me/desktop-config", { headers: { "X-OpenWork-Sandbox-Only": "1" } });
    const rules = hostRules(config.body);
    evidence.recordAssertionEvidence("Existing host behavior remains unrestricted", `HTTP ${config.response.status}; host rules: ${JSON.stringify(rules)}`, config.response.status === 200 && rules.length === 0);
    expect(config.response.status).toBe(200);
    expect(rules).toHaveLength(0);
    await user.screenshot();
  });
  await step("the ordinary member still cannot open the team's agent-policy editor", async () => {
    await user.see({ testId: "agent-permissions-editor" });
    const response = await probe.api(world.riley, "/v1/agent-permissions");
    evidence.recordAssertionEvidence("Leaving the rollout off does not broaden administrative access", `member policy access: HTTP ${response.response.status}`, response.response.status === 403);
    expect(response.response.status).toBe(403);
    await user.screenshot();
  });
});

signedOut("a signed-out person outside the rollout keeps their stricter saved choice without seeing flagged controls", async ({ world, user, probe, step, evidence }) => {
  await step("before: sign-out does not silently re-enable commands on this computer", async () => {
    await user.see({ text: "Authorized folders" }, { timeoutMs: 60_000 });
    const settings = await probe.desktopApi(world.settingsPath);
    evidence.recordAssertionEvidence("The stricter saved choice remains effective without a verified rollout", JSON.stringify(settings.body), settings.status === 200 && JSON.stringify(settings.body).includes('"effectiveAllowHostExecution":false'));
    expect(settings.body).toMatchObject({ allowHostExecution: false, effectiveAllowHostExecution: false, managed: false, featureEnabled: false });
    await user.screenshot();
  });
  await step("when permissions are open the flagged execution-location section is absent", async () => {
    await user.notSee({ testId: "host-execution-row" });
    const rows = await probe.dom('[data-testid="host-execution-row"]');
    evidence.recordAssertionEvidence("Flag-off hides the entire execution-location section, not just one option", JSON.stringify(rows), rows.elements.length === 0);
    expect(rows.elements).toHaveLength(0);
    await user.screenshot();
  });
  await step("after: reloading preserves the restriction and does not reveal the flagged section", async () => {
    await user.reload();
    await user.see({ text: "Authorized folders" }, { timeoutMs: 60_000 });
    await user.notSee({ testId: "host-execution-row" });
    const settings = await probe.desktopApi(world.settingsPath);
    evidence.recordAssertionEvidence("A reload neither enables host commands nor opts a signed-out person into the rollout", JSON.stringify(settings.body), settings.status === 200 && JSON.stringify(settings.body).includes('"effectiveAllowHostExecution":false'));
    expect(settings.body).toMatchObject({ allowHostExecution: false, effectiveAllowHostExecution: false, featureEnabled: false });
    await user.screenshot();
  });
});
