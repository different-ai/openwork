import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { connectEffectiveModel } from "../worlds/connect-effective-model.ts";

const test = spec.world(connectEffectiveModel, {
  timeout: 300_000,
  resources: { surfaces: ["appWeb"], services: ["den", "mock"] },
  needs: { commands: ["bun"] },
});

// Real browser network observation proves the public request context, not an
// invented Ready result. Overall delivery and native tool projection are not
// claimed by this proof, because they depend on a connected Cloud MCP endpoint.
test("a signed-in member's Connect health request uses the conversation model instead of a retired global preference", async ({ world, user, probe, step, evidence }) => {
  await step("given: the conversation remembers a usable model despite a retired global preference", async () => {
    await user.click({ text: "Workspace planning" });
    await probe.eventually(() => probe.hash(), {
      within: 15_000, label: "the arranged conversation is open",
      until: route => route.includes(world.session.sessionId),
    });
    await user.see("composer", { editable: true });
    await user.click("Change model");
    await user.see({ testId: "composer-model-picker" });
    await user.click({ testId: `model-option-${world.providerID}-${world.modelID}` });
    const selected = await probe.eventually(async () =>
      (await probe.dom('button[aria-label="Change model"]')).elements.map(element => element.text).join(" "), {
      within: 30_000, label: "the conversation's selected model", until: value => value.includes(world.modelName),
    });
    expect(world.retiredPreferenceSaved).toBe(true);
    evidence.recordAssertionEvidence("The member opens the arranged conversation and chooses its available engine model", `${selected}; arranged legacy preference=${JSON.stringify(world.stale)}; session=${world.session.sessionId}`, selected.includes(world.modelName) && world.retiredPreferenceSaved === true);
    await user.screenshot();
  });

  await step("after: reopening the conversation checks Connect with its model, not the retired provider", async () => {
    const before = world.healthRequests().length;
    await user.reload();
    await user.see("composer", { editable: true });
    const requests = await probe.eventually(() => world.healthRequests().slice(before), {
      within: 30_000, label: "a real Connect health response for the conversation model",
      until: entries => entries.some(entry => entry.status === 200),
    });
    const completed = requests.filter(entry => entry.status === 200);
    const retiredRequested = requests.some(entry => entry.provider === world.stale.providerID || entry.model === world.stale.modelID);
    evidence.recordAssertionEvidence("Real Connect health requests use the scoped model and never the retired preference", JSON.stringify(requests), completed.length > 0 && completed.every(entry => entry.provider === world.providerID && entry.model === world.modelID) && !retiredRequested);
    expect(completed.length).toBeGreaterThan(0);
    expect(completed.map(entry => ({ provider: entry.provider, model: entry.model })))
      .toEqual(completed.map(() => ({ provider: world.providerID, model: world.modelID })));
    expect(retiredRequested).toBe(false);
    await user.screenshot();
  });

  await step("the member can still open the workspace's diagnostics page through Settings", async () => {
    await user.click({ testId: "account-status-menu" });
    await user.click({ role: "menuitem", label: "Settings" });
    await user.click({ role: "button", label: "Advanced" });
    await user.see({ text: "Agent access diagnostics" });
    const route = await probe.hash();
    expect(route).toContain(`/workspace/${world.workspace.workspaceId}/settings/advanced`);
    evidence.recordAssertionEvidence("Settings opens diagnostics in the same workspace; no overall Ready claim is made", route, route.includes(`/workspace/${world.workspace.workspaceId}/settings/advanced`));
    await user.screenshot();
  });
});
