import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { coworkerTemplateEditor, isRecord, records } from "../worlds/library.ts";

const test = spec.world(coworkerTemplateEditor, { timeout: 420_000 });
const name = { placeholder: "Campaign partner" };
const role = { placeholder: "Marketing strategist" };
const mission = { placeholder: "What should this coworker help a new teammate accomplish?" };
const instructions = { placeholder: "Ways of working, brand guidance, and questions to ask before starting. Include only information intended for everyone assigned this coworker." };

test("an administrator prepares, revises, and withdraws a coworker through Connect", async ({ world, user, probe, step, evidence }) => {
  const teammate = world.den.members.teammate;
  if (!teammate) throw new Error("The team member is missing.");
  async function delivered() {
    const result = await probe.api(teammate, "/v1/me/coworkers");
    expect(result.response.status).toBe(200);
    return isRecord(result.body) ? records(result.body.items) : [];
  }
  expect(await delivered()).toEqual([]);
  await step("create the coworker using its profile form", async () => {
    await user.see("Add coworker", { timeoutMs: 90_000 });
    await user.click("Add coworker");
    await user.see({ text: "Add a coworker" });
    await user.type(name, "Campaign partner");
    await user.type(role, "Marketing strategist");
    await user.type({ placeholder: "Helps plan campaigns and turn a brief into next steps." }, "Plans campaigns from an approved brief.");
    await user.type(mission, "Turn an approved campaign brief into a useful plan.");
    await user.type(instructions, "Ask about the audience before drafting.");
    await user.see({ text: /Existing working copies are never overwritten\./ });
    await user.screenshot();
    await user.click("Save coworker");
    await user.see("Edit template", { timeoutMs: 60_000 });
  });
  const initial = await delivered();
  expect(initial).toHaveLength(1);
  const first = initial[0];
  expect(first?.assigned).toBe(true);
  expect(first?.template).toMatchObject({ name: "Campaign partner", avatarColor: "blue", avatarGlasses: "round", provisioning: "automatic", instructions: "Ask about the audience before drafting." });
  evidence.recordAssertionEvidence("A coworker created in the Connect editor reaches the assigned team with its starting profile", JSON.stringify(first), true);

  await step("reload and revise the existing coworker", async () => {
    await user.click("Edit template");
    await user.see(name, { value: "Campaign partner" });
    await user.reload();
    await user.see(role, { value: "Marketing strategist", timeoutMs: 60_000 });
    await user.see(instructions, { value: "Ask about the audience before drafting." });
    await user.type(name, "Campaign planner", { replace: true });
    await user.type(instructions, "Use the approved brief and ask before publishing.", { replace: true });
    await user.click({ role: "checkbox" });
    await user.click("Save coworker");
    await user.see("Edit template", { timeoutMs: 60_000 });
    await user.see({ text: "Campaign planner" });
  });
  const revised = await delivered();
  expect(revised).toHaveLength(1);
  expect(revised[0]?.id).toBe(first?.id);
  expect(revised[0]?.versionId).not.toBe(first?.versionId);
  expect(revised[0]?.template).toMatchObject({ name: "Campaign planner", provisioning: "optional", instructions: "Use the approved brief and ask before publishing.", avatarColor: "blue", avatarGlasses: "round" });
  evidence.recordAssertionEvidence("Editing saves a new version of the same coworker and can make installation optional", JSON.stringify({ originalId: first?.id, revised: revised[0] }), true);

  await step("cancel withdrawal before confirming it", async () => {
    await user.click("Edit template");
    await user.see(name, { value: "Campaign planner" });
    await user.click("Archive template");
    await user.see("Confirm archive");
    await user.click("Cancel");
    expect(await delivered()).toHaveLength(1);
    await user.click("Archive template");
    await user.screenshot();
    await user.click("Confirm archive");
    await user.see("Add coworker", { timeoutMs: 60_000 });
    await user.notSee("Edit template");
  });
  expect(await delivered()).toEqual([]);
  evidence.recordAssertionEvidence("Cancel keeps a coworker available; confirming archive stops future delivery", "The editor retained delivery after Cancel, then returned to the empty plugin coworker list after Confirm archive. The assigned member's discovery returned no templates.", true);
});
