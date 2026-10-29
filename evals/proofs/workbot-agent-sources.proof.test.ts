import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { memberAgentSavedSchema, memberAgentViewSchema } from "@openwork/types/den/workbot-proactive";
import { workbotAgentSourcesWorld } from "../worlds/workbot-agent-sources.ts";

const test = spec.world(workbotAgentSourcesWorld, { resources: { surfaces: ["web"], services: ["den", "mock"] }, needs: { placement: "local" }, timeout: 600_000 });

// DESIGN S2 (one row per source: label left, state and its one control right), P4/C5 (a source the admin decided is
// shown locked with the reason and who changes it), P8 (chat's change says how to undo it), C1/C7 (verb-first actions:
// "Connect Gmail", "Edit"; sentence case). Chat is the Connect call Workbot makes for the member.
test("an admin chooses what agents read; a member turns sources on and steers them in chat or on the page, never past the admin", async ({ world, user, probe, step, evidence }) => {
  const owner = user.on(world.owner), ownerProbe = probe.on(world.owner);
  const member = user.on(world.member), memberProbe = probe.on(world.member);
  const agent = async () => memberAgentViewSchema.parse((await memberProbe.api(world.den.members.member, "/v1/me/agent")).body);
  const sourceOf = async (id: string) => (await agent()).sources?.find((source) => source.id === id);
  const { notes, tracker, wiki } = world.connections;

  await step("before: calendar, email and team chat are on for everyone; every other connection is up to members", async () => {
    await owner.see({ text: "What agents read" }, { timeoutMs: 90_000 });
    await owner.click({ text: "Other connections (3)" });
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

  await step("a member's Uses: a switch per source, the wiki locked with the reason, Google waiting for them to connect", async () => {
    await member.reload();
    await member.see({ testId: "my-agent-uses" }, { timeoutMs: 90_000 });
    await member.see({ text: "Not allowed by your admin in Manage › Workbot." });
    await member.see({ text: "On for everyone. Set by your admin in Manage › Workbot." });
    await member.see({ role: "link", label: "Connect Google Calendar" });
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

  await step("the admin's \"not allowed\" holds: chat can't turn the wiki on, and it stays locked", async () => {
    const refused = await world.sayInChat("putMeAgent", { sources: [{ source: "Notion", on: true }] });
    const notion = await sourceOf(wiki.id);
    const message = JSON.stringify(refused.body);
    evidence.recordAssertionEvidence("Refused on the server, with who can change it", `putMeAgent Notion on → refused=${!refused.ok} ${message.slice(0, 160)}; Notion on=${notion?.on}`, !refused.ok && notion?.on === false);
    expect(refused.ok).toBe(false);
    expect(message).toContain("isn't allowed for agents in your organization. An admin can change it in Manage › Workbot.");
    await member.see({ text: "Not allowed by your admin in Manage › Workbot." });
    await member.screenshot();
  });
});
