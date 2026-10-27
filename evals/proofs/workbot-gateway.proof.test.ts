import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { workbotGateway } from "../worlds/workbot-gateway.ts";

const test = spec.world(workbotGateway, {
  timeout: 600_000,
  needs: { placement: "local" },
  resources: { surfaces: ["web"], services: ["den"] },
});

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Expected settings response");
  return Object.fromEntries(Object.entries(value));
}
function modelIds(value: unknown): string[] {
  return Array.isArray(value) ? value.map(item => String(record(item).id)) : [];
}
function modelLabel(name: string): RegExp {
  // Provider marks contribute a leading letter to the option's accessible name.
  return new RegExp(`${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
}

test("an owner chooses an Anthropic gateway model for Workbot without granting it to another member", async ({ world, user, probe, step, evidence }) => {
  const member = user.on(world.member);
  const memberProbe = probe.on(world.member);
  await step("Workbot offers the owner's configured Anthropic and OpenAI gateway models", async () => {
    await user.see({ role: "combobox", label: "Default model" });
    await user.click({ role: "combobox", label: "Default model" });
    await user.see({ role: "option", label: modelLabel(world.anthropic.name) });
    await user.see({ role: "option", label: modelLabel(world.openai.name) });
    await user.notSee({ role: "option", label: /Another model$/ });
    // One default model: no separate "Default: …" entry and no second "Workbot default" row.
    await user.notSee({ role: "option", label: /^Default/ });
    await user.notSee({ text: "Workbot default" });
    const response = await probe.api(world.admin, "/v1/org/workbot-settings", { headers: world.scope });
    const ids = modelIds(record(response.body).models);
    expect(ids.sort()).toEqual([world.anthropic.id, world.openai.id].sort());
    evidence.recordAssertionEvidence("The real settings catalog now follows the member's gateway grants", `${world.anthropic.upstreamId} + ${world.openai.upstreamId}; deployment-only gateway/other absent`, response.response.ok && ids.length === 2 && !ids.includes("gateway/other"));
    await user.screenshot();
    await user.click({ role: "option", label: modelLabel(world.anthropic.name) });
  });
  await step("the owner's Anthropic default survives saving and reloading", async () => {
    await user.click({ role: "button", label: "Save model" });
    await user.see({ text: `Saved. New messages use ${world.anthropic.name}.` });
    await user.see({ testId: "workbot-default-readiness" }, { text: "Available" });
    // Saving never narrows the list: every model stays choosable straight after the save.
    await user.click({ role: "combobox", label: "Default model" });
    await user.see({ role: "option", label: modelLabel(world.anthropic.name) });
    await user.see({ role: "option", label: modelLabel(world.openai.name) });
    await user.press("Escape");
    await user.reload();
    await user.see({ role: "combobox", label: "Default model" }, { value: world.anthropic.name });
    const response = await probe.api(world.admin, "/v1/org/workbot-settings", { headers: world.scope });
    const settings = record(response.body);
    expect(settings.model).toBe(world.anthropic.id);
    expect(settings.modelAvailable).toBe(true);
    evidence.recordAssertionEvidence("The saved choice is the usable Anthropic gateway alias, not a runner fallback", `HTTP ${response.response.status}; ${world.anthropic.upstreamId} selected after reload; modelAvailable=${settings.modelAvailable}`, response.response.ok && settings.model === world.anthropic.id && settings.modelAvailable === true);
    await user.screenshot();
  });
  await step("another model manager cannot choose the owner's unassigned Anthropic default", async () => {
    await member.reload();
    await member.see({ role: "combobox", label: "Default model" }, { value: "Unavailable model" });
    await member.see({ text: /Workbot can't use the saved model right now, so new messages won't send\./ });
    await member.see({ testId: "workbot-default-readiness" }, { text: "Unavailable" });
    await member.notSee({ text: /New messages use the default model/ });
    await member.notSee({ text: world.anthropic.id });
    await member.click({ role: "combobox", label: "Default model" });
    await member.see({ role: "option", label: /^Unavailable model\s*Not available to you$/ });
    await member.notSee({ text: world.anthropic.id });
    await member.see({ role: "option", label: modelLabel(world.openai.name) });
    await member.notSee({ role: "option", label: modelLabel(world.anthropic.name) });
    const response = await probe.api(world.restricted, "/v1/org/workbot-settings", { headers: world.scope });
    const settings = record(response.body);
    const ids = modelIds(settings.models);
    expect(settings.model).toBe(world.anthropic.id);
    expect(settings.modelAvailable).toBe(false);
    expect(settings.gatewayModels).toBe(true);
    expect(ids).toEqual([world.openai.id]);
    const memberText = await memberProbe.text();
    const honestUnavailable = !memberText.includes(world.anthropic.id) && !memberText.includes("New messages use the default model");
    expect(honestUnavailable).toBe(true);
    evidence.recordAssertionEvidence("An organization default never grants another member gateway access", `HTTP ${response.response.status}; saved Anthropic modelAvailable=${settings.modelAvailable}; restricted manager has only ${world.openai.upstreamId}; UI names the access blocker without a fallback promise or opaque alias`, response.response.ok && settings.gatewayModels === true && settings.modelAvailable === false && ids.join() === world.openai.id && honestUnavailable);
    await member.screenshot();
    await member.press("Escape");
  });
  await step("model discovery and saving expose no credentials and send no paid inference", async () => {
    await user.see({ role: "combobox", label: "Default model" }, { value: world.anthropic.name });
    const ownerSettings = await probe.api(world.admin, "/v1/org/workbot-settings", { headers: world.scope });
    const memberSettings = await probe.api(world.restricted, "/v1/org/workbot-settings", { headers: world.scope });
    const privateValuesAbsent = world.secretsAbsent([await probe.text(), await memberProbe.text(), ownerSettings.text, memberSettings.text].join("\n"));
    expect(privateValuesAbsent).toBe(true);
    expect(world.completionCount()).toBe(0);
    evidence.recordAssertionEvidence("Settings remain credential-free and discovery is not a paid completion", `owner/member UI and settings responses contain no fixture provider key or gateway bearer; completion calls=${world.completionCount()}`, privateValuesAbsent && world.completionCount() === 0);
  });
});
