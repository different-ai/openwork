import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { newChatModelRecovery } from "../worlds/model-removal-recovery.ts";

const test = spec.world(newChatModelRecovery, {
  timeout: 300_000, resources: { surfaces: ["appWeb"], services: ["den"] }, needs: { commands: ["bun"] },
});

test("a member recovers a new chat without saving a personal default over later organization choices", async ({ world, user, probe, step, evidence }) => {
  const selected = async () => (await probe.dom('button[aria-label="Change model"]')).elements.map(element => element.text).join(" ");
  await step("before: a new chat inherits the organization model without a personal choice", async () => {
    await user.reload();
    await user.click({ role: "button", label: /^New session$/ });
    await probe.eventually(selected, { within: 30_000, label: "the organization default", until: value => value.includes(world.old.name) });
    await user.see("composer", { editable: true });
    evidence.recordAssertionEvidence("The organization default is selected before the member chooses a model", `selected=${await selected()}`, (await selected()).includes(world.old.name));
    await user.screenshot();
  });
  await step("after: verified removal uses a temporary replacement without changing the saved default", async () => {
    world.scenario("removed");
    await user.reload();
    await user.see({ testId: "model-recovery-note" }, { timeoutMs: 45_000 });
    const note = (await probe.dom('[data-testid="model-recovery-note"]')).elements.map(element => element.text).join(" ");
    expect(note).toContain("for now");
    expect(note).toContain("Saved default unchanged");
    expect(await selected()).toContain(world.replacement.name);
    const reads = world.reads().filter(read => read.scenario === "removed");
    expect(reads.filter(read => read.kind === "legacy").length).toBeGreaterThanOrEqual(2);
    expect(reads.filter(read => read.kind === "gateway").length).toBeGreaterThanOrEqual(2);
    evidence.recordAssertionEvidence("Recovery identifies its temporary scope after independent removal verification", `${note}; complete legacy reads=${reads.filter(read => read.kind === "legacy").length}; gateway reads=${reads.filter(read => read.kind === "gateway").length}`, note.includes("Saved default unchanged"));
    await user.screenshot();
  });
  await step("a later organization default takes effect instead of being masked by the automatic replacement", async () => {
    const status = await world.setOrganizationDefault(world.nextDefault.id);
    await user.reload();
    await user.see("composer", { editable: true });
    await probe.eventually(selected, { within: 30_000, label: "the later organization default", until: value => value.includes(world.nextDefault.name) });
    await user.notSee({ testId: "model-recovery-note" });
    expect(await selected()).not.toContain(world.replacement.name);
    evidence.recordAssertionEvidence("The later organization choice wins without clearing a personal preference", `PUT default -> ${status}; selected=${await selected()}; no recovery note`, (await selected()).includes(world.nextDefault.name));
    await user.screenshot();
  });
  await step("an explicit personal choice still outranks a later organization change", async () => {
    await user.click("Change model");
    await user.click({ testId: `model-option-${world.providerID}-${world.replacement.id}` });
    await probe.eventually(selected, { within: 15_000, label: "the member's explicit choice", until: value => value.includes(world.replacement.name) });
    await world.setOrganizationDefault(world.otherDefault.id);
    await user.reload();
    await user.see("composer", { editable: true });
    await probe.eventually(selected, { within: 30_000, label: "the member's saved workspace choice", until: value => value.includes(world.replacement.name) });
    expect(await selected()).not.toContain(world.otherDefault.name);
    evidence.recordAssertionEvidence("Only the member's explicit picker choice becomes a workspace preference", `member picked ${world.replacement.name}; after organization refresh selected=${await selected()}`, (await selected()).includes(world.replacement.name));
    await user.screenshot();
  });
});
