import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import type { Probe, User } from "@openwork/testkit";
import { claudeAgentDisabled, claudeAgentLoggedOut, claudeAgentMissing, claudeAgentSaved } from "../worlds/claude-agent-provider.ts";

const disabled = spec.world(claudeAgentDisabled, { timeout: 300_000, resources: { surfaces: ["appWeb"], services: [] }, needs: { commands: ["bun"] } });
const loggedOut = spec.world(claudeAgentLoggedOut, { timeout: 300_000, resources: { surfaces: ["appWeb"], services: [] }, needs: { commands: ["bun"] } });
const missing = spec.world(claudeAgentMissing, { timeout: 300_000, resources: { surfaces: ["appWeb"], services: [] }, needs: { commands: ["bun"] } });
const saved = spec.world(claudeAgentSaved, { timeout: 300_000, resources: { surfaces: ["appWeb"], services: [] }, needs: { commands: ["bun"] } });
const WITHIN = 60_000;

const rowText = async (probe: Probe, selector: string) => (await probe.dom(selector)).elements.map(element => element.text).join(" ");
const forbidden = (audit: ReadonlyArray<Record<string, unknown>>) => audit.some(event => event.type === "user" || String(event.type).startsWith("forbidden"));

/**
 * Anthropic → Claude Code. When the engine lists Anthropic's API key too, the
 * person first chooses between the two, on the step every provider with two
 * ways to connect uses; an engine that offers no API key goes straight to
 * Claude Code. Returns the choices that were offered.
 */
async function chooseClaudeCode(user: User, probe: Probe) {
  await user.click({ role: "button", label: /^Anthropic/ });
  const offered = await probe.eventually(async () => {
    const dialog = await rowText(probe, '[role="dialog"]');
    if (dialog.includes("Sign-in command")) return ["Claude Code"];
    if (!dialog.includes("Choose how you'd like to connect.")) return [];
    return (await probe.dom('[role="dialog"] button')).elements.map(element => element.text).filter(text => /^(Claude Code|API key)/.test(text));
  }, { within: WITHIN, label: "Anthropic opens on Claude Code or the choice of how to connect", until: value => value.length > 0 });
  if (offered.length > 1) await user.click({ role: "button", label: /^Claude Code/ });
  await user.see({ testId: "claude-code-setup" });
  return offered;
}

/** Settings → Connect a provider → Anthropic → Claude Code. */
async function openClaudeCodeStep(settingsUrl: string, user: User, probe: Probe) {
  await user.navigate(settingsUrl);
  await user.see({ role: "button", label: "Connect a provider" }, { timeoutMs: WITHIN });
  await user.click({ role: "button", label: "Connect a provider" });
  await user.type({ label: "Search providers" }, "Anthropic");
  await user.see({ text: /Sign in with Claude Code/ }, { timeoutMs: WITHIN });
  await chooseClaudeCode(user, probe);
}

