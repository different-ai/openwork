import { expect } from "vitest";
import { browserScript } from "@openwork/cdp";
import { spec } from "@openwork/testkit";
import { abandonedQuestion } from "../worlds/chat.ts";

// OpenCode 1.18 marks a stopped question tool call as errored but never
// publishes question.rejected, and the abandoned request can stay listed by
// GET /question. The app must stop asking the user for an answer nobody can
// consume, and Archive must not treat that leftover as open work.

const test = spec.world(abandonedQuestion, { timeout: 600_000 });

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Expected a native engine object");
  return value;
}

function records(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error("Expected a native engine list");
  return value.map(record);
}

test("a question abandoned by a stopped, superseded turn stops needing the user and lets the session archive", async ({ world, user, agent, probe, step }) => {
  const { sessionId } = world.session;
  const mount = `/workspace/${encodeURIComponent(world.workspace.workspaceId)}/opencode`;
  const read = async (path: string): Promise<unknown> => {
    const result = await probe.desktopApi(`${mount}${path}`);
    expect(result.status, path).toBe(200);
    return result.body;
  };
  const pendingQuestions = async () => records(await read("/question")).filter((request) => request.sessionID === sessionId);
  const questionToolStates = async () => records(await read(`/session/${encodeURIComponent(sessionId)}/message?limit=50`))
    .flatMap((message) => records(message.parts))
    .filter((part) => part.type === "tool" && part.tool === "question")
    .map((part) => record(part.state).status);
  // TODO(primitive): read the sidebar row's attention indicator through a first-class primitive.
  const attention = () => probe.eval(browserScript((id) => {
    const row = document.querySelector<HTMLElement>('[data-sidebar-session-id="' + id + '"]');
    const dot = row?.querySelector<HTMLElement>("[data-session-attention-indicator]");
    return dot instanceof HTMLElement ? dot.title : null;
  }, [sessionId]));

  await step("a real question asks for the user's answer", async () => {
    await user.click({ text: world.session.title });
    await probe.eventually(() => probe.hash(), { within: 30_000, label: "the seeded conversation is selected",
      until: (hash) => hash.includes(`/session/${sessionId}`) });
    await user.type("composer", world.ask.prompt, { verify: true });
    await user.press("Enter");
    await user.see({ text: world.ask.question }, { timeoutMs: 45_000 });
    await probe.eventually(attention, { within: 15_000, label: "the sidebar marks the conversation as waiting for the user",
      until: (title) => title === "Waiting" });
    expect(await pendingQuestions()).toHaveLength(1);
    expect(await questionToolStates()).toEqual(["running"]);
    await user.screenshot();
  });

  await step("stopping the turn and sending a follow-up abandon the question without any rejection event", async () => {
    // The same engine calls another agent makes: stop, then prompt again.
    const abort = await agent.desktopApi(`${mount}/session/${encodeURIComponent(sessionId)}/abort`, { method: "POST" });
    expect(abort.status).toBe(200);
    const prompt = await agent.desktopApi(`${mount}/session/${encodeURIComponent(sessionId)}/prompt_async`, {
      method: "POST", body: { parts: [{ type: "text", text: world.followup.prompt }] },
    });
    expect([200, 204]).toContain(prompt.status);
    await user.see({ text: world.followup.reply }, { timeoutMs: 60_000 });
    const states = await probe.eventually(questionToolStates, { within: 15_000, label: "the engine records the question tool call as ended",
      until: (states) => states.length === 1 && states[0] !== "running" && states[0] !== "pending" });
    expect(states).toEqual([expect.stringMatching(/^(error|completed)$/)]);
    await probe.eventually(() => read("/session/status"), { within: 15_000, label: "the engine reports the conversation idle",
      until: (statuses) => record(statuses)[sessionId] === undefined || record(record(statuses)[sessionId]).type === "idle" });
    // Whether the engine still lists the request is the upstream defect under
    // observation, not this claim; record it for the evidence.
    console.info(`[abandoned-question] engine still lists the abandoned request: ${(await pendingQuestions()).length > 0}`);
  });

  await step("the conversation stops needing the user within seconds", async () => {
    await user.notSee({ text: world.ask.question }, { timeoutMs: 15_000 });
    await probe.eventually(attention, { within: 15_000, label: "the sidebar no longer marks the conversation as waiting",
      until: (title) => title !== "Waiting" });
    await user.see("composer", { editable: true });
    await user.screenshot();
  });

  await step("archiving succeeds without the stop-and-archive confirmation", async () => {
    await user.hover({ testId: `sidebar-session-${sessionId}` });
    await user.click({ testId: `session-archive-${sessionId}` });
    await user.see({ text: "Session archived" }, { timeoutMs: 30_000 });
    await user.notSee({ text: "This session is still working" });
    await probe.eventually(() => read(`/session/${encodeURIComponent(sessionId)}`), { within: 15_000, label: "the engine records the archive",
      until: (session) => typeof record(record(session).time).archived === "number" });
    await user.screenshot();
  });
});
