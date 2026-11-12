import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { remoteSessionModel } from "../worlds/remote-session-model.ts";

const test = spec.world(remoteSessionModel, {
  timeout: 300_000,
  resources: { surfaces: ["appWeb"], services: ["den", "mock"] },
  needs: { commands: ["bun"] },
});

test("a member opens a remotely launched conversation with its own model and keeps a later local choice", async ({ world, user, probe, step, evidence }) => {
  const selectedModel = () => probe.dom('button[aria-label="Change model"]');
  await step("given: the remotely launched conversation has its own model and no remembered local choice", async () => {
    await user.click({ text: world.title });
    await user.see("composer", { editable: true });
    expect(world.localAtLaunch.remembered).toBe(false);
    expect(world.localAtLaunch.defaultModel).toBe(`${world.alternate.providerID}/${world.alternate.modelID}`);
    evidence.recordAssertionEvidence("The native launch model differs from the app default, with no local session override",
      JSON.stringify({ native: world.nativeAtLaunch, local: world.localAtLaunch }), !world.localAtLaunch.remembered
        && world.localAtLaunch.defaultModel === `${world.alternate.providerID}/${world.alternate.modelID}`);
    await user.screenshot();
  });

  await step("after: opening the remote conversation selects its launch model instead of the workspace default", async () => {
    await user.see({ role: "button", label: "Change model" }, { text: /^Remote reasoning · High$/ });
    const selected = (await selectedModel()).elements.map(element => element.text).join(" ");
    expect(selected).toContain(world.launched.name);
    expect(selected).not.toContain(world.alternate.name);
    evidence.recordAssertionEvidence("The composer shows the remote launch model without a picker action", selected,
      selected.includes(world.launched.name) && !selected.includes(world.alternate.name));
    await user.screenshot();
  });

  await step("the member's follow-up reaches the launch model with its launch reasoning effort", async () => {
    await user.type("composer", world.prompt, { verify: true });
    await user.press("Enter");
    await user.see({ text: world.reply }, { timeoutMs: 60_000 });
    const requests = await probe.eventually(() => world.requests(), {
      within: 30_000, label: "the actual synthetic provider receives the follow-up",
      until: entries => entries.some(entry => entry.kind === "final"),
    });
    const final = requests.filter(entry => entry.kind === "final");
    const correct = final.length > 0 && final.every(entry => entry.model === world.launched.modelID && entry.reasoningEffort === world.launched.variant);
    evidence.recordAssertionEvidence("Actual inference payloads use the remote model and high reasoning, never the default",
      JSON.stringify(requests.map(({ model, reasoningEffort, kind }) => ({ model, reasoningEffort, kind }))), correct);
    expect(correct).toBe(true);
    await user.screenshot();
  });

  await step("a later picker choice survives reopening even though the native launch model is different", async () => {
    await user.click({ role: "button", label: "Change model" });
    await user.click({ testId: `model-option-${world.alternate.providerID}-${world.alternate.modelID}` });
    await user.see({ role: "button", label: "Change model" }, { text: world.alternate.name });
    // Picker changes are local until another send. This read is the witness that
    // reloading really tests precedence over a different engine snapshot.
    const native = await world.nativeSession();
    expect(native).toMatchObject({ model: { providerID: world.launched.providerID, id: world.launched.modelID } });
    await user.reload();
    await user.see("composer", { editable: true });
    await user.see({ role: "button", label: "Change model" }, { text: world.alternate.name });
    const selected = (await selectedModel()).elements.map(element => element.text).join(" ");
    evidence.recordAssertionEvidence("The remembered picker choice wins over the older native launch model after reload",
      JSON.stringify({ selected, native }), selected.includes(world.alternate.name) && !selected.includes(world.launched.name));
    expect(selected).not.toContain(world.launched.name);
    await user.screenshot();
  });
});
