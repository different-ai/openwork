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

  await step("when teammates' agents load skills and make two successful connector calls through OpenWork", async () => {
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
    ];
    const served = loads.filter((load) => load.status === 200 && !load.isError && load.servedSkill).length;
    const succeeded = calls.filter((call) => call.status === 200 && !call.isError).length;
    evidence.recordAssertionEvidence("the agents really used them without failures", `${served} of 4 skill loads returned the SKILL.md; ${succeeded} of 2 connector calls succeeded through the gateway`, served === 4 && succeeded === 2);
    expect(served).toBe(4);
    expect(succeeded).toBe(2);
  });

  await step("after: two successful connector calls show Failed 0 without an attention color", async () => {
    await openView("Connectors", world.connectors.tracker);
    await page.eventually(async () => {
      await owner.reload();
      await owner.see({ testId: "library-usage-row" }, { timeoutMs: 30_000 });
      const uses = (await page.dom(`${row(world.connectors.tracker)} [data-item-uses]`)).elements[0]?.text;
      const failed = (await page.dom(`${row(world.connectors.tracker)} [data-item-failures]`)).elements[0]?.text;
      if (uses !== "2" || failed !== "0") throw new Error(`Team tracker shows ${uses ?? "no"} uses and ${failed ?? "no"} failures so far.`);
      return true;
    }, { within: 60_000, intervalMs: 1_000, label: "two successful calls are recorded with zero failures" });
    await owner.see({ testId: "library-usage-failed" });
    const neutral = (await page.dom('[data-testid="library-usage-failed"][data-state="neutral"]')).elements;
    const neutralIcons = (await page.dom('[data-testid="library-usage-failed"] svg[class~="text-[var(--dls-text-secondary)]"]')).elements;
    const attentionIcons = (await page.dom('[data-testid="library-usage-failed"] svg[class~="text-[var(--ow-danger)]"]')).elements;
    const card = (await page.dom('[data-testid="library-usage-failed"] > div > div')).elements.map((entry) => oneLine(entry.text)).join(" ");
    const ok = neutral.length === 1 && neutralIcons.length === 1 && attentionIcons.length === 0 && card === "Failed 0 0% of uses";
    evidence.recordAssertionEvidence("zero failures is a neutral measured state", `Team tracker has 2 real uses and 0 failures; card reads ${card}; ${neutral.length} neutral card, ${neutralIcons.length} muted icon and ${attentionIcons.length} attention icons`, ok);
    expect(ok).toBe(true);
    await owner.screenshot();
  });

  await step("the compact name filter leaves only the connector the owner searches for", async () => {
    await owner.type({ placeholder: "Filter by name" }, world.connectors.tracker, { replace: true });
    await owner.see({ text: world.connectors.tracker });
    await owner.notSee({ text: world.connectors.wiki });
    const filter = (await page.dom('[data-testid="library-usage-filters"] > label')).elements[0];
    const visible = (await page.dom('[data-testid="library-usage-row"]')).elements;
    const ok = filter !== undefined && filter.rect.height === 32 && filter.rect.width === 240 && visible.length === 1;
    evidence.recordAssertionEvidence("the shared compact filter works without becoming a full-width search bar", `Filter is ${filter?.rect.width ?? 0}×${filter?.rect.height ?? 0}px; ${visible.length} row remains for ${world.connectors.tracker}`, ok);
    expect(ok).toBe(true);
    await owner.screenshot();
    await owner.type({ placeholder: "Filter by name" }, "", { replace: true });
    await owner.press("Backspace");
    await owner.see({ text: world.connectors.wiki });
  });

  await step("when a teammate's agent tries to create an issue, the connector really refuses the archived project", async () => {
    const failed = await world.callConnector("blair", "tracker", "create_issue");
    const refused = failed.status === 200 && failed.isError && failed.text.includes("Project is archived.");
    evidence.recordAssertionEvidence("the third connector call really fails through the gateway", `HTTP ${failed.status}; tool failure ${failed.isError}; ${failed.text}`, refused);
    expect(refused).toBe(true);
  });

  await step("after: Support kit shows 3 uses by 2 people today and Sales kit still reads Not used", async () => {
    await openView("Plugins", "Support kit");
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
      // The earlier zero-failure report is still cached. A real reload reads
      // the updated report without injecting counts or touching query state.
      await owner.reload();
      await owner.see({ testId: "library-usage-row" }, { timeoutMs: 30_000 });
      const failed = (await page.dom(`${row(world.connectors.tracker)} [data-item-failures]`)).elements.map((entry) => entry.text);
      if (failed[0] !== "1 of 3") throw new Error(`Team tracker shows ${failed.join() || "nothing"} failed so far.`);
      return failed;
    }, { within: 30_000, intervalMs: 1_000, label: "Team tracker shows one failed call" });
    const tracker = await rowText(world.connectors.tracker);
    const wiki = await rowText(world.connectors.wiki);
    const attention = (await page.dom('[data-testid="library-usage-failed"][data-state="attention"]')).elements;
    const attentionIcons = (await page.dom('[data-testid="library-usage-failed"] svg[class~="text-[var(--ow-danger)]"]')).elements;
    const neutralIcons = (await page.dom('[data-testid="library-usage-failed"] svg[class~="text-[var(--dls-text-secondary)]"]')).elements;
    const card = (await page.dom('[data-testid="library-usage-failed"] > div > div')).elements.map((entry) => oneLine(entry.text)).join(" ");
    // Both fixtures are custom MCP names, not named services. A generic
    // tracker must not acquire a made-up Linear, Slack or other brand logo.
    const inventedLogos = (await page.dom(`${row(world.connectors.tracker)} img, ${row(world.connectors.wiki)} img`)).elements;
    await owner.click({ role: "radio", label: "Failing" });
    const failing = (await page.dom('[data-testid="library-usage-row"]')).elements.map((entry) => oneLine(entry.text));
    const ok = wiki.includes("Not used") && failing.length === 1 && attention.length === 1
      && attentionIcons.length === 1 && neutralIcons.length === 0 && card === "Failed 1 33% of uses" && inventedLogos.length === 0;
    evidence.recordAssertionEvidence("only a real failed call gets the attention state", `Team tracker: ${tracker}; Old wiki: ${wiki}; Failing shows ${failing.length} row; card ${card}, ${attentionIcons.length} attention icon, ${neutralIcons.length} muted icons; ${inventedLogos.length} fabricated service logos`, ok);
    expect(ok).toBe(true);
    await owner.screenshot();
  });

  await step("after: at phone width the owner's comparison table scrolls sideways without widening the page", async () => {
    await owner.click({ role: "radio", label: "All" });
    await owner.resizeViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
    await owner.see({ role: "heading", label: "Plugins & connectors" });
    await owner.see({ testId: "library-usage-table" });
    const layout = await world.usageLayout();
    const visible = (await page.dom('[data-testid="library-usage-row"]')).elements;
    const headers = (await page.dom('[data-testid="library-usage-columns"] > span')).elements.map((entry) => entry.text);
    const frames = (await page.dom('body, [data-testid="library-usage"], [data-testid="library-usage-toolbar"], [data-testid="library-usage-filters"], [data-testid="library-usage-table"]')).elements;
    const fits = frames.every((entry) => entry.rect.left >= 0 && entry.rect.right <= 390);
    const ok = layout.viewportWidth === 390 && layout.documentWidth <= 390 && layout.bodyScrollWidth <= layout.bodyWidth
      && layout.table !== null && layout.table.width > 0 && layout.table.scrollWidth > layout.table.width
      && layout.table.overflowX === "auto" && fits && visible.length === 2;
    evidence.recordAssertionEvidence("phone-width scrolling stays inside the comparison table", `Viewport ${layout.viewportWidth}px; document ${layout.documentWidth}px; body ${layout.bodyScrollWidth}/${layout.bodyWidth}px; table ${layout.table?.scrollWidth ?? 0}/${layout.table?.width ?? 0}px (${layout.table?.overflowX ?? "missing"}); ${visible.length} real connector rows; columns ${headers.join(", ")}; page frames fit: ${fits}`, ok);
    expect(headers).toEqual(["Connector", "Uses", "People", "Failed", "Last used"]);
    expect(ok).toBe(true);
    await owner.screenshot();
    await owner.resizeViewport({ width: 1280, height: 1000, deviceScaleFactor: 1 });
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

