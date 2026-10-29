import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { DESIGN_PROMPT, EVERYONE_PROMPT, REVISED_DESIGN_PROMPT, orgPromptsDesktop } from "../worlds/org-prompts.ts";

const test = spec.world(orgPromptsDesktop, {
  timeout: 900_000,
  resources: { surfaces: ["appWeb"], services: ["den", "mock"] },
});

test("a member's agent follows the organization's prompts for everyone and their team, and stops applying prompts after an admin removes them", async ({ world, user, probe, step, evidence }) => {
  await step("given Riley's OpenWork has synced with Den after sign-in", async () => {
    await user.see("composer", { editable: true, timeoutMs: 120_000 });
    const status = await probe.eventually(() => world.sync(), {
      within: 120_000, label: "Riley's OpenWork has Riley's Den session", until: (value) => value === "applied" || value === "noop",
    });
    expect(["applied", "noop"]).toContain(status);
    await user.screenshot();
  });

  await step("when Riley asks the agent for something, the model receives OpenWork's instructions with everyone's prompt and Design's", async () => {
    const seen: Record<string, boolean> = {};
    for (const [label, text] of [["heading", "## Organization instructions"], ["everyone", EVERYONE_PROMPT], ["design", DESIGN_PROMPT]] as const) {
      await world.watchFor(text);
      seen[label] = await world.turnSawWatched(`Draft the launch poster (${label}). PROMPTS-${Date.now()}`);
    }
    evidence.recordAssertionEvidence("the model requests carried the organization's prompts", JSON.stringify(seen), Object.values(seen).every(Boolean));
    expect(seen).toEqual({ heading: true, everyone: true, design: true });
  });

  await step("after an admin revises Design's prompt, the next sync brings the new text to the agent", async () => {
    await world.reviseDesignPrompt();
    expect(await world.sync()).toBe("applied");
    await world.watchFor(REVISED_DESIGN_PROMPT);
    const seen = await world.turnSawWatched(`Export the poster. PROMPTS-${Date.now()}`);
    evidence.recordAssertionEvidence("the model request carried the revised prompt", `seen=${seen}`, seen);
    expect(seen).toBe(true);
  });

  await step("after an admin removes the saved prompts, the next sync removes them from the agent's instructions", async () => {
    await world.removePrompts();
    expect(await world.sync()).toBe("applied");
    await world.watchFor("## Organization instructions");
    const seen = await world.turnSawWatched(`Share the poster. PROMPTS-${Date.now()}`);
    evidence.recordAssertionEvidence("the model request no longer carried organization prompts", `seen=${seen}`, !seen);
    expect(seen).toBe(false);
  });
});
