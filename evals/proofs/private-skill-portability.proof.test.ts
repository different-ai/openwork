import { spec } from "@openwork/testkit";
import { privateSkillPortabilityWorld } from "../worlds/private-skill-portability.ts";

const test = spec.world(privateSkillPortabilityWorld, {
  timeout: 300_000,
  resources: { surfaces: ["web"], services: ["den"] },
});

test("an owner finds the private skill transfer without sharing their skills", async ({ world, user, step }) => {
  const person = user.on(world.owner);
  await step("before: with private transfers off, the organization export offers no private transfer", async () => {
    await person.see({ role: "tab", label: "Export" }, { timeoutMs: 90_000 });
    await person.click({ role: "tab", label: "Export" });
    await person.see({ text: "This is not a full backup." });
    await person.notSee({ text: "Move my private skills" });
    await person.screenshot();
  });
  await step("after: the export links to private transfer when it is enabled", async () => {
    await world.enablePortability();
    await person.reload();
    await person.see({ text: "Private skills and plugins are not included." });
    await person.see({ text: "Move my private skills" });
    await person.screenshot();
  });
  await step("the owner opens the separate private skill transfer", async () => {
    await person.click({ text: "Move my private skills" });
    await person.see({ testId: "private-skills-screen" });
    await person.see({ role: "button", label: "Download private skills" });
    await person.see({ text: "Existing skills aren't replaced or shared." });
    await person.screenshot();
  });
});
