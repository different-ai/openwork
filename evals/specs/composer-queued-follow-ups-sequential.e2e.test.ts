import { expect } from "vitest";
import { spec, type Probe } from "@openwork/testkit";
import {
  queuedSequential,
  sequentialFirstPrompt,
  sequentialQueuedOne,
  sequentialQueuedTwo,
  sequentialReplies,
} from "../worlds/chat.ts";

type Message = { role: string; text: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseMessages(value: unknown): Message[] {
  if (!Array.isArray(value)) throw new Error(`Engine messages were malformed: ${JSON.stringify(value)}`);
  return value.flatMap((entry) => {
    if (!isRecord(entry) || !isRecord(entry.info)) return [];
    const parts = Array.isArray(entry.parts) ? entry.parts : [];
    return [{
      role: typeof entry.info.role === "string" ? entry.info.role : "",
      text: parts.flatMap((part) => isRecord(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : []).join(""),
    }];
  });
}

async function engineMessages(probe: Probe, workspaceId: string, sessionId: string): Promise<Message[]> {
  // TODO(primitive): read local engine messages for a desktop workspace session.
  const value = await probe.eval(`(workspaceId, sessionId) => {
    const port = localStorage.getItem("openwork.server.port");
    const token = localStorage.getItem("openwork.server.token");
    const request = new XMLHttpRequest();
    request.open("GET", "http://127.0.0.1:" + port + "/workspace/" + encodeURIComponent(workspaceId) + "/opencode/session/" + encodeURIComponent(sessionId) + "/message", false);
    request.setRequestHeader("Authorization", "Bearer " + token);
    request.send();
    if (request.status < 200 || request.status >= 300) throw new Error("Engine messages failed: " + request.status);
    return JSON.parse(request.responseText);
  }`, { args: [workspaceId, sessionId] });
  return parseMessages(value);
}

const test = spec.world(queuedSequential, { timeout: 300_000 });

test("queued follow-ups drain as separate FIFO user turns, never one merged message", async ({ world, user, probe, step }) => {
  await step("busy composer has one Stop control and no legacy send split", async () => {
    await user.type("composer", sequentialFirstPrompt);
    await user.click("Run task");
    await probe.eventually(() => world.requests.length, {
      within: 60_000, intervalMs: 200, label: "first completion reached mock", until: (count) => count === 1,
    });
    await user.see({ role: "button", label: "Stop" }, { timeoutMs: 60_000 });
    // TODO(primitive): count busy composer controls and legacy split affordances.
    const controls = await probe.eval(`(() => ({
      stop: document.querySelectorAll('button[aria-label="Stop"]').length,
      run: Boolean(document.querySelector('button[aria-label="Run task"]')),
      queue: Boolean(document.querySelector('button[aria-label="Send when agent finishes"]')),
      steer: [...document.querySelectorAll("button")].some((button) => button.getAttribute("title") === "Send now — the agent will adjust mid-task"),
    }))()`);
    expect(controls).toEqual({ stop: 1, run: false, queue: false, steer: false });
  });

  await step("busy sends queue two follow-ups in FIFO order", async () => {
    await user.type("composer", sequentialQueuedOne);
    await user.click("Run task");
    await user.see({ text: /1 queued/ });
    await user.type("composer", sequentialQueuedTwo);
    await user.click("Run task");
    await user.see({ text: /2 queued/ });
    // TODO(primitive): inspect queued-panel order separately from rendered user bubbles.
    const queued = await probe.eval(`(queuedOne, queuedTwo) => {
      const body = document.body.innerText;
      const bubbles = [...document.querySelectorAll('[data-message-role="user"]')].map((bubble) => bubble.textContent ?? "");
      return {
        first: body.indexOf(queuedOne),
        second: body.indexOf(queuedTwo),
        bubble: bubbles.some((text) => text.includes(queuedOne) || text.includes(queuedTwo)),
      };
    }`, { args: [sequentialQueuedOne, sequentialQueuedTwo] });
    expect(queued).toMatchObject({ bubble: false });
    if (!isRecord(queued) || typeof queued.first !== "number" || typeof queued.second !== "number") throw new Error("Queued order was unavailable.");
    expect(queued.first).toBeGreaterThanOrEqual(0);
    expect(queued.second).toBeGreaterThan(queued.first);
    const whileQueued = await engineMessages(probe, world.workspace.workspaceId, world.session.sessionId);
    expect(whileQueued.filter((message) => message.role === "user")).toHaveLength(1);
    expect(whileQueued.some((message) => message.text.includes(sequentialQueuedOne) || message.text.includes(sequentialQueuedTwo))).toBe(false);
    expect(world.requests).toHaveLength(1);
    await user.looks([
      "A queued messages panel headed '2 queued' lists two queued follow-up messages",
      "The composer's round action button shows a stop control (filled square icon), not an upward send arrow",
      "No error dialog or crash is visible",
    ]);
  });

  await step("idle drain sends only the first queued item", async () => {
    world.releaseFirst();
    await user.see({ text: sequentialReplies[0] }, { timeoutMs: 120_000 });
    await user.see({ text: /1 queued/ }, { timeoutMs: 60_000 });
    await user.see({ text: sequentialQueuedOne });
    // TODO(primitive): distinguish transcript user bubbles from queued-panel text.
    expect(await probe.eval(`(queuedOne) => [...document.querySelectorAll('[data-message-role="user"]')]
      .filter((bubble) => (bubble.textContent ?? "").includes(queuedOne)).length`, { args: [sequentialQueuedOne] })).toBe(1);
    await probe.eventually(() => world.requests.length, {
      within: 60_000, intervalMs: 200, label: "first queued turn reached mock", until: (count) => count === 2,
    });
    expect(world.requests[1]).toEqual({ label: "one", lastUserText: sequentialQueuedOne });
    await user.see({ role: "button", label: "Stop" });
    await user.looks([
      "The conversation shows a user message reading 'Queued follow-up ONE for sequential drain proof.'",
      "A queued messages panel headed '1 queued' still holds the second follow-up",
      "No error dialog or crash is visible",
    ]);
  });

  await step("second queued item drains as its own final turn", async () => {
    world.releaseOne();
    await user.see({ text: sequentialReplies[1] }, { timeoutMs: 120_000 });
    await user.see({ text: sequentialReplies[2] }, { timeoutMs: 120_000 });
    await user.notSee({ text: /\b\d+ queued\b/ });
    const final = await probe.eventually(
      () => engineMessages(probe, world.workspace.workspaceId, world.session.sessionId),
      {
        within: 60_000,
        intervalMs: 250,
        label: "six-message FIFO transcript",
        until: (messages) => messages.length === 6 && messages.some((message) => message.text === sequentialReplies[2]),
      },
    );
    expect(final.map((message) => message.role)).toEqual(["user", "assistant", "user", "assistant", "user", "assistant"]);
    expect(final[0]?.text).toContain(sequentialFirstPrompt);
    expect(final[1]?.text).toBe(sequentialReplies[0]);
    expect(final[2]?.text.trim()).toBe(sequentialQueuedOne);
    expect(final[3]?.text).toBe(sequentialReplies[1]);
    expect(final[4]?.text.trim()).toBe(sequentialQueuedTwo);
    expect(final[5]?.text).toBe(sequentialReplies[2]);
    expect(final.filter((message) => message.text.includes(sequentialQueuedOne) && message.text.includes(sequentialQueuedTwo))).toEqual([]);
    expect(world.requests).toEqual([
      { label: "first", lastUserText: sequentialFirstPrompt },
      { label: "one", lastUserText: sequentialQueuedOne },
      { label: "two", lastUserText: sequentialQueuedTwo },
    ]);
    // TODO(primitive): count separate rendered user bubbles for queued turns.
    expect(await probe.eval(`(queuedOne, queuedTwo) => {
      const bubbles = [...document.querySelectorAll('[data-message-role="user"]')].map((bubble) => bubble.textContent ?? "");
      return {
        one: bubbles.filter((text) => text.includes(queuedOne)).length,
        two: bubbles.filter((text) => text.includes(queuedTwo)).length,
        both: bubbles.filter((text) => text.includes(queuedOne) && text.includes(queuedTwo)).length,
      };
    }`, { args: [sequentialQueuedOne, sequentialQueuedTwo] })).toEqual({ one: 1, two: 1, both: 0 });
    await user.looks([
      "The conversation shows two separate follow-up user messages, ONE before TWO, each followed by its own assistant reply",
      "No queued messages panel is visible anymore",
      "No error dialog or crash is visible",
    ]);
  });
});
