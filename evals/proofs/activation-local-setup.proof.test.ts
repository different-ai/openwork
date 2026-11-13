import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { activationLocalSetup } from "../worlds/activation-local-setup.ts";

const test = spec.world(activationLocalSetup, {
  timeout: 420_000,
  resources: { surfaces: ["appWeb"], services: ["den", "mock"] },
  needs: { commands: ["bun"] },
});

const card = { testId: "activation-card" };
const popover = { testId: "activation-popover" };
const ANSWER_MS = 90_000;

test("a person working alone finishes Get set up from the provider and connection that already work on their device", async ({ world, user, probe, step, evidence }) => {
  const rowState = async (id: string, state: string) => (await probe.dom(`[data-testid="activation-step-${id}"][data-state="${state}"]`)).elements.length === 1;

  await step("before: with a working provider and connection on the device, the checklist counts only the first answer", async () => {
    await user.see("composer", { editable: true });
    await user.type("composer", world.first.prompt);
    await user.press("Enter");
    await user.see({ text: world.first.reply }, { timeoutMs: ANSWER_MS });
    await user.see({ role: "button", label: "Get set up, 1 of 6" }, { timeoutMs: 30_000 });
    await user.see({ text: "Next: Invite a teammate" });
    await user.click(card);
    await user.see(popover);
    const den = await world.activation();
    expect(den.done).toEqual(["first_response"]);
    evidence.recordAssertionEvidence("Off: the provider that just answered and the connected server are not counted", `Den done steps: ${den.done.join(", ")}; card "Get set up, 1 of 6", "Next: Invite a teammate"`, den.done.join() === "first_response");
    await user.screenshot();
    await user.press("Escape");
  });

  await step("after: once the feature is on, the next answer checks off the provider and the connection, and inviting is optional", async () => {
    await world.setLocalSetup(true);
    await user.reload();
    await user.see("composer", { editable: true, timeoutMs: 60_000 });
    await user.type("composer", world.second.prompt);
    await user.press("Enter");
    await user.see({ text: world.second.reply }, { timeoutMs: ANSWER_MS });
    await user.see({ role: "button", label: "Get set up, 3 of 5" }, { timeoutMs: 60_000 });
    await user.see({ text: "Next: Use a skill" });
    await user.click(card);
    await user.see(popover);
    await user.see({ text: "Your key, on this device" });
    await user.see({ text: "Connected on this device" });
    await user.see({ text: "Optional while you work alone" });
    await user.see({ role: "button", label: "Invite" });
    expect(await rowState("own_provider", "done")).toBe(true);
    expect(await rowState("connector", "done")).toBe(true);
    expect(await rowState("invite_teammate", "open")).toBe(true);
    const den = await world.activation();
    expect(den.done).toEqual(["first_response", "own_provider", "connector"]);
    evidence.recordAssertionEvidence("On: three of five, and inviting waits in the list without being next", `Den done steps: ${den.done.join(", ")}; card "Get set up, 3 of 5", "Next: Use a skill"; teammate row "Optional while you work alone" with its Invite action`, den.done.length === 3);
    await user.screenshot();
    await user.press("Escape");
  });

  await step("turning the feature off again puts inviting back in the count; what was checked off stays", async () => {
    await world.setLocalSetup(false);
    await user.reload();
    await user.see({ role: "button", label: "Get set up, 2 of 6" }, { timeoutMs: 60_000 });
    await user.see({ text: "Next: Invite a teammate" });
    const den = await world.activation();
    expect(den.done).toEqual(["first_response", "own_provider"]);
    evidence.recordAssertionEvidence("Off again: the device connection is no longer counted and inviting is step two", `Den done steps: ${den.done.join(", ")}; card "Get set up, 2 of 6"`, den.done.join() === "first_response,own_provider");
    await user.screenshot();
  });
});
