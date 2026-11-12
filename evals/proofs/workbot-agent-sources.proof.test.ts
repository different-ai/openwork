import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { agentSourcesPolicySchema, memberAgentSavedSchema, memberAgentViewSchema, workbotProactiveViewSchema } from "@openwork/types/den/workbot-proactive";
import { workbotAgentSourcesWorld } from "../worlds/workbot-agent-sources.ts";

const test = spec.world(workbotAgentSourcesWorld, { resources: { surfaces: ["web"], services: ["den", "mock"] }, needs: { placement: "local" }, timeout: 600_000 });

// DESIGN S2 (one row per source: label left, state and its one control right), P1 (state, not explanation: "Uses
// Google Workspace"), P4/C5 (a source the admin decided is shown locked with the reason), P8 (chat's change says how
// to undo it), V5 (the calendar shows its generic icon, each connector its logo), C1/C7 (verb-first actions: "Connect
// Google Calendar"; sentence case). The calendar is one setting with no app to pick; mail and chat are read through
// their connectors, not as sources of their own. Chat is the Connect call Workbot makes for the member.
test("an admin sets guardrails for what agents read; a member picks within them and steers sources in chat or on the page, never past the admin", async ({ world, user, probe, step, evidence }) => {
  const owner = user.on(world.owner), ownerProbe = probe.on(world.owner);
  const member = user.on(world.member), memberProbe = probe.on(world.member);
  const agent = async () => memberAgentViewSchema.parse((await memberProbe.api(world.den.members.member, "/v1/me/agent")).body);
  const sourceOf = async (id: string) => (await agent()).sources?.find((source) => source.id === id);
  const { notes, tracker, wiki, desk } = world.connections;

  await step("before: the calendar is on for everyone; Connectors lists the reviewed services, up to members", async () => {
    await owner.see({ testId: "workbot-proactive-sources" }, { timeoutMs: 90_000 });
    await owner.see({ text: "Uses Google Workspace" });
    await owner.see({ role: "button", label: "Remove Granola from Connectors" });
    await owner.see({ text: "Read only. Agents never send, edit or delete through these." });
    const policy = await world.policy();
    const defaults = JSON.stringify({ calendar: "everyone", connections: {} });
    evidence.recordAssertionEvidence("The defaults", `GET /v1/org/workbot-settings/proactive sources: ${JSON.stringify(policy)} (connectors: members choose)`, JSON.stringify(policy) === defaults);
    expect(JSON.stringify(policy)).toBe(defaults);
    await owner.screenshot();
  });

  await step("the owner doesn't allow agents to read the wiki", async () => {
    await owner.click({ role: "button", label: "Notion" });
    await owner.click({ role: "option", label: "Not allowed" });
    const policy = await ownerProbe.eventually(() => world.policy(), {
      within: 30_000,
      label: "the wiki is not allowed",
      until: (value) => typeof value === "object" && value !== null && JSON.stringify(value).includes(`"${wiki.id}":"off"`),
    });
    evidence.recordAssertionEvidence("Saved on the server", `sources.connections: ${JSON.stringify(policy)}`, JSON.stringify(policy).includes(`"${wiki.id}":"off"`));
    await owner.screenshot();
  });

  await step("the owner lets members choose whether their agent reads the calendar: one picklist, no app to pick; Support desk, a service without reviewed reads, isn't offered", async () => {
    await owner.click({ role: "button", label: "Calendar" });
    await owner.click({ role: "option", label: "Members choose" });
    const policy = await ownerProbe.eventually(() => world.policy(), {
      within: 30_000,
      label: "members choose the calendar",
      until: (value) => agentSourcesPolicySchema.safeParse(value).data?.calendar === "members",
    });
    const view = workbotProactiveViewSchema.parse((await ownerProbe.api(world.den.admin, "/v1/org/workbot-settings/proactive")).body);
    const calendarApps = view.sourceConnections?.calendar.map((connection) => connection.name) ?? [];
    const offered = view.sourceConnections?.all.map((connection) => connection.id) ?? [];
    const saved = agentSourcesPolicySchema.parse(policy).calendar === "members" && calendarApps.join(", ") === "Google Workspace" && !offered.includes(desk.id);
    evidence.recordAssertionEvidence("Saved on the server", `calendar: ${agentSourcesPolicySchema.parse(policy).calendar}; read through ${calendarApps.join(", ")}, with nothing to pick; Support desk offered as a connector: ${offered.includes(desk.id)}`, saved);
    expect(saved).toBe(true);
    await owner.see({ text: "Uses Google Workspace" });
    await owner.notSee({ role: "button", label: "Remove Support desk from Connectors" });
    await owner.screenshot();
  });

  await step("a member's What it reads: the calendar waits for them to connect Google, mail and chat are not sources of their own, the wiki is locked with the reason", async () => {
    await member.reload();
    await member.see({ testId: "my-agent-uses" }, { timeoutMs: 90_000 });
    await member.see({ text: "Not allowed" });
    await member.see({ text: "Locked sources are set by your admin." });
    await member.see({ role: "link", label: "Connect Google Calendar" });
    const sources = (await agent()).sources ?? [];
    const calendar = sources.find((source) => source.id === "calendar");
    const ids = sources.map((source) => source.id);
    evidence.recordAssertionEvidence(
      "The calendar reads the organization's one calendar app; mail and chat are not sources of their own",
      `calendar reads ${calendar?.connections.map((connection) => connection.name).join(", ")} (chosen ${calendar?.chosenBy}) of ${calendar?.options.map((option) => option.name).join(", ")}; sources: ${sources.map((source) => source.name).join(", ")}`,
      calendar?.connections.length === 1 && calendar.options.length === 1 && !ids.includes("email") && !ids.includes("chat"),
    );
    expect(calendar?.options.map((option) => option.name)).toEqual(["Google Workspace"]);
    expect(ids).not.toContain("email");
    expect(ids).not.toContain("chat");
    await member.click({ role: "switch", label: "Linear" });
    const linear = await memberProbe.eventually(() => sourceOf(tracker.id), { within: 30_000, label: "Linear is on", until: (value) => value?.on === true });
    const notion = await sourceOf(wiki.id);
    evidence.recordAssertionEvidence(
      "Sources as the member sees them",
      `Linear on from the page=${linear?.on}; Notion policy=${notion?.policy}, on=${notion?.on}; Granola policy=${(await sourceOf(notes.id))?.policy}`,
      linear?.on === true && notion?.policy === "off" && notion.on === false,
    );
    await member.screenshot();
  });

  await step("in chat: \"also look at my Granola for context, especially action items after meetings, and skip Linear\" saves exactly that", async () => {
    const said = await world.sayInChat("putMeAgent", { sources: [{ source: "Granola", on: true, instruction: "Use for meeting context and action items after meetings." }, { source: "Linear", on: false }] });
    const reply = memberAgentSavedSchema.parse(said.body).saved?.reply ?? "";
    expect(reply).toMatch(/^Saved:\n- Granola on, for “Use for meeting context and action items after meetings\.”\n- Linear off\nReply "undo" to revert\. My bot: http/);
    await member.reload();
    await member.see({ text: "“Use for meeting context and action items after meetings.”" }, { timeoutMs: 60_000 });
    await member.see({ role: "button", label: "Edit the instruction for Granola" });
    const granola = await sourceOf(notes.id);
    const linear = await sourceOf(tracker.id);
    evidence.recordAssertionEvidence("Chat's reply, and the page shows what chat saved", `${reply.replaceAll("\n", " / ")}; Granola on=${granola?.on} "${granola?.instruction}"; Linear on=${linear?.on}`, granola?.on === true && linear?.on === false);
    await member.screenshot();
  });

  await step("in chat: \"read my calendar from Google Workspace\" picks it, and says where to connect it", async () => {
    const google = (await sourceOf("calendar"))?.options.find((option) => option.name === "Google Workspace");
    expect(google).toBeDefined();
    const said = await world.sayInChat("putMeAgent", { sources: [{ source: "my calendar", connectionId: google?.id }] });
    const reply = memberAgentSavedSchema.parse(said.body).saved?.reply ?? "";
    expect(reply).toMatch(/^Saved:\n- Calendar: reads Google Workspace\nConnect Google Workspace: http.+\nReply "undo" to revert\. My bot: http/);
    await member.reload();
    await member.see({ role: "link", label: "Connect Google Calendar" }, { timeoutMs: 60_000 });
    const calendar = await sourceOf("calendar");
    evidence.recordAssertionEvidence("Chat's reply, and the calendar reads the app chat picked", `${reply.replaceAll("\n", " / ")}; chosen by ${calendar?.chosenBy}`, calendar?.chosenBy === "member" && calendar.connections[0]?.id === google?.id);
    expect(calendar?.chosenBy).toBe("member");
    await member.screenshot();
  });

  await step("the admin's \"not allowed\" holds: chat can't turn the wiki on, and it stays locked", async () => {
    const refused = await world.sayInChat("putMeAgent", { sources: [{ source: "Notion", on: true }] });
    const notion = await sourceOf(wiki.id);
    const message = JSON.stringify(refused.body);
    evidence.recordAssertionEvidence("Refused on the server, with who can change it", `putMeAgent Notion on → refused=${!refused.ok} ${message.slice(0, 160)}; Notion on=${notion?.on}`, !refused.ok && notion?.on === false);
    expect(refused.ok).toBe(false);
    expect(message).toContain("isn't allowed for agents in your organization.");
    await member.see({ text: "Locked sources are set by your admin." });
    await member.screenshot();
  });
});
