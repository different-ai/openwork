import { spec } from "@openwork/testkit";
import { expect } from "vitest";
import {
  agentSessionSend,
  HOLD_MARKER,
  MOCK_REPLY,
  ORCHESTRATE_MARKER,
  type HandledUiControlItem,
} from "../worlds/agent-session-send.ts";

const test = spec.world(agentSessionSend, { needs: { commands: ["bun"] }, timeout: 300_000 });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sessionIdOf(value: unknown): string {
  if (!isRecord(value) || typeof value.id !== "string") throw new Error(`Expected a created session: ${JSON.stringify(value)}`);
  return value.id;
}

type Transcript = Array<{ id: string; role: string; text: string }>;

function transcript(value: unknown): Transcript {
  if (!Array.isArray(value)) return [];
  return value.flatMap((message) => {
    if (!isRecord(message) || !isRecord(message.info) || !Array.isArray(message.parts)) return [];
    const text = message.parts
      .filter(isRecord)
      .filter((part) => part.type === "text" && part.synthetic !== true)
      .map((part) => (typeof part.text === "string" ? part.text : ""))
      .join("");
    return [{
      id: typeof message.info.id === "string" ? message.info.id : "",
      role: typeof message.info.role === "string" ? message.info.role : "",
      text,
    }];
  });
}

function completedExecuteOutputs(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  const outputs: Record<string, unknown>[] = [];
  for (const message of value) {
    if (!isRecord(message) || !Array.isArray(message.parts)) continue;
    for (const part of message.parts) {
      if (!isRecord(part) || part.type !== "tool" || part.tool !== "openwork_execute" || !isRecord(part.state)) continue;
      if (part.state.status !== "completed" || typeof part.state.output !== "string") continue;
      const parsed: unknown = JSON.parse(part.state.output);
      if (isRecord(parsed)) outputs.push(parsed);
    }
  }
  return outputs;
}

function commands(handled: HandledUiControlItem[]): HandledUiControlItem[] {
  return handled.filter((item) => item.kind === "command");
}

function statusOf(value: unknown, sessionId: string): string {
  if (!isRecord(value)) return "unknown";
  const entry = value[sessionId];
  return isRecord(entry) && typeof entry.type === "string" ? entry.type : "idle";
}

