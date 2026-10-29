import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { workbotLunaDefaultWorld } from "../worlds/workbot-luna-default.ts";

const available = spec.world(workbotLunaDefaultWorld(true), { timeout: 600_000, needs: { placement: "local" }, resources: { surfaces: ["web"], services: ["den"] } });
const unavailable = spec.world(workbotLunaDefaultWorld(false), { timeout: 600_000, needs: { placement: "local" }, resources: { surfaces: ["web"], services: ["den"] } });
const unverified = spec.world(workbotLunaDefaultWorld(false, false), { timeout: 600_000, needs: { placement: "local" }, resources: { surfaces: ["web"], services: ["den"] } });
const unauthorized = spec.world(workbotLunaDefaultWorld(true, true, "unauthorized"), { timeout: 600_000, needs: { placement: "local" }, resources: { surfaces: ["web"], services: ["den"] } });
const payment = spec.world(workbotLunaDefaultWorld(true, true, "payment_required"), { timeout: 600_000, needs: { placement: "local" }, resources: { surfaces: ["web"], services: ["den"] } });
const unavailableProvider = spec.world(workbotLunaDefaultWorld(true, true, "unavailable"), { timeout: 600_000, needs: { placement: "local" }, resources: { surfaces: ["web"], services: ["den"] } });

