import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { plusMenuWeb } from "../worlds/composer-plus-menu.ts";

const test = spec.world(plusMenuWeb, {
  timeout: 420_000,
  resources: { surfaces: ["appWeb"], services: ["mock"] },
});

const rootSearch = { placeholder: "Search files, skills, connectors" } as const;
const skillsSearch = { placeholder: "Search skills" } as const;
const highlightedRow = "[data-plus-menu-item][data-highlighted]";

test("a member: I want to do it all from the keyboard", async ({ world, user, probe, step, evidence }) => {
  const [briefing] = world.skills;
  const menuClosed = () => probe.eventually(() => probe.dom("[data-composer-plus-menu]"), {
    within: 5_000, intervalMs: 20, label: "the + menu closes", until: (dom) => dom.elements.length === 0,
  });
  const highlightedText = async () => (await probe.dom(highlightedRow)).elements[0]?.text ?? "";

  await step("1. Tab from the message reaches + and Space opens the menu with the search focused", async () => {
    await user.click("composer");
    await probe.eventually(() => probe.dom('[data-lexical-editor="true"]'), {
      within: 5_000, label: "the message has focus", until: (dom) => dom.elements[0]?.focused === true,
    });
    await user.press("Tab");
    const trigger = await probe.eventually(() => probe.dom("[data-composer-plus-trigger]"), {
      within: 2_000, label: "Tab moves focus to +", until: (dom) => dom.elements[0]?.focused === true,
    });
    expect(trigger.elements[0]?.focused).toBe(true);
    await user.press("Space");
    await user.see(rootSearch);
    const search = await probe.dom('[data-composer-plus-menu] input');
    evidence.recordAssertionEvidence("Space on + opens the menu with typing going to search", `search focused: ${search.elements[0]?.focused === true}`, search.elements[0]?.focused === true);
    expect(search.elements[0]?.focused).toBe(true);
    await user.screenshot();
  });

  await step("2. the arrow keys move to Skills and Enter opens that section", async () => {
    await user.press("ArrowDown");
    const row = await probe.eventually(highlightedText, {
      within: 5_000, label: "Skills row highlighted", until: (text) => text.startsWith("Skills"),
    });
    expect(row.startsWith("Skills")).toBe(true);
    await user.press("Enter");
    await user.see(skillsSearch);
    await user.see({ role: "option", label: new RegExp(`^${briefing.label}`) });
    await user.screenshot();
  });

  await step("3. Backspace on an empty search and Esc both back out of the section, not the menu", async () => {
    await user.press("Backspace");
    await user.see(rootSearch);
    const returned = await probe.eventually(highlightedText, {
      within: 5_000, label: "backing out keeps Skills highlighted", until: (text) => text.startsWith("Skills"),
    });
    evidence.recordAssertionEvidence("Backing out returns to the row you came from", `highlighted row "${returned}"`, returned.startsWith("Skills"));
    await user.press("Enter");
    await user.see(skillsSearch);
    await user.press("Escape");
    await user.see(rootSearch);
    await user.notSee(skillsSearch);
    await user.screenshot();
  });

  await step("4. typing and Enter pick the first match and return to the message", async () => {
    await user.type(rootSearch, "cust");
    await probe.eventually(highlightedText, {
      within: 5_000, label: "Customer briefing highlighted", until: (text) => text.startsWith(briefing.label),
    });
    await user.press("Enter");
    await menuClosed();
    await user.notSee(rootSearch);
    const tokens = await probe.dom(`[title="Skill: ${briefing.name}"]`);
    expect(tokens.elements.map((element) => element.text)).toEqual([briefing.label]);
    await user.screenshot();
  });

  await step("after: Esc at the top closes the menu, adds nothing, and typing lands in the message", async () => {
    await user.press("Tab");
    await user.press("Space");
    await user.see(rootSearch);
    await user.press("Escape");
    await menuClosed();
    await user.notSee(rootSearch);
    await user.type("composer", "ready", { replace: false });
    await user.see("composer", { text: /ready/ });
    const tokens = await probe.dom(`[title="Skill: ${briefing.name}"]`);
    evidence.recordAssertionEvidence(
      "Closing with Esc changes nothing in the message",
      `skill tokens after Esc: ${tokens.elements.length}; the message still takes typing`,
      tokens.elements.length === 1,
    );
    expect(tokens.elements).toHaveLength(1);
    await user.screenshot();
  });
});
