import { spec } from "@openwork/testkit";
import { privateSkillPortabilityWorld } from "../worlds/private-skill-portability.ts";

const test = spec.world(privateSkillPortabilityWorld, {
  timeout: 300_000,
  resources: { surfaces: ["web"], services: ["den"] },
});

test("an owner finds the private skill transfer without sharing their skills", async ({ world, user, step, evidence }) => {
  const person = user.on(world.owner);
  await step("before: with private transfers off, the organization export offers no private transfer", async () => {
    await person.see({ testId: "config-export" });
    await person.see({ text: "This is not a full backup." });
    await person.notSee({ text: "Move my private skills" });
    await person.screenshot();
    evidence.recordAssertionEvidence("Organization export does not promise a backup", "The export explains its scope and offers no private transfer while the feature is off.", true);
  });
  await step("after: the export links to private transfer when it is enabled", async () => {
    await world.enablePortability();
    await person.reload();
    await person.see({ text: "Private skills and plugins are not included." });
    await person.see({ text: "Move my private skills" });
    await person.screenshot();
    evidence.recordAssertionEvidence("Private skills remain out of organization config", "The export explains the exclusion and links to the owner's own transfer.", true);
  });
  await step("the owner opens the separate private skill transfer", async () => {
    await person.click({ text: "Move my private skills" });
    await person.see({ testId: "private-skills-screen" });
    await person.see({ role: "button", label: "Download private skills" });
    await person.see({ text: "Existing skills aren't replaced or shared." });
    await person.screenshot();
    evidence.recordAssertionEvidence("Private transfer is separate from organization config", "The member can download their own skills or choose a file to create private copies.", true);
  });
});
