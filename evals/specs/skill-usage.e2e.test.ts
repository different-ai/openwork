import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { skillUsage } from "../worlds/skill-usage.ts";

const test = spec.world(skillUsage, {
  timeout: 600_000,
  resources: { surfaces: ["web"], services: ["den"] },
});

const row = (title: string) => `[data-testid="skill-usage-row"][data-skill="${title}"]`;

test("an owner sees which skills teammates use and which nobody uses, while a teammate cannot see usage", async ({ world, user, probe, step, evidence }) => {
  const owner = user.on(world.web);
  const page = probe.on(world.web);
  const teammate = user.on(world.memberWeb);
  const memberPage = probe.on(world.memberWeb);
  const { draftReply, summarizeTicket, quoteBuilder } = world.skills;
  const usagePath = "/v1/skill-usage?days=30";

  await step("before: the owner opens Skills in Analytics and every skill reads Not used", async () => {
    await owner.see({ role: "link", label: "Skills" }, { timeoutMs: 90_000 });
    await owner.click({ role: "link", label: "Skills" });
    await owner.see({ role: "heading", label: "Skills" }, { timeoutMs: 60_000 });
    await owner.see({ testId: "skill-usage-not-counting" }, { timeoutMs: 60_000 });
    const unused = (await page.dom('[data-skill-unused]')).elements;
    expect(unused).toHaveLength(3);
    evidence.recordAssertionEvidence("a fresh workspace has no uses yet", `${unused.length} of 3 skills read Not used and the list says no uses are recorded yet`, unused.length === 3);
    await owner.screenshot();
  });

  await step("when two teammates' agents load Draft reply through OpenWork Cloud", async () => {
    const loads = [
      await world.loadSkill("alice", "draftReply", "get_skill"),
      // The same teammate loading the same skill again a moment later is one use.
      await world.loadSkill("alice", "draftReply", "get_skill"),
      await world.loadSkill("blair", "draftReply", "execute_capability"),
      await world.loadSkill("blair", "summarizeTicket", "get_skill"),
    ];
    const served = loads.filter((load) => load.status === 200 && !load.isError && load.servedSkill).length;
    evidence.recordAssertionEvidence("each agent received the skill", `${served} of 4 loads returned the SKILL.md (get_skill twice for Alice, execute_capability and get_skill for Blair)`, served === 4);
    expect(served).toBe(4);
    await owner.reload();
    await owner.see({ role: "heading", label: "Skills" }, { timeoutMs: 60_000 });
  });

  await step("after: Draft reply shows 2 uses by 2 people today, and Quote builder still reads Not used", async () => {
    await page.eventually(async () => {
      await owner.reload();
      await owner.see({ testId: "skill-usage-row" }, { timeoutMs: 30_000 });
      const uses = (await page.dom(`${row(draftReply.title)} [data-skill-uses]`)).elements.map((entry) => entry.text);
      if (uses[0] !== "2") throw new Error(`Draft reply shows ${uses.join() || "nothing"} uses so far.`);
      return uses;
    }, { within: 60_000, intervalMs: 2_000, label: "Draft reply counts two uses" });
    await owner.see({ text: "Today" });
    const draft = (await page.dom(row(draftReply.title))).elements[0]?.text ?? "";
    const summary = (await page.dom(row(summarizeTicket.title))).elements[0]?.text ?? "";
    const quoteUnused = (await page.dom(`${row(quoteBuilder.title)} [data-skill-unused]`)).elements.length;
    const report = await probe.api(world.den.admin, usagePath);
    evidence.recordAssertionEvidence(
      "uses, people and last use match what the agents did",
      `Draft reply: ${draft.replace(/\s+/g, " ")}; Summarize ticket: ${summary.replace(/\s+/g, " ")}; Quote builder Not used: ${quoteUnused === 1}; API HTTP ${report.response.status}`,
      quoteUnused === 1 && report.response.ok,
    );
    expect(quoteUnused).toBe(1);
    expect(draft).toContain("Today");
    await owner.screenshot();
  });

  await step("the Not used filter leaves only the skill nobody has used", async () => {
    await owner.click({ role: "radio", label: "Not used" });
    await owner.see({ text: quoteBuilder.title });
    const visible = (await page.dom('[data-testid="skill-usage-row"]')).elements.map((entry) => entry.text.replace(/\s+/g, " "));
    evidence.recordAssertionEvidence("only unused skills remain", `${visible.length} row: ${visible.join(", ")}`, visible.length === 1 && visible[0]?.includes(quoteBuilder.title) === true);
    expect(visible).toHaveLength(1);
    await owner.screenshot();
  });

  await step("a teammate cannot read skill usage", async () => {
    await teammate.navigate(`${world.baseUrl}/dashboard/analytics/skills`);
    await teammate.notSee({ role: "heading", label: "Skills" });
    const alice = world.den.members.alice;
    if (!alice) throw new Error("Missing teammate session.");
    const denied = await probe.api(alice, usagePath);
    const headings = (await memberPage.dom("h1")).elements.map((entry) => entry.text);
    evidence.recordAssertionEvidence("usage is for owners and admins only", `teammate API read: HTTP ${denied.response.status}; teammate page headings: ${headings.join(", ") || "none"}`, denied.response.status === 403);
    expect(denied.response.status).toBe(403);
    await teammate.screenshot();
  });
});