// DESIGN P11/States: no "saved" interstitial. A connect ends connected or with the reason.
saved("a person with a Claude plan connects Claude Code from Anthropic and is told it works", async ({ world, user, probe, step, evidence }) => {
  await user.resizeViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  await step("before: AI Providers lists no Claude Code, and Anthropic offers it next to an API key", async () => {
    await user.navigate(world.settingsUrl);
    await user.see({ role: "button", label: "Connect a provider" }, { timeoutMs: WITHIN });
    await user.notSee({ testId: "local-provider-claude-agent" });
    await user.click({ role: "button", label: "Connect a provider" });
    await user.type({ label: "Search providers" }, "Anthropic");
    const row = await probe.eventually(() => rowText(probe, '[data-provider-id="anthropic"]'), { within: WITHIN, label: "Anthropic offers Claude Code", until: value => value.includes("Claude Code") });
    expect((await probe.dom('[data-provider-id="claude-agent"]')).elements).toHaveLength(0);
    evidence.recordAssertionEvidence("Claude Code is a way to connect Anthropic, not a separate provider", row, row.includes("Sign in with Claude Code"));
    expect(row).toContain("Sign in with Claude Code");
    await user.screenshot();
  });
  await step("Claude Code, reached from Anthropic, shows the sign-in command and one action, and asks for no secret", async () => {
    const offered = await chooseClaudeCode(user, probe);
    evidence.recordAssertionEvidence("Ways to connect Anthropic that were offered", offered.join(" | "), offered[0]?.startsWith("Claude Code") === true);
    await user.see({ text: /^claude auth login$/ });
    await user.see({ role: "button", label: "Install Claude Code" });
    await user.see({ role: "button", label: "Connect" });
    const inputs = (await probe.dom('[role="dialog"] input')).elements.length;
    const before = await world.integration();
    expect(inputs).toBe(0);
    expect(before).toHaveLength(0);
    evidence.recordAssertionEvidence("Nothing is connected or collected until the person presses Connect", `inputs=${inputs}; connections=${before.length}`, inputs === 0 && before.length === 0);
    await user.screenshot();
  });
  await step("after: Connect waits for the engine's check, then the sheet closes on a connected, ready provider", async () => {
    await user.click({ testId: "claude-code-connect" });
    await user.see({ text: "Claude Code connected" }, { timeoutMs: WITHIN });
    await probe.eventually(async () => (await probe.dom('[data-testid="claude-code-setup"]')).elements.length, { within: WITHIN, label: "the sheet closes", until: count => count === 0 });
    await user.notSee({ testId: "claude-code-setup" });
    const row = await probe.eventually(() => rowText(probe, '[data-testid="local-provider-claude-agent"]'), { within: WITHIN, label: "connected row", until: value => value.includes("Ready to use") });
    const connections = await world.integration();
    expect(connections).toHaveLength(1);
    expect(connections[0]?.status).toBeUndefined();
    expect(row).not.toMatch(/Connection saved|Not connected/);
    evidence.recordAssertionEvidence("The engine's check passed before the person was told connected", `${row}; engine connections=${connections.length}; problem=${JSON.stringify(connections[0]?.status ?? null)}`, row.includes("Ready to use") && connections.length === 1 && connections[0]?.status === undefined);
    await user.screenshot();
  });
  await step("disconnecting removes OpenWork's connection and never signs Claude Code out or sends a message", async () => {
    await user.click({ role: "button", label: "Disconnect" });
    await probe.eventually(world.integration, { within: WITHIN, label: "engine connection removed", until: values => values.length === 0 });
    await probe.eventually(async () => (await probe.dom('[data-testid="local-provider-claude-agent"]')).elements.length, { within: WITHIN, label: "the Claude Code row leaves AI Providers", until: count => count === 0 });
    await user.notSee({ testId: "local-provider-claude-agent" });
    const audit = await world.audit();
    expect(audit.some(event => event.subtype === "initialize")).toBe(true);
    expect(forbidden(audit)).toBe(false);
    evidence.recordAssertionEvidence("Only a local check of Claude Code ran: no login, logout or model request", JSON.stringify(audit.map(event => event.subtype ?? event.type)), !forbidden(audit));
    await user.screenshot();
  });
});

loggedOut("a person who has not signed in to Claude Code is told why and can check again after signing in", async ({ world, user, probe, step, evidence }) => {
  await user.resizeViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  await step("before: the Claude Code step offers the terminal sign-in command", async () => {
    await openClaudeCodeStep(world.settingsUrl, user, probe);
    await user.see({ text: /^claude auth login$/ });
    await user.see({ role: "button", label: "Connect" });
    const setup = await rowText(probe, '[data-testid="claude-code-setup"]');
    expect(setup).toContain("claude auth login");
    evidence.recordAssertionEvidence("Sign-in happens in Claude Code, outside OpenWork", setup, setup.includes("claude auth login"));
    await user.screenshot();
  });
  await step("after: Connect ends with the engine's reason and stays on the step, never 'connected'", async () => {
    await user.click({ testId: "claude-code-connect" });
    await user.see({ text: /Claude Code is not logged in/ }, { timeoutMs: WITHIN });
    await user.see({ role: "button", label: "Check again" });
    await user.see({ testId: "claude-code-setup" });
    const dialog = await rowText(probe, '[role="dialog"]');
    expect(dialog).not.toMatch(/Claude Code connected|Connection saved|Ready to use/);
    evidence.recordAssertionEvidence("The reason comes from the engine's check of Claude Code", dialog, dialog.includes("not logged in") && !/connected|Connection saved/.test(dialog));
    await user.screenshot();
  });
  await step("checking again while still signed out gives the same reason, not a false 'connected'", async () => {
    await user.click({ testId: "claude-code-connect" });
    await probe.eventually(() => rowText(probe, '[data-testid="claude-code-connect"]'), { within: WITHIN, label: "the repeat check finishes", until: value => value.includes("Check again") });
    await user.see({ text: /Claude Code is not logged in/ });
    const connections = await world.integration();
    const audit = await world.audit();
    expect(connections).toHaveLength(1);
    expect(forbidden(audit)).toBe(false);
    evidence.recordAssertionEvidence("A repeat check keeps one connection and runs no login or model request", `connections=${connections.length}; ${JSON.stringify(audit.map(event => event.subtype ?? event.type))}`, connections.length === 1 && !forbidden(audit));
    await user.screenshot();
  });
  await step("AI Providers shows Claude Code needing sign-in, with the way back to the step", async () => {
    await user.press("Escape");
    const row = await probe.eventually(() => rowText(probe, '[data-testid="local-provider-claude-agent"]'), { within: WITHIN, label: "row needs sign-in", until: value => value.includes("Needs your sign-in") });
    await user.click({ role: "button", label: "Sign in again" });
    await user.see({ testId: "claude-code-setup" }, { timeoutMs: WITHIN });
    await user.see({ role: "button", label: "Check again" });
    evidence.recordAssertionEvidence("The row says what is wrong and reopens the Claude Code step", row, row.includes("Needs your sign-in") && row.includes("not logged in"));
    expect(row).not.toContain("Ready to use");
    await user.screenshot();
  });
});

