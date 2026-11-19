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
const toggle = { role: "switch" as const, label: "Run tools on this computer" };

controls("an owner enables host tools for one team without giving other members the same exception", async ({ world, user, probe, step, evidence }) => {
  await step("before: Contractors cannot run tools on their computers but a staff member is unaffected", async () => {
    await user.see(toggle, { timeoutMs: 60_000 });
    const contractor = await probe.api(world.riley, "/v1/me/desktop-config", { headers: { "X-OpenWork-Sandbox-Only": "1" } });
    const staff = await probe.api(world.morgan, "/v1/me/desktop-config", { headers: { "X-OpenWork-Sandbox-Only": "1" } });
    const rules = hostRules(contractor.body);
    const otherRules = hostRules(staff.body);
    const ok = rules.some(rule => rule.effect === "deny" && rule.source === "Contractors") && !otherRules.some(rule => rule.effect === "deny");
    evidence.recordAssertionEvidence("Only the restricted team receives the host-execution denial", `Contractors: ${JSON.stringify(rules)}; staff: ${JSON.stringify(otherRules)}`, ok);
    expect(rules).toContainEqual(expect.objectContaining({ action: "host_execution", effect: "deny", source: "Contractors" }));
    expect(otherRules.some(rule => rule.effect === "deny")).toBe(false);
    expect((await probe.dom(`${row}[data-decision="deny"]`)).elements).toHaveLength(1);
    await user.screenshot();
  });

  await step("when the owner enables Run tools on this computer for Contractors and saves", async () => {
    await user.click(toggle);
    await user.click("Save changes");
    const rules = await probe.eventually(async () => hostRules((await probe.api(world.riley, "/v1/me/desktop-config", { headers: { "X-OpenWork-Sandbox-Only": "1" } })).body), {
      within: 30_000, label: "Contractors no longer receives a host-execution denial", until: value => !value.some(rule => rule.effect === "deny"),
    });
    const decision = (await probe.dom(`${row}[data-decision="allow"]`)).elements.length === 1 ? "allow" : "deny";
    evidence.recordAssertionEvidence("The saved team toggle enables the member", `team setting: ${decision}; member's rules: ${JSON.stringify(rules)}`, decision === "allow" && !rules.some(rule => rule.effect === "deny"));
    expect(decision).toBe("allow");
    expect(rules.some(rule => rule.effect === "deny")).toBe(false);
    await user.screenshot();
  });

  await step("when the owner turns off host tools for Everyone", async () => {
    await user.navigate(world.everyoneUrl);
    await user.see(toggle, { timeoutMs: 60_000 });
    await user.click(toggle);
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
    await user.screenshot();
  });

  await step("after: only Contractors keep their exception and the ordinary member cannot open the team's policy", async () => {
    await user.navigate(world.teamUrl);
    await user.see(toggle, { timeoutMs: 60_000 });
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

signedOut("a signed-out person keeps their stricter local setting and can restore host tools explicitly", async ({ world, user, probe, step, evidence }) => {
  await step("before: the saved local restriction remains visible without a verified sandbox rollout", async () => {
    await user.see({ testId: "host-execution-switch" }, { timeoutMs: 60_000 });
    const settings = await probe.desktopApi(world.settingsPath);
    evidence.recordAssertionEvidence("Sign-out does not silently re-enable host execution", JSON.stringify(settings.body), settings.status === 200 && JSON.stringify(settings.body).includes('"effectiveAllowHostExecution":false'));
    expect(settings.body).toMatchObject({ allowHostExecution: false, effectiveAllowHostExecution: false, managed: false, featureEnabled: false });
    expect((await probe.dom('[data-testid="host-execution-note"][data-host-execution-note="sandbox_unavailable"]')).elements).toHaveLength(1);
    await user.screenshot();
  });
  await step("when the signed-out person explicitly enables Run tools on this computer", async () => {
    await user.click({ testId: "host-execution-switch" });
    const settings = await probe.eventually(() => probe.desktopApi(world.settingsPath), { within: 30_000, label: "the explicit local preference saves", until: result => JSON.stringify(result.body).includes('"effectiveAllowHostExecution":true') });
    evidence.recordAssertionEvidence("An explicit local choice restores host tools", JSON.stringify(settings.body), settings.status === 200 && JSON.stringify(settings.body).includes('"allowHostExecution":true'));
    expect(settings.body).toMatchObject({ allowHostExecution: true, effectiveAllowHostExecution: true, managed: false });
    await user.screenshot();
  });
  await step("after: reloading does not bring back the old restriction", async () => {
    await user.reload();
    await user.see({ text: "Authorized folders" }, { timeoutMs: 60_000 });
    const settings = await probe.desktopApi(world.settingsPath);
    evidence.recordAssertionEvidence("The local preference survives a reload", JSON.stringify(settings.body), settings.status === 200 && JSON.stringify(settings.body).includes('"effectiveAllowHostExecution":true'));
    expect(settings.body).toMatchObject({ allowHostExecution: true, effectiveAllowHostExecution: true, featureEnabled: false });
    await user.screenshot();
  });
});
