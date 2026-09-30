import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { plusMenuWeb } from "../worlds/composer-plus-menu.ts";

const test = spec.world(plusMenuWeb, {
  timeout: 420_000,
  resources: { surfaces: ["appWeb"], services: ["mock"] },
});

const plusButton = { role: "button", label: "Add files, skills, connectors, and more" } as const;
const menuSearch = { placeholder: "Search files, skills, connectors" } as const;

test("a member: I want to search skills from the composer so I can use one without leaving the chat", async ({ world, user, probe, step, evidence }) => {
  const [briefing, deals, standup] = world.skills;
  const menuClosed = () => probe.eventually(() => probe.dom("[data-composer-plus-menu]"), {
    within: 5_000, intervalMs: 20, label: "the + menu closes", until: (dom) => dom.elements.length === 0,
  });

  await step("1. typing part of a name in the + menu lists the matching skill", async () => {
    await user.click(plusButton);
    await user.type(menuSearch, "brief");
    await user.see({ text: "Skills" });
    await user.see({ role: "option", label: new RegExp(`^${briefing.label}`) });
    await user.notSee({ role: "option", label: new RegExp(`^${standup.label}`) });
    await user.screenshot();
  });

  await step("2. choosing it puts a Customer briefing token in the message and closes the menu", async () => {
    await user.click({ role: "option", label: new RegExp(`^${briefing.label}`) });
    await menuClosed();
    await user.notSee(menuSearch);
    const tokens = await probe.dom(`[title="Skill: ${briefing.name}"]`);
    evidence.recordAssertionEvidence(
      "The composer shows the chosen skill as one token",
      `tokens: ${JSON.stringify(tokens.elements.map((element) => element.text))}`,
      tokens.elements.length === 1,
    );
    expect(tokens.elements.map((element) => element.text)).toEqual([briefing.label]);
    await user.screenshot();
  });

  await step("3. the member finishes the sentence and sends it", async () => {
    await user.type("composer", ` ${world.skillPrompt}`);
    await user.click("Run task");
    await user.see({ text: world.skillReply }, { timeoutMs: 90_000 });
    await user.screenshot();
  });

  await step("after: the AI used the Customer briefing skill and no other skill", async () => {
    await user.see({ text: world.skillReply });
    const sent = world.providerBodies().filter((body) => body.includes(world.skillPrompt)).join("\n");
    const seen = {
      [briefing.label]: sent.includes("BRIEFING_BODY_4412"),
      [deals.label]: sent.includes("DEAL_BODY_9031"),
      [standup.label]: sent.includes("STANDUP_BODY_2275"),
    };
    evidence.recordAssertionEvidence(
      "Only the chosen skill's instructions reached the model",
      `skill instructions seen by the model: ${JSON.stringify(seen)}`,
      seen[briefing.label] && !seen[deals.label] && !seen[standup.label],
    );
    expect(seen).toEqual({ [briefing.label]: true, [deals.label]: false, [standup.label]: false });
    await user.screenshot();
  });
});