test("an agent messages another session by id while the person keeps looking at a third one, and nothing on screen changes", async ({ world, probe, step, evidence }) => {
  const model = { providerID: "mock", modelID: "mock" };
  const orchestrator = sessionIdOf(await world.engine("POST", "/session", { title: "Orchestrator (session 1)" }));
  const target = sessionIdOf(await world.engine("POST", "/session", { title: "Importer work (session 2)" }));
  const viewed = sessionIdOf(await world.engine("POST", "/session", { title: "What the person is reading (session 3)" }));
  const messages = (sessionId: string) => world.engine("GET", `/session/${encodeURIComponent(sessionId)}/message`);
  const read = async (sessionId: string) => transcript(await messages(sessionId));

  // The person is looking at session 3. The fake window answers context reads
  // and refuses every command, so any attempt to move the pane is recorded.
  const window = await world.attachWindow({
    screen: "session",
    conversations: { layout: { kind: "single", focused: "primary", primarySessionId: viewed }, tabs: [{ sessionId: viewed }] },
    availableAffordances: [],
  });

  try {
    // Session 2 has one earlier turn, so it carries a stored model and a known transcript length.
    await world.engine("POST", `/session/${encodeURIComponent(target)}/message`, { model, parts: [{ type: "text", text: "Start the importer." }] });
    const targetBefore = await read(target);
    expect(targetBefore.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(await read(viewed)).toEqual([]);

    const relay = "Relay from session 1: the archive importer shipped this morning.";
    const first = await step("session 1 sends to session 2 by id; session 2 receives and answers; the window receives no command", async () => {
      world.script.toolCall = { name: "openwork_execute", arguments: { id: "session.send", args: { sessionId: target, text: relay } } };
      const turn = await world.engine("POST", `/session/${encodeURIComponent(orchestrator)}/message`, {
        model,
        parts: [{ type: "text", text: `${ORCHESTRATE_MARKER} Let the importer session know it shipped.` }],
      });
      expect(transcript([turn]).at(-1)?.text).toBe(MOCK_REPLY);

      const outputs = completedExecuteOutputs(await messages(orchestrator));
      expect(outputs).toHaveLength(1);
      const output = outputs[0];
      expect(output).toMatchObject({ ok: true, id: "session.send", effects: { data: "write", ui: "none", external: false } });
      const result = isRecord(output?.result) ? output.result : {};
      expect(result).toMatchObject({ ok: true, accepted: true, sessionId: target, workspaceId: world.workspaceId, title: "Importer work (session 2)" });
      expect(result.revealed).toBeUndefined();
      const messageId = typeof result.messageId === "string" ? result.messageId : "";
      expect(messageId).toMatch(/^msg_[0-9a-f]{26}$/);

      const delivered = await probe.eventually(() => read(target), {
        within: 60_000,
        label: "session 2 holds the relayed user message and its assistant reply",
        until: (value) => value.length === targetBefore.length + 2 && value.at(-1)?.role === "assistant",
      });
      expect(delivered.slice(0, targetBefore.length)).toEqual(targetBefore);
      expect(delivered[targetBefore.length]).toEqual({ id: messageId, role: "user", text: relay });
      expect(delivered.at(-1)?.text).toBe(MOCK_REPLY);
      expect(world.requests.some((request) => request.userText === relay)).toBe(true);

      // Negative half: session 3 stays untouched and the window was never asked to do anything.
      expect(await read(viewed)).toEqual([]);
      expect(commands(window.handled)).toEqual([]);
      evidence.recordAssertionEvidence(
        "session.send reaches a session by id without any UI command",
        `Session 1's openwork_execute(session.send) returned accepted=true, messageId=${messageId}, effects.ui=none; session 2 gained exactly that user message plus a reply; session 3 has no messages; the window's mailbox saw ${commands(window.handled).length} commands.`,
        commands(window.handled).length === 0,
      );
      return { messageId };
    });

    await step("a session that is mid-turn keeps the new message and handles it after its current step, without a rejection", async () => {
      const before = await read(target);
      await world.engine("POST", `/session/${encodeURIComponent(target)}/prompt_async`, {
        model,
        parts: [{ type: "text", text: `${HOLD_MARKER} keep working on the importer.` }],
      });
      await probe.eventually(() => world.engine("GET", "/session/status"), {
        within: 30_000,
        label: "session 2 is busy on a held provider stream",
        until: (value) => statusOf(value, target) === "busy",
      });

      const second = "Second relay from session 1, sent while session 2 is busy.";
      world.script.toolCall = { name: "openwork_execute", arguments: { id: "session.send", args: { sessionId: target, text: second } } };
      const startedAt = Date.now();
      await world.engine("POST", `/session/${encodeURIComponent(orchestrator)}/message`, {
        model,
        parts: [{ type: "text", text: `${ORCHESTRATE_MARKER} Send the second relay.` }],
      });
      const elapsedMs = Date.now() - startedAt;
      const outputs = completedExecuteOutputs(await messages(orchestrator));
      expect(outputs).toHaveLength(2);
      expect(outputs[1]).toMatchObject({ ok: true, id: "session.send", result: { accepted: true, sessionId: target } });

      // Accepted and persisted while session 2 is still busy; the model has not seen it yet.
      const whileBusy = await read(target);
      expect(statusOf(await world.engine("GET", "/session/status"), target)).toBe("busy");
      expect(whileBusy.slice(0, before.length)).toEqual(before);
      expect(whileBusy.filter((message) => message.role === "user").map((message) => message.text)).toEqual([
        ...before.filter((message) => message.role === "user").map((message) => message.text),
        `${HOLD_MARKER} keep working on the importer.`,
        second,
      ]);
      expect(world.requests.some((request) => request.userText === second)).toBe(false);

      world.release();
      const settled = await probe.eventually(() => read(target), {
        within: 60_000,
        label: "session 2 answers the held prompt and then the relay sent while it was busy",
        until: (value) => value.filter((message) => message.role === "assistant").length === before.filter((message) => message.role === "assistant").length + 2,
      });
      expect(settled.at(-1)?.role).toBe("assistant");
      await probe.eventually(() => world.engine("GET", "/session/status"), {
        within: 30_000,
        label: "session 2 returns to idle",
        until: (value) => statusOf(value, target) === "idle",
      });
      expect(world.requests.some((request) => request.userText === second)).toBe(true);
      expect(commands(window.handled)).toEqual([]);
      evidence.recordAssertionEvidence(
        "Sending to a busy session queues into its running turn",
        `The relay was accepted in ${elapsedMs} ms while session 2 was busy, was already in its transcript before its model saw it, and was answered after the held step completed; still no UI command.`,
        elapsedMs < 30_000,
      );
    });

    await step("reveal: true is the explicit opt-in: the message is sent first, then one session.open for session 2 reaches the window on behalf of session 1", async () => {
      const before = await read(target);
      const text = "Third relay: please take a look at this one.";
      world.script.toolCall = { name: "openwork_execute", arguments: { id: "session.send", args: { sessionId: target, text, reveal: true } } };
      await world.engine("POST", `/session/${encodeURIComponent(orchestrator)}/message`, {
        model,
        parts: [{ type: "text", text: `${ORCHESTRATE_MARKER} Send and show me.` }],
      });
      const output = completedExecuteOutputs(await messages(orchestrator))[2];
      // The fake window refuses commands, so the message is delivered, the
      // reveal is reported as not done, and effects.ui stays truthful: nothing moved.
      expect(output).toMatchObject({ ok: true, id: "session.send", effects: { data: "write", ui: "none", external: false }, result: { accepted: true, revealed: false } });
      await probe.eventually(() => read(target), {
        within: 60_000,
        label: "session 2 received the third relay",
        until: (value) => value.some((message) => message.role === "user" && message.text === text),
      });
      expect(commands(window.handled).map((item) => item.input)).toEqual([
        { id: "session.open", args: { sessionId: target }, origin: expect.objectContaining({ sessionId: orchestrator }) },
      ]);
      expect((await read(target)).slice(0, before.length)).toEqual(before);
      evidence.recordAssertionEvidence(
        "UI change is an explicit opt-in",
        "Only with reveal: true did exactly one session.open for session 2 reach the window, stamped with session 1 as origin, after the message was already written.",
        commands(window.handled).length === 1,
      );
    });

    await step("an unknown session id is refused before anything reaches the engine or the window", async () => {
      const targetBefore = await read(target);
      world.script.toolCall = { name: "openwork_execute", arguments: { id: "session.send", args: { sessionId: "ses_does_not_exist", text: "lost" } } };
      await world.engine("POST", `/session/${encodeURIComponent(orchestrator)}/message`, {
        model,
        parts: [{ type: "text", text: `${ORCHESTRATE_MARKER} Message a session that does not exist.` }],
      });
      const output = completedExecuteOutputs(await messages(orchestrator))[3];
      expect(output).toMatchObject({ ok: false, id: "session.send", code: "failed" });
      expect(String(output?.error)).toContain("ses_does_not_exist");
      expect(await read(target)).toEqual(targetBefore);
      expect(await read(viewed)).toEqual([]);
      expect(commands(window.handled)).toHaveLength(1);
    });
  } finally {
    await window.detach();
  }
});
