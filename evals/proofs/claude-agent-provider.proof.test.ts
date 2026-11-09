import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { claudeAgentDisabled, claudeAgentLoggedOut, claudeAgentMissing, claudeAgentSaved } from "../worlds/claude-agent-provider.ts";

const disabled = spec.world(claudeAgentDisabled, { timeout: 300_000, resources: { surfaces: ["appWeb"], services: [] }, needs: { commands: ["bun"] } });
const loggedOut = spec.world(claudeAgentLoggedOut, { timeout: 300_000, resources: { surfaces: ["appWeb"], services: [] }, needs: { commands: ["bun"] } });
const missing = spec.world(claudeAgentMissing, { timeout: 300_000, resources: { surfaces: ["appWeb"], services: [] }, needs: { commands: ["bun"] } });
const saved = spec.world(claudeAgentSaved, { timeout: 300_000, resources: { surfaces: ["appWeb"], services: [] }, needs: { commands: ["bun"] } });
const WITHIN = 60_000;

// DESIGN P4/C5: the disabled entry stays visible and neutral. P10/States:
// capture disabled, missing installation, signed out and saved-but-unverified.
disabled("a person without the rollout still sees Claude Agent locked without creating a connection", async ({ world, user, probe, step, evidence }) => {
  await user.resizeViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  await step("before: Claude Agent stays visible with the administrator's rollout explanation", async () => {
    await user.navigate(world.settingsUrl);
    await user.see({ role: "button", label: "Connect a provider" }, { timeoutMs: WITHIN });
    await user.click({ role: "button", label: "Connect a provider" });
    await user.type({ label: "Search providers" }, "Claude Agent");
    const row = await probe.eventually(async () => (await probe.dom('[data-provider-id="claude-agent"]')).elements.map(element => element.text).join(" "), {
      within: WITHIN, label: "Claude Agent is visibly blocked", until: value => value.includes("administrator"),
    });
    expect((await probe.dom('[data-provider-id="claude-agent"] [aria-label="Unavailable"]')).elements).toHaveLength(1);
    evidence.recordAssertionEvidence("The disabled capability is present with its owner and reason", row, row.includes("not enabled") && row.includes("administrator"));
    await user.screenshot();
  });
  await step("the locked setup cannot connect or ask for a secret", async () => {
    await user.click({ role: "button", label: /^Claude Agent/ });
    await user.see({ text: /Claude Agent is not enabled/ });
    await user.notSee({ testId: "claude-agent-connect" });
    const inputs = (await probe.dom('[role="dialog"] input[type="password"]')).elements.length;
    const connections = await world.integration();
    expect(inputs).toBe(0);
    expect(connections).toHaveLength(0);
    evidence.recordAssertionEvidence("No Claude connection or secret is created while disabled", `secret inputs=${inputs}; native connections=${connections.length}`, inputs === 0 && connections.length === 0);
    await user.screenshot();
  });
  await step("after: reopening setup preserves the lock and leaves Claude Code untouched", async () => {
    await user.press("Escape");
    await user.click({ role: "button", label: "Connect a provider" });
    await user.type({ label: "Search providers" }, "Claude Agent");
    await user.click({ role: "button", label: /^Claude Agent/ });
    await user.see({ text: /Claude Agent is not enabled/ });
    const audit = await world.audit();
    const connections = await world.integration();
    expect(connections).toHaveLength(0);
    expect(audit).toHaveLength(0);
    evidence.recordAssertionEvidence("A locked setup never starts Claude Code", `native connections=${connections.length}; executable events=${audit.length}`, connections.length === 0 && audit.length === 0);
    await user.screenshot();
  });
});

loggedOut("a person who has not signed in to Claude Code sees an actionable recovery without sharing credentials", async ({ world, user, probe, step, evidence }) => {
  await user.resizeViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  await step("before: Claude Agent offers installation and a terminal sign-in command, not an API key form", async () => {
    await user.navigate(world.settingsUrl);
    await user.see({ role: "button", label: "Connect Claude Code" }, { timeoutMs: WITHIN });
    await user.click({ role: "button", label: "Connect Claude Code" });
    await user.see({ role: "button", label: "Install Claude Code" });
    await user.see({ text: /^claude auth login$/ });
    await user.see({ role: "button", label: "Copy command" });
    const inputs = (await probe.dom('[data-testid="claude-agent-setup"] input')).elements.length;
    expect(inputs).toBe(0);
    evidence.recordAssertionEvidence("Claude signs in outside the app, with no credential collection", `setup inputs=${inputs}; installation and claude auth login shown`, inputs === 0);
    await user.screenshot();
  });
  await step("connecting reports that Claude Code is not logged in instead of claiming verification", async () => {
    await user.click({ testId: "claude-agent-connect" });
    // The upstream POST starts an asynchronous probe; Check again reads the
    // result rather than treating HTTP 204 or an absent status as verification.
    await probe.eventually(world.integration, { within: WITHIN, label: "native signed-out status", until: values => values.some(value => JSON.stringify(value.status).includes("not logged in")) });
    await user.click({ testId: "claude-agent-check" });
    await user.see({ text: /Claude Code is not logged in/ }, { timeoutMs: WITHIN });
    const text = (await probe.dom('[data-testid="claude-agent-setup"]')).elements.map(element => element.text).join(" ");
    expect(text).not.toContain("Ready to use");
    evidence.recordAssertionEvidence("The native account probe witnesses missing authentication", text, text.includes("not logged in") && !text.includes("Ready to use"));
    await user.screenshot();
  });
  await step("checking again keeps the recovery and never runs a login or a model request", async () => {
    await user.click({ testId: "claude-agent-check" });
    await user.see({ text: /Claude Code is not logged in/ }, { timeoutMs: WITHIN });
    const audit = await world.audit();
    expect(audit.some(event => event.subtype === "initialize")).toBe(true);
    expect(audit.some(event => event.type === "user" || String(event.type).startsWith("forbidden"))).toBe(false);
    evidence.recordAssertionEvidence("Only local initialization ran", JSON.stringify(audit), audit.some(event => event.subtype === "initialize") && !audit.some(event => event.type === "user" || String(event.type).startsWith("forbidden")));
    await user.screenshot();
  });
});

