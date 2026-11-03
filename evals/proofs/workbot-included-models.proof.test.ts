import { spec } from "@openwork/testkit";
import { expect } from "vitest";
import { workbotUsageRecovery } from "../worlds/workbot-usage-recovery.ts";

// Standalone Workbot uses direct Chrome, not seed.web (the Den dashboard).
const test = spec.world(workbotUsageRecovery, { timeout: 90_000, needs: { placement: "local" }, resources: { surfaces: [], services: ["mock"] } });

test("Workbot explains a missing model and a used-up included allowance with a next step for each role", async ({ world, user, probe, step, evidence }) => {
  await user.resizeViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
  await step("managed models unavailable and no provider: a member learns what is missing and who can fix it", async () => {
    await user.navigate(`${world.url}?issue=provider&persona=member`);
    await user.type({ role: "textbox", label: "Message Workbot" }, "Summarize my week");
    await user.click({ role: "button", label: "Send" });
    await user.see({ text: /Workbot doesn’t have a model it can use in this workspace yet/ });
    await user.notSee({ text: /no available model provider/ });
    await user.notSee({ text: /fixture-secret-must-not-reach-browser/ });
    await user.see({ role: "button", label: "Check access and retry" });
    const links = await probe.dom('[data-testid="workbot-access-recovery"] a');
    evidence.recordAssertionEvidence("A member gets the reason and a retry, never admin links", `Admin links=${links.elements.length}; provider calls=${world.providerCalls()}`, links.elements.length === 0 && world.providerCalls() === 0);
    expect(links.elements.length).toBe(0);
    expect(world.providerCalls()).toBe(0);
    await user.screenshot();
  });
  await step("the same refusal gives a models admin both ways to give Workbot a model", async () => {
    await user.navigate(`${world.url}?issue=provider`);
    await user.type({ role: "textbox", label: "Message Workbot" }, "Summarize my week");
    await user.click({ role: "button", label: "Send" });
    await user.see({ text: /A workspace admin can turn on OpenWork Models or add a model provider/ });
    await user.see({ role: "link", label: /^Set up OpenWork Models/ });
    await user.see({ role: "link", label: /^Add a model provider/ });
    const models = await probe.dom('a[href="https://den.example.test/dashboard/ai-gateway?tab=openwork-models&workbotOrganizationId=org_recovery"][target="_blank"]');
    const providers = await probe.dom('a[href="https://den.example.test/dashboard/ai-gateway?tab=ai-providers&workbotOrganizationId=org_recovery"][target="_blank"]');
    evidence.recordAssertionEvidence("Both links open Den for this exact workspace in a new tab", `Models links=${models.elements.length}; provider links=${providers.elements.length}`, models.elements.length === 1 && providers.elements.length === 1);
    expect([models.elements.length, providers.elements.length]).toEqual([1, 1]);
    await user.screenshot();
  });
  await step("a models admin without purchase permission uses up the included allowance: the reset, a saved message and Den's Models page", async () => {
    await user.navigate(`${world.url}?persona=models-admin`);
    await user.see({ text: /You've used the free model allowance for now/ });
    await user.see({ text: /^Resets / });
    await user.see({ text: "Your message is saved" });
    await user.see({ role: "link", label: /^Review OpenWork Models/ });
    await user.see({ role: "link", label: /^Change model/ });
    await user.notSee({ role: "link", label: /^Get OpenWork Models/ });
    const witness = world.witness("free");
    evidence.recordAssertionEvidence("The limit is the model's own hard stop, shown once without an unauthorized purchase", `Model attempts=${witness.attempts}; retryable=${witness.retryable}`, witness.attempts === 1 && witness.retryable === false);
    expect(witness).toEqual({ attempts: 1, retryable: false });
    await user.screenshot();
  });
  await step("a member out of included use is told who can add more", async () => {
    await user.navigate(`${world.url}?persona=member`);
    await user.see({ text: /You've used the free model allowance for now/ });
    await user.see({ text: /^Ask an admin for OpenWork Models/ });
    const actions = await probe.dom('[data-testid="workbot-model-recovery"] a');
    evidence.recordAssertionEvidence("A member sees a locked next step, not management links", `Recovery links=${actions.elements.length}`, actions.elements.length === 0);
    expect(actions.elements.length).toBe(0);
    await user.screenshot();
  });
});
