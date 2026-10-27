import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { DESIGN_PROMPT, EVERYONE_PROMPT, orgPromptsTeamTab } from "../worlds/org-prompts.ts";

const test = spec.world(orgPromptsTeamTab, { timeout: 600_000, resources: { surfaces: ["web"], services: ["den"] } });

test("an admin adds a team's prompt under the prompt for everyone, and the team's members receive both in order", async ({ world, user, step, evidence }) => {
  await step("given the Design team's Prompts tab shows the prompt for everyone first, then Design's empty prompt", async () => {
    await user.see({ testId: "prompts-panel" }, { timeoutMs: 60_000 });
    await user.see({ testId: "prompt-everyone" }, { text: EVERYONE_PROMPT });
    await user.see({ testId: "prompt-everyone-edit" });
    await user.see({ testId: "prompt-empty" }, { text: /^No prompt for Design yet/ });
    await user.notSee({ testId: "prompt-content" });
    await user.screenshot();
  });

  await step("when the admin adds Design's prompt and saves it", async () => {
    await user.click({ testId: "prompt-edit" });
    await user.see({ testId: "prompt-content" }, { editable: true });
    await user.type({ testId: "prompt-content" }, DESIGN_PROMPT);
    await user.see({ testId: "prompt-save" });
    await user.screenshot();
    await user.click({ testId: "prompt-save" });
  });

  await step("then the tab is read-only again with the saved prompt and when it was updated", async () => {
    await user.see({ testId: "prompt-edit" }, { timeoutMs: 30_000 });
    await user.see({ testId: "prompt-content" }, { text: DESIGN_PROMPT, editable: false });
    await user.see({ text: "Updated today" });
    await user.notSee({ testId: "prompt-save" });
    await user.screenshot();
  });

  await step("and Riley, in Design, receives the prompt for everyone first, then Design's", async () => {
    const prompts = await world.rileyPrompts();
    const expected = [
      { source: "organization", teamName: null, content: EVERYONE_PROMPT },
      { source: "team", teamName: "Design", content: DESIGN_PROMPT },
    ];
    evidence.recordAssertionEvidence("Riley's desktop receives the prompts in order", JSON.stringify(prompts), JSON.stringify(prompts) === JSON.stringify(expected));
    expect(prompts).toEqual(expected);
  });

  await step("and the Everyone page's Prompts tab shows the prompt for everyone without a second field", async () => {
    await user.navigate(world.everyoneUrl);
    await user.see({ testId: "prompt-content" }, { text: EVERYONE_PROMPT, timeoutMs: 60_000 });
    await user.notSee({ testId: "prompt-everyone" });
    await user.screenshot();
  });
});
