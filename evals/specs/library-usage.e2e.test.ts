import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { libraryUsage } from "../worlds/library-usage.ts";

const test = spec.world(libraryUsage, {
  timeout: 600_000,
  resources: { surfaces: ["web"], services: ["den", "mock"] },
});

const row = (name: string) => `[data-testid="library-usage-row"][data-item="${name}"]`;
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

test("an owner sees which plugins, skills and connectors the team uses, which fail, and which nobody uses, while a teammate cannot see usage", async ({ world, user, probe, step, evidence }) => {
  const owner = user.on(world.web);
  const page = probe.on(world.web);
  const teammate = user.on(world.memberWeb);
  const memberPage = probe.on(world.memberWeb);
  const { draftReply, summarizeTicket, quoteBuilder } = world.skills;
  const rowText = async (name: string) => oneLine((await page.dom(row(name))).elements[0]?.text ?? "");
  const openView = async (label: string, expected: string) => {
    await owner.click({ role: "radio", label });
    await page.eventually(async () => {
      if ((await page.dom(row(expected))).elements.length === 0) throw new Error(`${label} has not shown ${expected} yet.`);
      return true;
    }, { within: 30_000, intervalMs: 500, label: `${label} view` });
  };

  await step("before: the owner opens Plugins & connectors in Analytics and sees that nothing has been used yet", async () => {
    await owner.see({ role: "link", label: "Plugins & connectors" }, { timeoutMs: 90_000 });
    await owner.click({ role: "link", label: "Plugins & connectors" });
    await owner.see({ role: "heading", label: "Plugins & connectors" }, { timeoutMs: 60_000 });
    await owner.see({ testId: "library-usage-no-usage" }, { timeoutMs: 60_000 });
    await owner.see({ text: "No usage yet" });
    const unused = (await page.dom("[data-item-unused]")).elements.length;
    evidence.recordAssertionEvidence("a fresh workspace shows an empty state, not a page of zeros", `No usage yet is shown; ${unused} of 2 plugins are listed as Not used and no summary cards are drawn`, unused === 2);
    expect(unused).toBe(2);
    expect((await page.dom('[data-testid="library-usage-summary"]')).elements).toHaveLength(0);
    await owner.screenshot();
  });

  await step("when teammates' agents load skills and call connector tools through OpenWork, and one call fails", async () => {
    const loads = [
      await world.loadSkill("alice", "draftReply", "get_skill"),
      // The same teammate loading the same skill again a moment later is one use.
      await world.loadSkill("alice", "draftReply", "get_skill"),
      await world.loadSkill("blair", "draftReply", "execute_capability"),
      await world.loadSkill("blair", "summarizeTicket", "get_skill"),
    ];
    const calls = [
      await world.callConnector("alice", "tracker", "search_issues"),
      await world.callConnector("blair", "tracker", "search_issues"),
      await world.callConnector("blair", "tracker", "create_issue"),
    ];
    const served = loads.filter((load) => load.status === 200 && !load.isError && load.servedSkill).length;
    const succeeded = calls.filter((call) => call.status === 200 && !call.isError).length;
    evidence.recordAssertionEvidence("the agents really used them", `${served} of 4 skill loads returned the SKILL.md; ${succeeded} of 3 connector calls succeeded and create_issue failed with "Project is archived"`, served === 4 && succeeded === 2);
    expect(served).toBe(4);
    expect(succeeded).toBe(2);
  });

  await step("after: Support kit shows 3 uses by 2 people today and Sales kit still reads Not used", async () => {
    await page.eventually(async () => {
      await owner.reload();
      await owner.see({ testId: "library-usage-row" }, { timeoutMs: 30_000 });
      const uses = (await page.dom(`${row("Support kit")} [data-item-uses]`)).elements.map((entry) => entry.text);
      if (uses[0] !== "3") throw new Error(`Support kit shows ${uses.join() || "nothing"} uses so far.`);
      return uses;
    }, { within: 60_000, intervalMs: 2_000, label: "Support kit counts three uses" });
    const support = await rowText("Support kit");
    const sales = await rowText("Sales kit");
    evidence.recordAssertionEvidence("plugins add up their skills' uses", `Support kit: ${support}; Sales kit: ${sales}`, support.includes("Today") && sales.includes("Not used"));
    expect(support).toContain("Today");
    expect(sales).toContain("Not used");
    await owner.see({ testId: "library-usage-summary" });
    await owner.screenshot();
  });

  await step("the Skills view counts the repeated load once and the Not used filter leaves only the skill nobody used", async () => {
    await openView("Skills", draftReply.title);
    const draft = await rowText(draftReply.title);
    const draftUses = (await page.dom(`${row(draftReply.title)} [data-item-uses]`)).elements[0]?.text ?? "";
    const summary = await rowText(summarizeTicket.title);
    await owner.click({ role: "radio", label: "Not used" });
    await owner.see({ text: quoteBuilder.title });
    const visible = (await page.dom('[data-testid="library-usage-row"]')).elements.map((entry) => oneLine(entry.text));
    evidence.recordAssertionEvidence("skill counts and the Not used filter", `${draftReply.title}: ${draftUses} uses (${draft}); ${summarizeTicket.title}: ${summary}; Not used shows ${visible.length} row: ${visible.join(", ")}`, visible.length === 1 && draftUses === "2");
    expect(draftUses).toBe("2");
    expect(visible).toHaveLength(1);
    await owner.screenshot();
  });

  await step("the Connectors view shows 1 of 3 calls failed on Team tracker and Old wiki was never used", async () => {
    await openView("Connectors", world.connectors.tracker);
    await page.eventually(async () => {
      const failed = (await page.dom(`${row(world.connectors.tracker)} [data-item-failures]`)).elements.map((entry) => entry.text);
      if (failed[0] !== "1 of 3") throw new Error(`Team tracker shows ${failed.join() || "nothing"} failed so far.`);
      return failed;
    }, { within: 30_000, intervalMs: 1_000, label: "Team tracker shows one failed call" });
    const tracker = await rowText(world.connectors.tracker);
    const wiki = await rowText(world.connectors.wiki);
    await owner.click({ role: "radio", label: "Failing" });
    const failing = (await page.dom('[data-testid="library-usage-row"]')).elements.map((entry) => oneLine(entry.text));
    evidence.recordAssertionEvidence("connector calls and failures", `Team tracker: ${tracker}; Old wiki: ${wiki}; Failing shows ${failing.length} row`, wiki.includes("Not used") && failing.length === 1);
    expect(wiki).toContain("Not used");
    expect(failing).toHaveLength(1);
    await owner.screenshot();
  });

  await step("a teammate cannot read usage", async () => {
    await teammate.navigate(`${world.baseUrl}/dashboard/analytics/library`);
    await teammate.notSee({ role: "heading", label: "Plugins & connectors" });
    const alice = world.den.members.alice;
    if (!alice) throw new Error("Missing teammate session.");
    const denied = await Promise.all(["plugins", "skills", "connectors"].map((kind) => probe.api(alice, `/v1/library-usage/${kind}`)));
    const statuses = denied.map((result) => result.response.status);
    const headings = (await memberPage.dom("h1")).elements.map((entry) => entry.text);
    evidence.recordAssertionEvidence("usage is for owners and admins only", `teammate API reads: ${statuses.join(", ")}; teammate page headings: ${headings.join(", ") || "none"}`, statuses.every((status) => status === 403));
    expect(statuses).toEqual([403, 403, 403]);
    await teammate.screenshot();
  });
});

