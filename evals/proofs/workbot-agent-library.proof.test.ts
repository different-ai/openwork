import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { memberAgentSavedSchema, memberAgentViewSchema } from "@openwork/types/den/workbot-proactive";
import { workbotAgentLibraryWorld } from "../worlds/workbot-agent-library.ts";

const test = spec.world(workbotAgentLibraryWorld, { resources: { surfaces: ["web"], services: ["den"] }, needs: { placement: "local" }, timeout: 600_000 });

const CLOCK = String.raw`\d{1,2}:\d{2} [AP]M`;

// DESIGN P1 (state, not explanation), P4/C5 (locked with the reason and who changes it), P7 (one focal line),
// P8 (Undo, no confirm), S2/S3 (compact rows, "Earlier this week" collapsed). Chat is the Connect call Workbot makes.
test("a member sees what their agent did and why it stayed quiet, and changes it in chat or in the Library", async ({ world, user, probe, step, evidence }) => {
  const agent = async () => memberAgentViewSchema.parse((await probe.api(world.den.members.member, "/v1/me/agent")).body);
  const checked = (testId: string) => probe.dom(`[data-testid="${testId}"] button[role="switch"][aria-checked="true"]`);

  await step("before: with Your agent off, the sidebar has no agent and its API and chat refuse access", async () => {
    await user.see({ role: "heading", label: "My Library" }, { timeoutMs: 90_000 });
    await user.notSee({ testId: "dashboard-nav-my-bot" });
    await user.notSee({ testId: "my-agent-row" });
    const hidden = await probe.api(world.den.members.member, "/v1/me/agent");
    const said = await world.sayInChat("putMeAgent", { preferences: { when: "Mornings only" } });
    evidence.recordAssertionEvidence(
      "Your agent is off: its API and chat changes are refused",
      `GET /v1/me/agent status=${hidden.response.status}; putMeAgent with words → refused=${!said.ok} ${JSON.stringify(said.body).slice(0, 90)}`,
      hidden.response.status === 404 && !said.ok,
    );
    expect(hidden.response.status).toBe(404);
    expect(said.ok).toBe(false);
    await user.screenshot();
  });

  await step("after: My bot appears in the Work sidebar, not in the Library, and reads the agent's own records", async () => {
    await world.turnOnMyAgent();
    await user.reload();
    await user.see({ testId: "dashboard-nav-my-bot" }, { timeoutMs: 60_000 });
    await user.see({ role: "tab", label: "All" });
    await user.notSee({ testId: "my-agent-row" });
    const view = await agent();
    evidence.recordAssertionEvidence(
      "My bot is a Work destination; its page reads the agent's own records",
      `sidebar has My bot; Library row absent; last check: ${view.lastCheck?.summary}; ${view.sentToday} of ${view.limits?.dailyCap} sent today; ${view.todayChecks?.length} checks today`,
      view.lastCheck?.reason === "nothing_new" && view.sentToday === 1 && view.todayChecks?.length === 2,
    );
    expect(view.lastCheck?.reason).toBe("nothing_new");
    await user.screenshot();
  });

  await step("the member opens it: the last check and why, today's checks with Sent and Quiet, what it tells them about, uses and limits", async () => {
    await user.click({ testId: "dashboard-nav-my-bot" });
    await user.see({ testId: "my-agent-screen" }, { timeoutMs: 30_000 });
    await user.see({ role: "switch", label: "My bot" });
    await user.see({ role: "heading", label: new RegExp(`^Last check at ${CLOCK}$`) });
    await user.see({ text: new RegExp(`^Next check `) });
    await user.see({ text: "1 of 3 sent today" });
    await user.see({ role: "link", label: "Open in Slack" });
    await user.see({ text: "Sent you a message about morning brief." });
    await user.see({ text: "Turned off by your admin in Manage › Workbot." });
    await user.see({ text: "Set by your admin in Manage › Workbot." });
    const rows = await probe.dom('[data-testid="my-agent-today"] [data-testid="my-agent-check"]');
    const sent = await probe.dom('[data-testid="my-agent-today"] [data-outcome="sent"]');
    const quiet = await probe.dom('[data-testid="my-agent-today"] [data-outcome="quiet"]');
    evidence.recordAssertionEvidence("Today's checks, each with what happened and a pill", `${rows.elements.length} rows: ${quiet.elements.map((element) => element.text).join("; ")} | ${sent.elements.map((element) => element.text).join("; ")}`, rows.elements.length === 2 && sent.elements.length === 1 && quiet.elements.length === 1);
    expect([rows.elements.length, sent.elements.length, quiet.elements.length]).toEqual([2, 1, 1]);
    await user.screenshot();
  });

  await step("earlier this week opens on request, with a failure that says what to do", async () => {
    await user.click({ text: "Earlier this week" });
    await user.see({ text: "Couldn't read Gmail: reconnect Google." }, { timeoutMs: 30_000 });
    await user.see({ text: "Waited: only urgent messages 12 PM–2 PM. Held a message about calendar changes." });
    const earlier = await probe.dom('[data-testid="my-agent-earlier"] [data-testid="my-agent-check"]');
    evidence.recordAssertionEvidence("This week's earlier checks load when opened", `${earlier.elements.length} earlier checks: failed (reconnect Google), waited (only-urgent window)`, earlier.elements.length === 2);
    expect(earlier.elements.length).toBe(2);
    await user.screenshot();
  });

  await step("in chat, \"why so quiet?\" is answered from the same records the page shows", async () => {
    const said = await world.sayInChat("getMeAgent");
    const view = memberAgentViewSchema.parse(said.body);
    await user.see({ text: view.lastCheck?.summary ?? "(none)" });
    evidence.recordAssertionEvidence("getMeAgent's last check is the page's focal sentence", `lastCheck: ${view.lastCheck?.headline} (${view.lastCheck?.reason}) at ${view.lastCheck?.at}; "${view.lastCheck?.summary}"`, view.lastCheck?.summary === "Stayed quiet: nothing new.");
    expect(view.lastCheck?.summary).toBe("Stayed quiet: nothing new.");
  });

  await step("in chat: \"between 12 and 2 only urgent stuff, stop telling me about calendar changes\" saves exactly that, with undo and a link", async () => {
    const said = await world.sayInChat("putMeAgent", { preferences: { when: "Between 12 and 2, only urgent things" }, quietWindow: { startHour: 12, endHour: 14 }, mute: ["calendar_changes"] });
    const reply = memberAgentSavedSchema.parse(said.body).saved?.reply ?? "";
    await user.reload();
    await user.see({ testId: "my-agent-change-when" }, { timeoutMs: 30_000 });
    await user.see({ text: "12 PM–2 PM" });
    const muted = await probe.dom('[data-testid="my-agent-calendar_changes"] button[role="switch"][aria-checked="false"]');
    const sources = await probe.dom('[data-source="chat"]');
    evidence.recordAssertionEvidence("Chat's reply says what it saved; the page shows it saved from chat", `${reply.replaceAll("\n", " / ")}; calendar changes off on the page=${muted.elements.length === 1}; ${sources.elements.length} fields say "Saved from chat"`, /Reply "undo" to revert\. My bot: http/.test(reply) && muted.elements.length === 1);
    expect(reply).toMatch(/^Saved:\n- When: “Between 12 and 2, only urgent things”\n- Stopped: Calendar changes\n- Only urgent messages 12 PM–2 PM\nReply "undo" to revert\. My bot: http/);
    expect(muted.elements.length).toBe(1);
    await user.screenshot();
  });

  await step("after: Undo on the page turns calendar changes back on, and chat sees it", async () => {
    await user.click({ role: "button", label: "Undo Stopped: Calendar changes" });
    await probe.eventually(() => checked("my-agent-calendar_changes"), { within: 30_000, until: (value) => value.elements.length === 1, label: "calendar changes are back on" });
    const view = memberAgentViewSchema.parse((await world.sayInChat("getMeAgent")).body);
    const calendar = view.responsibilities.find((entry) => entry.id === "calendar_changes");
    evidence.recordAssertionEvidence("The page's Undo reverts one change; chat reads the same agent", `calendar changes muted=${calendar?.muted}; "When" still "${view.preferences?.when}"; quiet window ${JSON.stringify(view.limits?.quietWindow)}`, calendar?.muted === false && view.preferences?.when !== "");
    expect(calendar?.muted).toBe(false);
    await user.screenshot();
  });

  await step("a member can't widen the admin's limits, and another member sees none of this", async () => {
    const wider = await world.sayInChat("putMeAgent", { dailyCap: 5 });
    const owner = memberAgentViewSchema.parse((await probe.api(world.den.admin, "/v1/me/agent")).body);
    const leaked = (owner.todayChecks ?? []).some((entry) => entry.summary === "Sent you a message about morning brief.") || owner.preferences?.when !== "";
    await user.see({ text: "3 a day" });
    evidence.recordAssertionEvidence("Wider is refused; the owner's agent shows nothing of the member's", `putMeAgent dailyCap 5 → refused=${!wider.ok} ${JSON.stringify(wider.body).slice(0, 110)}; owner's checks or words leak=${leaked}`, !wider.ok && !leaked);
    expect(wider.ok).toBe(false);
    expect(leaked).toBe(false);
    await user.screenshot();
  });
});
