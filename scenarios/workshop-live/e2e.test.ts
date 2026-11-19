import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { record, rows, workshopAgent, workshopModel } from "../../evals/worlds/workshop-agent.ts";

const test = spec.world(workshopAgent, {
  resources: { surfaces: ["appWeb", "web"], services: ["den"] },
  needs: { placement: "local", commands: ["bun", "pnpm", "python3"], env: ["OPENAI_API_KEY"], optIn: ["OPEN_WORKPLACE_LIVE_PROOF"] },
  timeout: 1_200_000,
});

test("two workshop members connect their own accounts and one agent saves sourced work without crossing the account boundary", async ({ world, user, agent, probe, step, evidence }) => {
  let baseline: Record<string, unknown> = {};
  let beforePages: Record<string, unknown>[] = [];
  let firstOutputTokens = 0;
  await step("before: two members have independent accounts and neither has connected the workshop", async () => {
    await user.on(world.webA).reload();
    for (const connection of world.connections) {
      expect((await world.connection("a", connection.id))?.connectedForMe).toBe(false);
      expect((await world.connection("b", connection.id))?.connectedForMe).toBe(false);
    }
    baseline = await world.state("a", "microsoft");
    const state = await world.state("a", "atlassian");
    beforePages = record(state.confluence) ? rows(state.confluence.pages) : [];
    expect(beforePages.length).toBeGreaterThan(0);
    evidence.recordAssertionEvidence("Both members start disconnected from all five scoped connectors", `Five OAuth connections, credential mode per_member; ${world.hosted ? "hosted HTTPS gateway" : "local standalone gateway (not hosted deployment evidence)"}; baseline pages ${beforePages.length}.`, beforePages.length > 0 && world.connections.length === 5);
    await user.on(world.webA).screenshot();
  });

  for (const person of ["a", "b"] as const) {
    await step(`member ${person.toUpperCase()} authorizes the same five connector URLs with their own workshop account`, async () => {
      const surface = person === "a" ? world.webA : world.webB;
      const browser = user.on(surface);
      for (const connection of world.connections) {
        const authorizeUrl = await world.oauthStart(person, connection.id);
        await browser.navigate(authorizeUrl);
        // The real Den OAuth client performs discovery, DCR, PKCE and token exchange.
        // Only the participant types their workshop credential in the provider's browser page.
        const pageText = await probe.eventually(() => probe.on(surface).text(), {
          within: 60_000, label: "the real provider offers login or connector consent",
          until: (text) => text.includes("Workshop password") || text.includes("Allow workplace access"),
        });
        if (pageText.includes("Workshop password")) {
          await browser.type({ label: "Workshop password" }, world.accessCode(person), { sensitive: true });
          await browser.click({ role: "button", label: "Sign in" });
        }
        await browser.see({ role: "button", label: "Allow workplace access" }, { timeoutMs: 30_000 });
        await browser.click({ role: "button", label: "Allow workplace access" });
        await probe.eventually(() => world.connection(person, connection.id), {
          within: 60_000, label: `${person} owns a ready ${connection.app} OAuth connection`, until: (value) => value?.connectedForMe === true,
        });
        if (person === "a") expect((await world.connection("b", connection.id))?.connectedForMe).toBe(false);
      }
      await browser.navigate(`${world.den.ref.webUrl}/dashboard/your-connections`);
      const connected = await Promise.all(world.connections.map((connection) => world.connection(person, connection.id)));
      expect(connected.every((connection) => connection?.connectedForMe === true)).toBe(true);
      evidence.recordAssertionEvidence(`Member ${person.toUpperCase()} has five independently authorized OAuth grants`, `All five exact app resources connected through Den's browser OAuth client; ${person === "a" ? "member B remained disconnected after every A grant" : "B used a separate browser profile and workshop password"}.`, connected.every((connection) => connection?.connectedForMe === true));
      await browser.screenshot();
    });
  }

  await step("the member chooses real Sol 6.1 in the actual OpenWork conversation", async () => {
    await world.waitForInferenceRelease();
    await user.see("composer", { editable: true, timeoutMs: 60_000 });
    const binding = await agent.run("session.set_model", { sessionId: world.session.sessionId, workspaceId: world.workspace.workspaceId, providerId: world.providerId, modelId: workshopModel, variant: "low" });
    expect(binding).toMatchObject({ ok: true });
    evidence.recordAssertionEvidence("The real app is bound to one paid Sol 6.1 model", `Den-managed provider ${world.providerId} (source OpenAI), model ${workshopModel}; no mock inference transport; two bounded agent tasks.`, record(binding) && binding.ok === true);
    await user.screenshot();
  });

  await step("after: the agent saves a sourced one-slide PowerPoint in Drive and links it from an unsent thread reply", async () => {
    const oldIds = await world.messageIds();
    await agent.send(`Use the connected workshop apps to review the Northwind pilot email thread and shared pilot brief. Tell me whether we can call the pilot production-ready, with clickable source links. Create a polished ONE-SLIDE actual PowerPoint presentation (.pptx) summarizing the readiness decision, evidence, blocker and owners. Save it in Drive named ${world.marker}-readiness.pptx. Create a reply draft in the EXISTING Northwind email thread for my review, linking the saved presentation and citing the source information behind the not-production-ready conclusion. Put ${world.marker} in the draft body. Do not send anything or create an unrelated email draft. Use the Outlook and Drive connectors, discovering tools as needed. You may use shell/Python standard library zipfile and XML to generate the real one-slide .pptx, then the Drive binary write or upload-session tool to save it. Do not install packages or access external websites. Keep the final response under 250 words.`);
    const turn = await world.waitTurn(oldIds);
    firstOutputTokens = turn.outputTokens;
    const after = await world.state("a", "microsoft");
    const drafts = rows(after.messages).filter((message) => message.isDraft === true && JSON.stringify(message).includes(world.marker));
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({ conversationId: "thread-northwind", parentFolderId: "drafts", isDraft: true });
    const file = rows(after.files).find((entry) => entry.name === `${world.marker}-readiness.pptx`);
    expect(file).toBeDefined();
    const presentation = await world.presentation(String(file?.id));
    expect(presentation.slides).toBe(1);
    expect(presentation.text).toMatch(/roam|aisle C|Wi-Fi/i);
    expect(presentation.text).toMatch(/pending|not.*ready|not.*production|not yet/i);
    expect(presentation.text).toMatch(/497|99\.4/);
    expect(JSON.stringify(drafts[0])).toContain(String(file?.webUrl));
    expect(JSON.stringify(drafts[0])).toMatch(/pending|not.*ready|not.*production|not yet/i);
    expect(JSON.stringify(drafts[0])).toMatch(/outlook\?message=|drive\?item=/);
    const sent = (value: Record<string, unknown>) => rows(value.messages).filter((message) => message.parentFolderId === "sentitems").length;
    expect(sent(after)).toBe(sent(baseline));
    expect(turn.text).toMatch(/pending|not.*ready|not.*production|not yet/i);
    expect(turn.text).toContain(world.origin);
    expect(turn.text).toMatch(/outlook\?message=|drive\?item=/);
    expect(JSON.stringify(turn.messages)).toMatch(/tool/);
    evidence.recordAssertionEvidence("Real Sol produces a sourced readiness answer and actual unsent draft plus Drive file", `Model ${turn.model}; final-response output tokens ${turn.outputTokens}; cumulative catalog-rate token estimate $${turn.estimatedCost.toFixed(4)}; one draft in thread-northwind; Drive PowerPoint downloaded independently (${presentation.zipEntries} ZIP entries, ${presentation.slides} real slide XML); reply links saved presentation; sent-items unchanged (${sent(after)}); linked source answer: ${turn.text.slice(0, 1100)}`, turn.outputTokens > 0 && drafts.length === 1 && Boolean(file) && sent(after) === sent(baseline));
    await user.screenshot();
  });

  await step("after: the agent creates an ordinary engineering task and appends a linked section without replacing the account page", async () => {
    const oldIds = await world.messageIds();
    await agent.send(`Use the workshop Jira and Confluence connectors. Create ONE ordinary engineering Task (not an IT service desk request) to verify the aisle C Wi-Fi roaming test before the Northwind pilot readiness decision. Include ${world.marker} in its summary. Find the EXISTING Northwind account plan in Confluence, preserve all its existing content, and append a clearly labeled "Workshop pilot follow-up ${world.marker}" section linking the task you created and noting that site acceptance remains pending. Do not create a replacement page. Do not change any login, password, account state or unrelated issue. Do not use shell or external websites. Keep the final response under 200 words with the issue and page links.`);
    const turn = await world.waitTurn(oldIds);
    const state = await world.state("a", "atlassian");
    const jira = record(state.jira) ? state.jira : {};
    const issues = rows(jira.issues).filter((issue) => JSON.stringify(issue).includes(world.marker));
    expect(issues).toHaveLength(1);
    expect(issues[0]?.issuetype).toBe("Task");
    expect(issues[0]?.project).not.toBe("ITSD");
    const pages = record(state.confluence) ? rows(state.confluence.pages) : [];
    const changed = pages.filter((page) => JSON.stringify(page.body).includes(world.marker));
    expect(changed).toHaveLength(1);
    const page = changed[0];
    const before = beforePages.find((entry) => entry.id === page?.id);
    expect(before).toBeDefined();
    expect(page?.title).toBe(before?.title);
    expect(Number(page?.version)).toBe(Number(before?.version) + 1);
    expect(String(page?.body)).toContain(String(before?.body));
    expect(String(page?.body)).toContain(String(issues[0]?.key));
    expect(pages.length).toBe(beforePages.length);
    evidence.recordAssertionEvidence("The second real agent task makes a normal Jira Task and preserves the existing Confluence page", `Model ${turn.model}; final-response output tokens ${turn.outputTokens}; cumulative catalog-rate token estimate $${turn.estimatedCost.toFixed(4)}; issue ${issues[0]?.key}, type Task, project ${issues[0]?.project}; existing page ${page?.title} version ${before?.version} → ${page?.version}; original body retained; no replacement page.`, turn.outputTokens > 0 && issues.length === 1 && changed.length === 1 && String(page?.body).includes(String(before?.body)));
    await user.screenshot();
  });

  await step("the other member's identical app URLs expose only their unchanged private sample data", async () => {
    const otherBrowser = user.on(world.webB);
    await otherBrowser.navigate(`${world.origin}/drive`);
    const otherScreen = await probe.eventually(() => probe.on(world.webB).text(), {
      within: 30_000, label: "the other member opens their own Drive",
      until: (text) => text.includes("Workshop password") || text.includes("Northwind-pilot-brief.docx"),
    });
    if (otherScreen.includes("Workshop password")) {
      await otherBrowser.type({ label: "Workshop password" }, world.accessCode("b"), { sensitive: true });
      await otherBrowser.click({ role: "button", label: "Sign in" });
    }
    await otherBrowser.see({ text: "Northwind-pilot-brief.docx" }, { timeoutMs: 30_000 });
    await otherBrowser.notSee({ text: `${world.marker}-readiness.pptx` });
    const [otherMail, otherProjects, ownMail, ownProjects] = await Promise.all([
      world.state("b", "microsoft"), world.state("b", "atlassian"), world.state("a", "microsoft"), world.state("a", "atlassian"),
    ]);
    expect(JSON.stringify(otherMail)).not.toContain(world.marker);
    expect(JSON.stringify(otherProjects)).not.toContain(world.marker);
    expect(JSON.stringify(ownMail)).toContain(world.marker);
    expect(JSON.stringify(ownProjects)).toContain(world.marker);
    expect(firstOutputTokens).toBeGreaterThan(0);
    evidence.recordAssertionEvidence("Same URLs and seeded IDs do not reveal another workshop member's work", `Independent authenticated service readbacks: A retains its draft/file/task/page markers; B contains zero occurrences across mail, Drive, Jira and Confluence; ${world.hosted ? "hosted gateway" : "local gateway only, hosted proof still required"}.`, !JSON.stringify(otherMail).includes(world.marker) && !JSON.stringify(otherProjects).includes(world.marker) && JSON.stringify(ownMail).includes(world.marker) && JSON.stringify(ownProjects).includes(world.marker));
    await user.on(world.webB).screenshot();
  });
});
