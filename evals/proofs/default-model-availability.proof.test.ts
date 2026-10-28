import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { defaultModelAvailability } from "../worlds/default-model-availability.ts";

const test = spec.world(defaultModelAvailability, { timeout: 300_000, resources: { surfaces: ["web"], services: ["den"] } });

test("an administrator keeps a saved default while availability is unknown and sees only the scope actually saved", async ({ world, user, probe, step, evidence }) => {
  const row = async () => (await probe.dom('[data-section="org-default-model"]')).elements.map(element => element.text).join(" ");
  await step("before: a failed model source leaves the saved default unverified rather than removed", async () => {
    await user.reload();
    await user.see({ testId: "org-default-model-section" });
    await user.see({ text: "Some of your organization's models couldn't be loaded. The rest are listed." });
    await user.click({ role: "combobox", label: "Default model" });
    await user.see({ text: "Availability not verified" });
    await user.notSee({ text: "No longer available" });
    expect(world.reads()).toContain("partial");
    evidence.recordAssertionEvidence("A partial inventory cannot establish model removal", `options source=provider unavailable; picker=${await probe.text()}`, !(await probe.has("No longer available")));
    await user.screenshot();
    await user.press("Escape");
  });
  await step("after: retrying the source restores the saved model's real name", async () => {
    world.scenario("ready");
    await user.click({ role: "button", label: "Try again" });
    await user.see({ role: "combobox", label: "Default model" }, { value: "Model one", timeoutMs: 30_000 });
    expect(world.reads()).toContain("ready");
    evidence.recordAssertionEvidence("Successful revalidation resolves the unchanged saved choice", "Visible default-model input verified as Model one; real options response observed", world.reads().includes("ready"));
    await user.screenshot();
  });
  await step("a failed options response still does not claim the saved model was removed", async () => {
    world.scenario("failed");
    await user.reload();
    await user.see({ text: "The model list returned an unexpected response." });
    await user.notSee({ text: "No longer available" });
    await user.notSee({ text: "Its members start on the organization default" });
    expect(world.reads()).toContain("failed");
    evidence.recordAssertionEvidence("Failure keeps the saved choice without inventing availability or fallback", `failed read witnessed; current row=${await row()}; retry action visible`, !(await probe.has("No longer available")));
    await user.screenshot();
  });
  await step("a complete inventory reports an unlisted choice without promising an organization fallback", async () => {
    world.scenario("removed");
    await user.reload();
    await user.see({ text: "This saved model is not in the current list. Members who can't use the resolved default keep their desktop default. Choose another model." });
    await user.notSee({ text: "Its members start on the organization default" });
    expect(world.reads()).toContain("removed");
    await user.see({ role: "combobox", label: "Default model" }, { value: "Saved model" });
    evidence.recordAssertionEvidence("Complete absence is distinguished from an unverifiable source", "All sources answered; saved choice remains visible as Saved model, without a fabricated name or fallback", world.reads().includes("removed"));
    await user.screenshot();
  });
  await step("saving a different organization default acknowledges only that setting, not every desktop chat", async () => {
    world.scenario("ready");
    await user.reload();
    await user.click({ role: "combobox", label: "Default model" });
    await user.click({ role: "option", label: /Model two/ });
    await user.see({ text: "Saved organization default: Model two (Organization models)." });
    await user.notSee({ text: "New desktop chats start on" });
    evidence.recordAssertionEvidence("Save copy names the organization scope without overriding personal workspace choices or v1 behavior", `saved status=${(await probe.dom('[role="status"]')).elements.map(element => element.text).join(" ")}`, await probe.has("Saved organization default: Model two"));
    await user.screenshot();
  });
});
