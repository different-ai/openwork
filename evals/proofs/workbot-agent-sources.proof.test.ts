import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { agentSourcesPolicySchema, memberAgentSavedSchema, memberAgentViewSchema } from "@openwork/types/den/workbot-proactive";
import { workbotAgentSourcesWorld } from "../worlds/workbot-agent-sources.ts";

const test = spec.world(workbotAgentSourcesWorld, { resources: { surfaces: ["web"], services: ["den", "mock"] }, needs: { placement: "local" }, timeout: 600_000 });

// DESIGN S2 (one row per source: label left, state and its one control right), S7 (Add source and the member's app picker
// are Base UI popovers), P1 (state, not explanation: "Members use Google Workspace or Granola", "Read on checks; no early
// meeting alerts"), P4/C5 (a source the admin decided is shown locked with the reason and who changes it), P8 (chat's change
// says how to undo it), V5 (a category shows its generic icon, each app its logo), C1/C7 (verb-first actions: "Connect
// Gmail", "Make default"; sentence case). Chat is the Connect call Workbot makes for the member.
test("an admin sets guardrails for what agents read; a member picks within them and steers sources in chat or on the page, never past the admin", async ({ world, user, probe, step, evidence }) => {
  const owner = user.on(world.owner), ownerProbe = probe.on(world.owner);
  const member = user.on(world.member), memberProbe = probe.on(world.member);
  const agent = async () => memberAgentViewSchema.parse((await memberProbe.api(world.den.members.member, "/v1/me/agent")).body);
  const sourceOf = async (id: string) => (await agent()).sources?.find((source) => source.id === id);
  const { notes, tracker, wiki, desk } = world.connections;

  await step("before: calendar, email and team chat are on for everyone; Other context lists the reviewed services, up to members", async () => {
    await owner.see({ text: "What agents read" }, { timeoutMs: 90_000 });
    await owner.see({ text: "Other context" });
    await owner.see({ role: "button", label: "Remove Granola from Other context" });
    await owner.see({ text: "Read only. Agents never send, edit or delete through these." });
    const policy = await world.policy();
    const defaults = JSON.stringify({ calendar: "everyone", email: "everyone", chat: "everyone", connections: {} });
    evidence.recordAssertionEvidence("The defaults", `GET /v1/org/workbot-settings/proactive sources: ${JSON.stringify(policy)} (other connections: members choose)`, JSON.stringify(policy) === defaults);
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

  await step("the owner allows Granola for Email; Support desk, a service without reviewed reads, isn't offered", async () => {
    await owner.click({ role: "button", label: "Add source to Email" });
    await owner.see({ role: "menuitem", label: "Granola" }, { timeoutMs: 30_000 });
    await owner.notSee({ role: "menuitem", label: "Support desk" });
    await owner.screenshot();
    await owner.click({ role: "menuitem", label: "Granola" });
    const policy = await ownerProbe.eventually(() => world.policy(), {
      within: 30_000,
      label: "Email reads through Granola too",
      until: (value) => agentSourcesPolicySchema.safeParse(value).data?.coreConnections?.email?.includes(notes.id) === true,
    });
    const saved = agentSourcesPolicySchema.parse(policy);
    const reads = saved.coreConnections?.email?.includes(notes.id) === true && saved.coreConnections.email.includes(desk.id) === false;
    evidence.recordAssertionEvidence("Saved on the server", `email allows: ${saved.coreConnections?.email?.join(", ")}`, reads);
    expect(reads).toBe(true);
    await owner.see({ role: "switch", label: "Allow Granola" });
    await owner.see({ text: "Members use Google Workspace or Granola" });
    await owner.see({ role: "button", label: "Make Granola the default for Email" });
    await owner.screenshot();
  });

  await step("a member's What it reads: email reads the app they already have, the wiki locked with the reason, Google Calendar waiting for them to connect", async () => {
    await member.reload();
    await member.see({ testId: "my-agent-uses" }, { timeoutMs: 90_000 });
    await member.see({ text: "Not allowed" });
    await member.see({ text: "Locked sources are set by your admin in Manage › Workbot." });
    await member.see({ role: "link", label: "Connect Google Calendar" });
    await member.see({ role: "button", label: "Read your email from: Granola" });
    await member.notSee({ role: "link", label: "Connect Gmail" });
    const email = await sourceOf("email");
    evidence.recordAssertionEvidence(
      "Email reads one allowed app, never asking for the other",
      `email reads ${email?.connections.map((connection) => connection.name).join(", ")} (chosen ${email?.chosenBy}) of ${email?.options.map((option) => option.name).join(", ")}`,
      email?.connections.length === 1 && email.connections[0]?.id === notes.id && email.options.length === 2,
    );
    expect(email?.connections.map((connection) => connection.id)).toEqual([notes.id]);
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

  await step("in chat: \"read my email from Google Workspace\" picks it among the allowed apps, and says where to connect it", async () => {
    const google = (await sourceOf("email"))?.options.find((option) => option.name === "Google Workspace");
    expect(google).toBeDefined();
    const said = await world.sayInChat("putMeAgent", { sources: [{ source: "my email", connectionId: google?.id }] });
    const reply = memberAgentSavedSchema.parse(said.body).saved?.reply ?? "";
    expect(reply).toMatch(/^Saved:\n- Email: reads Google Workspace\nConnect Google Workspace: http.+\nReply "undo" to revert\. My bot: http/);
    await member.reload();
    await member.see({ role: "button", label: "Read your email from: Google Workspace" }, { timeoutMs: 60_000 });
    await member.see({ role: "link", label: "Connect Gmail" });
    const email = await sourceOf("email");
    evidence.recordAssertionEvidence("Chat's reply, and the page reads email from the app chat picked", `${reply.replaceAll("\n", " / ")}; chosen by ${email?.chosenBy}`, email?.chosenBy === "member" && email.connections[0]?.id === google?.id);
    await member.screenshot();
  });

  await step("the admin's \"not allowed\" holds: chat can't turn the wiki on, and it stays locked", async () => {
    const refused = await world.sayInChat("putMeAgent", { sources: [{ source: "Notion", on: true }] });
    const notion = await sourceOf(wiki.id);
    const message = JSON.stringify(refused.body);
    evidence.recordAssertionEvidence("Refused on the server, with who can change it", `putMeAgent Notion on → refused=${!refused.ok} ${message.slice(0, 160)}; Notion on=${notion?.on}`, !refused.ok && notion?.on === false);
    expect(refused.ok).toBe(false);
    expect(message).toContain("isn't allowed for agents in your organization. An admin can change it in Manage › Workbot.");
    await member.see({ text: "Locked sources are set by your admin in Manage › Workbot." });
    await member.screenshot();
  });
});