function modelLabel(name: string): RegExp {
  // Provider marks contribute a leading letter to the option's accessible name.
  return new RegExp(`${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
}

available("an owner gets the Luna default without a feature override and keeps their saved model", async ({ world, user, probe, step, evidence }) => {
  await step("after: the owner sees GPT-6 Luna as the available default without enabling a rollout", async () => {
    await user.navigate(world.settingsUrl);
    await user.see({ role: "combobox", label: "Default model" }, { value: "GPT-6 Luna" });
    await user.see({ testId: "workbot-default-readiness" }, { text: "Available" });
    await user.click({ role: "button", label: "Check availability" });
    await user.see({ testId: "workbot-default-readiness" }, { text: "Available" });
    await user.see({ testId: "workbot-model-test-result" }, { text: "Not tested (short paid request)" });
    expect(world.completionCount()).toBe(0);
    evidence.recordAssertionEvidence("Catalog availability is not an answered completion", "Available; Not tested; provider completion calls=0", world.completionCount() === 0);
    await user.screenshot();
  });
  await step("the owner's saved default answers a bounded synthetic request", async () => {
    await user.click({ role: "button", label: "Test model" });
    await user.see({ testId: "workbot-model-test-result" }, { text: "Answered" });
    await user.notSee({ text: /fixture-answer-must-stay-private/ });
    expect(world.completionCount()).toBe(1);
    expect(world.authorizedCompletions()).toBe(true);
    evidence.recordAssertionEvidence("Answered follows a real adapter completion", `provider calls=${world.completionCount()}; configured key accepted=${world.authorizedCompletions()}`, world.completionCount() === 1 && world.authorizedCompletions());
    await user.screenshot();
  });
  await step("the owner keeps an explicit organization model instead of Luna", async () => {
    await user.click({ role: "combobox", label: "Default model" });
    await user.click({ role: "option", label: modelLabel(world.otherName) });
    await user.click({ role: "button", label: "Save model" });
    await user.see({ text: `Saved. New messages use ${world.otherName}.` });
    await user.reload();
    await user.see({ role: "combobox", label: "Default model" }, { value: world.otherName });
    evidence.recordAssertionEvidence("An explicit model survives reload", "Another model remains selected", (await probe.dom(`[data-testid="workbot-model-picker"] input[value="${world.otherName}"]`)).elements.length === 1);
    await user.screenshot();
  });
  await step("reopening settings keeps the organization's saved model and readiness information", async () => {
    await user.reload();
    await user.see({ role: "combobox", label: "Default model" }, { value: world.otherName });
    await user.see({ testId: "workbot-default-readiness" }, { text: "Available" });
    evidence.recordAssertionEvidence("General availability preserves the saved choice", "Another model remains selected and available", (await probe.dom(`[data-testid="workbot-model-picker"] input[value="${world.otherName}"]`)).elements.length === 1);
    await user.screenshot();
  });
});

unavailable("an owner sees unavailable Luna without a silent fallback", async ({ world, user, probe, step, evidence }) => {
  await step("an unavailable Luna stays named as the default", async () => {
    await user.see({ role: "combobox", label: "Default model" }, { value: "GPT-6 Luna" });
    await user.see({ testId: "workbot-default-readiness" }, { text: "Unavailable" });
    await user.see({ text: /Workbot can't use GPT-6 Luna right now/ });
    evidence.recordAssertionEvidence("The default is unavailable, not replaced", "GPT-6 Luna stays selected and is marked Unavailable", (await probe.dom('[data-testid="workbot-default-readiness"]')).elements.length === 1);
    await user.screenshot();
  });
  await step("checking again never substitutes the runner's other model", async () => {
    await user.click({ role: "button", label: "Check availability" });
    await user.see({ testId: "workbot-default-readiness" }, { text: "Unavailable" });
    await user.see({ role: "combobox", label: "Default model" }, { value: "GPT-6 Luna" });
    evidence.recordAssertionEvidence("A fresh check keeps the unavailable state honest", "No model was silently selected for the owner", (await probe.dom('[data-testid="workbot-model-picker"] input[value="GPT-6 Luna"]')).elements.length === 1);
    await user.screenshot();
  });
  await step("the owner explicitly chooses an available model to recover", async () => {
    await user.click({ role: "combobox", label: "Default model" });
    await user.click({ role: "option", label: modelLabel(world.otherName) });
    await user.click({ role: "button", label: "Save model" });
    await user.see({ text: `Saved. New messages use ${world.otherName}.` });
    await user.notSee({ text: /Workbot can't use GPT-6 Luna right now/ });
    await user.see({ testId: "workbot-default-readiness" }, { text: "Available" });
    evidence.recordAssertionEvidence("Recovery is the owner's choice", "Another model was saved explicitly and is available", (await probe.dom(`[data-testid="workbot-model-picker"] input[value="${world.otherName}"]`)).elements.length === 1);
    await user.screenshot();
  });
});

unverified("an owner cannot mistake an unverified runner fallback for a ready default", async ({ user, probe, step, evidence }) => {
  await step("the owner sees that Luna could not be verified", async () => {
    await user.see({ testId: "workbot-default-readiness" }, { text: "Couldn't check" });
    await user.see({ role: "combobox", label: "Default model" }, { value: "GPT-6 Luna" });
    evidence.recordAssertionEvidence("A configured fallback is not readiness", "Couldn't check", (await probe.dom('[data-testid="workbot-default-readiness"]')).elements.some(element => element.text === "Couldn't check"));
    await user.screenshot();
  });
  await step("unverified models cannot be saved as if access had been checked", async () => {
    await user.see({ role: "button", label: "Save model" });
    const disabled = (await probe.dom('[data-testid="workbot-model-picker"] input[disabled]')).elements.length === 1;
    expect(disabled).toBe(true);
    evidence.recordAssertionEvidence("The picker stays blocked until models can be verified", "The default-model input is disabled", disabled);
    await user.screenshot();
  });
  await step("a new check keeps the honest state and gives the owner a recovery action", async () => {
    await user.click({ role: "button", label: "Check availability" });
    await user.see({ testId: "workbot-default-readiness" }, { text: "Couldn't check" });
    await user.see({ text: "Couldn't reach Workbot's models, so the model can't be changed right now." });
    evidence.recordAssertionEvidence("No unrelated model is selected after a failed verification", "GPT-6 Luna remains selected and the outage is explained", (await probe.dom('[data-testid="workbot-model-picker"] input[value="GPT-6 Luna"]')).elements.length === 1);
    await user.screenshot();
  });
});

unauthorized("an owner sees access refused when a listed model rejects its completion", async ({ world, user, step, evidence }) => {
  await step("before: the catalog lists Luna but no completion has been tested", async () => {
    await user.see({ testId: "workbot-default-readiness" }, { text: "Available" });
    await user.see({ testId: "workbot-model-test-result" }, { text: "Not tested (short paid request)" });
    evidence.recordAssertionEvidence("A catalog listing is not a completed answer", `completion calls=${world.completionCount()}`, world.completionCount() === 0);
    await user.screenshot();
  });
  await step("the owner tests the default and sees that access was refused", async () => {
    await user.click({ role: "button", label: "Test model" });
    await user.see({ testId: "workbot-model-test-result" }, { text: "Access refused. Check the runner's model key." });
    await user.notSee({ text: /fixture-private|fixture-model-key/ });
    evidence.recordAssertionEvidence("The real provider refused the configured key", `HTTP 401; completion calls=${world.completionCount()}`, world.completionCount() === 1);
    await user.screenshot();
  });
  await step("after: another catalog check cannot turn that refusal into Answered", async () => {
    await user.click({ role: "button", label: "Check availability" });
    await user.see({ testId: "workbot-default-readiness" }, { text: "Available" });
    await user.see({ testId: "workbot-model-test-result" }, { text: "Access refused. Check the runner's model key." });
    await user.notSee({ text: "Answered" });
    evidence.recordAssertionEvidence("Catalog refresh never invents completion success", `The model remains listed; completion calls=${world.completionCount()}; result is access refused`, world.completionCount() === 1);
    await user.screenshot();
  });
});

payment("an owner sees payment required when a listed model cannot be paid for", async ({ world, user, step, evidence }) => {
  await step("before: an available catalog entry still has no completion result", async () => {
    await user.see({ testId: "workbot-default-readiness" }, { text: "Available" });
    await user.see({ testId: "workbot-model-test-result" }, { text: "Not tested (short paid request)" });
    evidence.recordAssertionEvidence("No inference was sent during discovery", `completion calls=${world.completionCount()}`, world.completionCount() === 0);
    await user.screenshot();
  });
  await step("the owner runs the synthetic test and sees the payment blocker", async () => {
    await user.click({ role: "button", label: "Test model" });
    await user.see({ testId: "workbot-model-test-result" }, { text: "Payment required. Check the model account." });
    await user.notSee({ text: /fixture-private/ });
    evidence.recordAssertionEvidence("A real completion was refused for payment", `HTTP 402; completion calls=${world.completionCount()}`, world.completionCount() === 1);
    await user.screenshot();
  });
  await step("after: refreshing availability leaves payment required rather than Answered", async () => {
    await user.click({ role: "button", label: "Check availability" });
    await user.see({ testId: "workbot-default-readiness" }, { text: "Available" });
    await user.see({ testId: "workbot-model-test-result" }, { text: "Payment required. Check the model account." });
    await user.notSee({ text: "Answered" });
    evidence.recordAssertionEvidence("A model listing never conceals the payment failure", `completion calls=${world.completionCount()}; result remains payment required`, world.completionCount() === 1);
    await user.screenshot();
  });
});

unavailableProvider("an owner sees a listed model fail to answer within bounded attempts", async ({ world, user, step, evidence }) => {
  await step("before: listed Luna has not been tested with a completion", async () => {
    await user.see({ testId: "workbot-default-readiness" }, { text: "Available" });
    await user.see({ testId: "workbot-model-test-result" }, { text: "Not tested (short paid request)" });
    evidence.recordAssertionEvidence("Discovery alone spends no completion request", `completion calls=${world.completionCount()}`, world.completionCount() === 0);
    await user.screenshot();
  });
  await step("the owner's synthetic request fails without exposing provider details", async () => {
    await user.click({ role: "button", label: "Test model" });
    await user.see({ testId: "workbot-model-test-result" }, { text: "Model didn't answer. Try again later." });
    await user.notSee({ text: /fixture-private|fixture-model-key/ });
    expect(world.completionCount()).toBe(3);
    evidence.recordAssertionEvidence("The real adapter exhausts only its bounded attempts", `HTTP 503; completion calls=${world.completionCount()} of at most 3`, world.completionCount() === 3);
    await user.screenshot();
  });
  await step("after: catalog availability still cannot claim an answer", async () => {
    await user.click({ role: "button", label: "Check availability" });
    await user.see({ testId: "workbot-default-readiness" }, { text: "Available" });
    await user.see({ testId: "workbot-model-test-result" }, { text: "Model didn't answer. Try again later." });
    await user.notSee({ text: "Answered" });
    evidence.recordAssertionEvidence("Catalog refresh does not retry paid completion or invent success", `completion calls remain ${world.completionCount()}; no Answered state`, world.completionCount() === 3);
    await user.screenshot();
  });
});
