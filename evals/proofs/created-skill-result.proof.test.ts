import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { BLOCKED_PROMPT, BLOCKED_REPLY, CREATE_PROMPT, CREATE_REPLY, SKILL_NAME, createdSkillResultWorld } from "../worlds/created-skill-result.ts";

const test = spec.world(createdSkillResultWorld, {
  resources: { surfaces: ["appWeb"], services: ["den", "mock"] }, timeout: 600_000,
});

const CARD = "[data-created-skill]";

test("a member sees the skill their agent created as one quiet result they can open, with sharing reported only as confirmed", async ({ world, user, probe, step, evidence }) => {
  const cards = async () => (await probe.dom(CARD)).elements;

  await step("while the share is still running, the created skill is already there and says sharing is in progress", async () => {
    await user.see("composer", { editable: true });
    await user.type("composer", CREATE_PROMPT);
    await probe.eventually(() => probe.dom('button[aria-label="Run task"]:not(:disabled)'), {
      within: 30_000, label: "the conversation is ready to run the task", until: (value) => value.elements.length === 1,
    });
    await user.click("Run task");
    await user.see({ text: "Sharing with Sam…" }, { timeoutMs: 120_000 });
    const shimmering = (await probe.dom("[data-capability-call] .ow-text-shimmer")).elements.map((element) => element.text);
    const found = await cards();
    const ok = found.length === 1 && found[0]?.text.includes(SKILL_NAME) === true && shimmering.length === 1 && shimmering[0]?.startsWith("Sharing Update CRM") === true;
    evidence.recordAssertionEvidence("One card, and only the running step shimmers", `cards: ${found.map((card) => `"${card.text}"`).join(", ")}; shimmering: ${JSON.stringify(shimmering)}`, ok);
    expect(ok).toBe(true);
    await user.screenshot();
  });

  await step("after: the finished turn folds to one quiet line and the same skill stays as its result", async () => {
    await user.see({ text: CREATE_REPLY }, { timeoutMs: 60_000 });
    await user.see({ text: "Shared with Sam Taylor" }, { timeoutMs: 30_000 });
    // The reply streams before the run ends; the steps fold only once it has.
    await user.see("Run task", { timeoutMs: 60_000 });
    await probe.eventually(() => probe.dom('button[data-testid="completed-work-rail"]'), {
      within: 30_000, label: "the finished run folds", until: (value) => value.elements.length === 1,
    });
    await user.notSee({ text: "Created the Update CRM skill" }, { timeoutMs: 5_000 });
    const rail = (await probe.dom('button[data-testid="completed-work-rail"]')).elements.map((element) => element.text);
    const found = await cards();
    const ok = rail.some((text) => /^Worked for \d+s3 steps$/.test(text)) && found.length === 1;
    evidence.recordAssertionEvidence("The run folds to its duration and step count; one card remains", `rail: ${JSON.stringify(rail)}; cards: ${found.length}`, ok);
    expect(ok).toBe(true);
    await user.screenshot();
  });

  await step("opening the steps shows each one as a sentence with the OpenWork mark, and no tool names or ids", async () => {
    await user.click({ testId: "completed-work-rail" });
    await user.see({ text: "Created the Update CRM skill" });
    await user.see({ text: "Shared Update CRM with Sam" });
    const marks = (await probe.dom('[data-connector-icon="openwork"]')).elements.length;
    const text = await probe.text();
    const leaked = ["execute_capability", "postPluginsAccess", "create_skill", world.pluginId, world.skillId].filter((value) => text.includes(value));
    evidence.recordAssertionEvidence("Steps read as sentences; internals stay behind the details icon", `OpenWork marks: ${marks}; leaked internals: ${JSON.stringify(leaked)}`, marks >= 2 && leaked.length === 0);
    expect(leaked).toEqual([]);
    expect(marks).toBeGreaterThanOrEqual(2);
    await user.screenshot();
  });

  await step("a share the organization blocks is neutral, says who can change it, and the same card keeps its confirmed access", async () => {
    await user.type("composer", BLOCKED_PROMPT);
    await user.click("Run task");
    await user.see({ text: "Sharing is blocked by your organization" }, { timeoutMs: 120_000 });
    await user.see({ text: "An organization admin can change who may share skills." });
    const blocked = (await probe.dom('[data-skill-share="blocked"] .text-destructive')).elements.length;
    const found = await cards();
    const ok = blocked === 0 && found.length === 1 && found[0]?.text.includes("Shared with Sam Taylor") === true && !found[0]?.text.includes("everyone");
    evidence.recordAssertionEvidence("Blocked is not red; saving the same skill again updates its one card instead of adding another", `red text in the blocked row: ${blocked}; cards: ${found.map((card) => `"${card.text}"`).join(", ")}`, ok);
    expect(ok).toBe(true);
    // A turn with a step that did not happen stays open, so the block stays beside its reason (T2).
    await user.see({ text: BLOCKED_REPLY }, { timeoutMs: 60_000 });
    await user.see("Run task", { timeoutMs: 30_000 });
    await user.see({ text: "Sharing is blocked by your organization" });
    const folds = (await probe.dom('button[data-testid="completed-work-rail"]')).elements.length;
    evidence.recordAssertionEvidence("Only the clean turn folded; the blocked turn stays open", `folded turns: ${folds}`, folds === 1);
    expect(folds).toBe(1);
    await user.screenshot();
  });

  await step("after: Open takes the member to that skill in Library, only when they click it", async () => {
    const before = await probe.hash();
    expect(before).not.toContain("/extensions");
    await user.click({ label: `Open ${SKILL_NAME} in Library` });
    const path = await probe.eventually(() => probe.hash(), {
      within: 15_000, label: "the Library detail opens", until: (value) => value.includes("/extensions/"),
    });
    const expected = encodeURIComponent(`plugin:${world.pluginId}/file/${world.skillId}`);
    await user.see({ text: SKILL_NAME }, { timeoutMs: 30_000 });
    evidence.recordAssertionEvidence("Open lands on the Library detail for that plugin's skill", `before: ${before}; after: ${path}`, path.includes(expected));
    expect(path).toContain(expected);
    await user.screenshot();
  });
});