missing("a person without Claude Code gets an installation recovery rather than a saved connection presented as ready", async ({ world, user, probe, step, evidence }) => {
  await user.resizeViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  await step("before: Claude Agent setup offers the missing installation's next action", async () => {
    await user.navigate(world.settingsUrl);
    await user.see({ role: "button", label: "Connect Claude Code" }, { timeoutMs: WITHIN });
    await user.click({ role: "button", label: "Connect Claude Code" });
    await user.see({ role: "button", label: "Install Claude Code" });
    const setup = (await probe.dom('[data-testid="claude-agent-setup"]')).elements.map(element => element.text).join(" ");
    evidence.recordAssertionEvidence("Installation has a visible recovery action", setup, setup.includes("Install Claude Code"));
    await user.screenshot();
  });
  await step("after: the native probe says Claude Code is not installed", async () => {
    await user.click({ testId: "claude-agent-connect" });
    await probe.eventually(world.integration, { within: WITHIN, label: "native missing installation status", until: values => values.some(value => JSON.stringify(value.status).includes("not installed")) });
    await user.click({ testId: "claude-agent-check" });
    await user.see({ text: /Claude Code is not installed/ }, { timeoutMs: WITHIN });
    const text = (await probe.dom('[data-testid="claude-agent-setup"]')).elements.map(element => element.text).join(" ");
    expect(text).not.toContain("Ready to use");
    evidence.recordAssertionEvidence("Saving is not installation or authentication", text, text.includes("not installed") && !text.includes("Ready to use"));
    await user.screenshot();
  });
  await step("the missing installation can be checked again without asking for a key", async () => {
    await user.click({ testId: "claude-agent-check" });
    await user.see({ text: /Claude Code is not installed/ }, { timeoutMs: WITHIN });
    const inputs = (await probe.dom('[data-testid="claude-agent-setup"] input')).elements.length;
    expect(inputs).toBe(0);
    evidence.recordAssertionEvidence("Recovery stays credential-free", `setup inputs=${inputs}`, inputs === 0);
    await user.screenshot();
  });
});

saved("a person with a synthetic Claude Code account saves and disconnects only OpenWork's connection", async ({ world, user, probe, step, evidence }) => {
  await user.resizeViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  await step("before: Claude Agent is separate from Anthropic and collects no secret", async () => {
    await user.navigate(world.settingsUrl);
    await user.see({ role: "button", label: "Connect Claude Code" }, { timeoutMs: WITHIN });
    await user.click({ role: "button", label: "Connect Claude Code" });
    await user.see({ role: "button", label: "Connect Claude Code" });
    const inputs = (await probe.dom('[data-testid="claude-agent-setup"] input')).elements.length;
    expect(inputs).toBe(0);
    evidence.recordAssertionEvidence("This setup uses an external local account, not an Anthropic key", `setup inputs=${inputs}`, inputs === 0);
    await user.screenshot();
  });
  await step("after: the connection is saved, never called verified or Ready to use", async () => {
    await user.click({ testId: "claude-agent-connect" });
    await user.click({ testId: "claude-agent-check" });
    await user.see({ text: /^Connection saved$/ }, { timeoutMs: WITHIN });
    const connections = await world.integration();
    expect(connections).toHaveLength(1);
    expect(connections[0]?.status).toBeUndefined();
    const text = (await probe.dom('[data-testid="claude-agent-setup"]')).elements.map(element => element.text).join(" ");
    expect(text).not.toMatch(/Ready to use|Verified/);
    evidence.recordAssertionEvidence("Native connection saved is not a successful model request", `native connections=${connections.length}; ${text}`, connections.length === 1 && !/Ready to use|Verified/.test(text));
    await user.screenshot();
  });
  await step("disconnecting removes the connection but never logs Claude Code out", async () => {
    await user.press("Escape");
    await user.see({ role: "button", label: "Disconnect" }, { timeoutMs: WITHIN });
    await user.click({ role: "button", label: "Disconnect" });
    await probe.eventually(world.integration, { within: WITHIN, label: "native connection removed", until: values => values.length === 0 });
    await probe.eventually(async () => (await probe.dom('[data-sonner-toast]')).elements.map((element) => element.text).join(" "), {
      within: 5_000, label: "the saved notification finishes dismissing", until: (text) => !text.includes("Connection saved"),
    });
    await user.notSee({ text: /^Connection saved$/ });
    const audit = await world.audit();
    expect(audit.some(event => event.subtype === "initialize")).toBe(true);
    expect(audit.some(event => event.type === "user" || String(event.type).startsWith("forbidden"))).toBe(false);
    evidence.recordAssertionEvidence("Only OpenWork's reference was removed; no login, logout or inference ran", JSON.stringify(audit), !audit.some(event => event.type === "user" || String(event.type).startsWith("forbidden")));
    await user.screenshot();
  });
});