missing("a person without Claude Code installed is told to install it", async ({ world, user, probe, step, evidence }) => {
  await user.resizeViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  await step("before: the Claude Code step links to the installation instructions", async () => {
    await openClaudeCodeStep(world.settingsUrl, user, probe);
    await user.see({ role: "button", label: "Install Claude Code" });
    const setup = await rowText(probe, '[data-testid="claude-code-setup"]');
    expect(setup).toContain("Install Claude Code");
    evidence.recordAssertionEvidence("Installation has a visible next action", setup, setup.includes("Install Claude Code"));
    await user.screenshot();
  });
  await step("after: Connect says Claude Code is not installed", async () => {
    await user.click({ testId: "claude-code-connect" });
    await user.see({ text: /Claude Code is not installed/ }, { timeoutMs: WITHIN });
    const dialog = await rowText(probe, '[role="dialog"]');
    expect(dialog).not.toMatch(/Claude Code connected|Connection saved/);
    evidence.recordAssertionEvidence("A missing installation is never reported as connected", dialog, dialog.includes("not installed"));
    await user.screenshot();
  });
  await step("the step still asks for no key or password", async () => {
    await user.see({ role: "button", label: "Check again" });
    const inputs = (await probe.dom('[role="dialog"] input')).elements.length;
    expect(inputs).toBe(0);
    evidence.recordAssertionEvidence("Recovery stays credential-free", `inputs=${inputs}`, inputs === 0);
    await user.screenshot();
  });
});

disabled("a person without the feature sees no Claude Code anywhere", async ({ world, user, probe, step, evidence }) => {
  await user.resizeViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  await step("before: AI Providers has no Claude Code row", async () => {
    await user.navigate(world.settingsUrl);
    await user.see({ role: "button", label: "Connect a provider" }, { timeoutMs: WITHIN });
    await user.notSee({ testId: "local-provider-claude-agent" });
    const page = await rowText(probe, "main");
    expect(page).not.toContain("Claude");
    evidence.recordAssertionEvidence("Nothing about Claude Code on the page", `page mentions Claude: ${page.includes("Claude")}`, !page.includes("Claude"));
    await user.screenshot();
  });
  await step("Connect a provider has no Claude entry and nothing locked", async () => {
    // Where the engine's provider list cannot be read, Connect a provider stays
    // unavailable exactly as it was before Claude Code existed.
    const available = (await probe.dom('button:not([disabled])')).elements.some(element => element.text.includes("Connect a provider"));
    let dialog = "";
    if (available) {
      await user.click({ role: "button", label: "Connect a provider" });
      await user.type({ label: "Search providers" }, "Claude");
      dialog = await probe.eventually(() => rowText(probe, '[role="dialog"]'), { within: WITHIN, label: "search results", until: value => value.length > 0 });
      await user.press("Escape");
    }
    await user.see({ role: "button", label: "Connect a provider" });
    expect(dialog).not.toMatch(/Claude Agent|Claude Code|administrator/);
    expect((await probe.dom('[data-provider-id="claude-agent"], svg.lucide-lock')).elements).toHaveLength(0);
    evidence.recordAssertionEvidence("No Claude entry, no lock and no administrator notice", available ? `searched "Claude": ${dialog.slice(0, 160)}` : "Connect a provider unavailable: the engine's provider list could not be read", !/Claude Agent|Claude Code|administrator/.test(dialog));
    await user.screenshot();
  });
  await step("after: nothing was connected and Claude Code was never started", async () => {
    await user.see({ role: "button", label: "Connect a provider" });
    const connections = await world.integration();
    const audit = await world.audit();
    expect(connections).toHaveLength(0);
    expect(audit).toHaveLength(0);
    evidence.recordAssertionEvidence("No connection and no Claude Code process", `connections=${connections.length}; executable events=${audit.length}`, connections.length === 0 && audit.length === 0);
    await user.screenshot();
  });
});
