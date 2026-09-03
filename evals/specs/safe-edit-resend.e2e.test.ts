import { expect } from "vitest";
import { spec, type Probe } from "@openwork/testkit";
import {
  safeEdit,
  safeEditedPrompt,
  safeFirstPrompt,
  safeLegacyPrompt,
  safeReplies,
  safeSecondPrompt,
} from "../worlds/chat.ts";

type Message = { id: string; role: string; text: string };
type Snapshot = { revertMessageId: string | null; messages: Message[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSnapshot(value: unknown): Snapshot {
  if (!isRecord(value) || !isRecord(value.session) || !Array.isArray(value.messages)) throw new Error("Engine snapshot was malformed.");
  const revertMessageId = isRecord(value.session.revert) && typeof value.session.revert.messageID === "string"
    ? value.session.revert.messageID
    : null;
  const messages = value.messages.flatMap((entry) => {
    if (!isRecord(entry) || !isRecord(entry.info) || typeof entry.info.id !== "string") return [];
    const parts = Array.isArray(entry.parts) ? entry.parts : [];
    return [{
      id: entry.info.id,
      role: typeof entry.info.role === "string" ? entry.info.role : "",
      text: parts.flatMap((part) => isRecord(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : []).join(""),
    }];
  });
  return { revertMessageId, messages };
}

async function snapshot(probe: Probe, workspaceId: string, sessionId: string): Promise<Snapshot> {
  // TODO(primitive): read a local engine session and its messages.
  const value = await probe.eval(`(workspaceId, sessionId) => {
    const port = localStorage.getItem("openwork.server.port");
    const token = localStorage.getItem("openwork.server.token");
    const base = "http://127.0.0.1:" + port + "/workspace/" + encodeURIComponent(workspaceId) + "/opencode/session/" + encodeURIComponent(sessionId);
    const read = (url) => {
      const request = new XMLHttpRequest();
      request.open("GET", url, false);
      request.setRequestHeader("Authorization", "Bearer " + token);
      request.send();
      if (request.status < 200 || request.status >= 300) throw new Error("Engine snapshot failed: " + request.status);
      return JSON.parse(request.responseText);
    };
    return { session: read(base), messages: read(base + "/message") };
  }`, { args: [workspaceId, sessionId] });
  return parseSnapshot(value);
}

async function waitForSnapshot(probe: Probe, workspaceId: string, sessionId: string, label: string, predicate: (value: Snapshot) => boolean) {
  return probe.eventually(
    () => snapshot(probe, workspaceId, sessionId),
    { within: 45_000, intervalMs: 250, label, until: predicate },
  );
}

const test = spec.world(safeEdit, { timeout: 10 * 60_000 });

test("edit resend defers history mutation, rolls back failures, and restores stranded sessions", async ({ world, user, seed, probe, step }) => {
  await user.type("composer", safeFirstPrompt);
  await user.click("Run task");
  await user.see({ text: safeReplies[0] }, { timeoutMs: 120_000 });
  await user.type("composer", safeSecondPrompt);
  await user.click("Run task");
  await user.see({ text: safeReplies[1] }, { timeoutMs: 120_000 });
  const firstSessionId = world.session.sessionId;
  const seeded = await waitForSnapshot(
    probe,
    world.workspace.workspaceId,
    firstSessionId,
    "two-turn seed",
    (value) => value.messages.length === 4 && value.messages.some((message) => message.text === safeReplies[1]),
  );

  await step("editing is non-destructive until send", async () => {
    await user.click({ role: "button", label: "Edit message" });
    await user.see("composer", { text: safeSecondPrompt });
    await user.type("composer", safeEditedPrompt, { replace: true });
    await user.see("composer", { text: safeEditedPrompt });
    const afterEdit = await snapshot(probe, world.workspace.workspaceId, firstSessionId);
    expect(afterEdit.messages.map((message) => message.id)).toEqual(seeded.messages.map((message) => message.id));
    expect(afterEdit.revertMessageId).toBeNull();
    await user.see({ text: safeReplies[0] });
    await user.see({ text: safeReplies[1] });
  });

  // TODO(primitive): fault one local engine prompt request after revert succeeds.
  await seed.evalIn(world.app, `(promptPath) => {
    globalThis.__openworkSafeEditOriginalFetch = globalThis.fetch.bind(globalThis);
    globalThis.__openworkSafeEditFaultCount = 0;
    const original = globalThis.__openworkSafeEditOriginalFetch;
    globalThis.fetch = (input, init) => {
      const url = typeof input === "string" ? input : input instanceof Request ? input.url : String(input);
      const method = input instanceof Request ? input.method : init?.method ?? "GET";
      if (method.toUpperCase() === "POST" && url.includes(promptPath)) {
        globalThis.__openworkSafeEditFaultCount += 1;
        return Promise.resolve(new Response("<html>injected prompt failure</html>", { status: 502, headers: { "content-type": "text/html" } }));
      }
      return original(input, init);
    };
    return true;
  }`, { args: [`/opencode/session/${firstSessionId}/prompt_async`] });
  await user.click("Run task");
  await user.see({ testId: "session-error-card" }, { timeoutMs: 30_000 });
  await user.see({ text: safeReplies[0] });
  await user.see({ text: safeSecondPrompt });
  await user.see({ text: safeReplies[1] });
  // TODO(primitive): read a named fault witness count.
  expect(await probe.eval(`globalThis.__openworkSafeEditFaultCount`)).toBe(1);
  const rolledBack = await waitForSnapshot(
    probe,
    world.workspace.workspaceId,
    firstSessionId,
    "failed edit rollback",
    (value) => value.revertMessageId === null && value.messages.length === seeded.messages.length,
  );
  expect(rolledBack.messages.map((message) => message.id)).toEqual(seeded.messages.map((message) => message.id));
  expect(rolledBack.messages.some((message) => message.text === safeEditedPrompt)).toBe(false);
  expect(world.mainCompletionCount()).toBe(2);

  // TODO(primitive): clear an installed local request fault.
  expect(await seed.evalIn(world.app, `(() => {
    if (typeof globalThis.__openworkSafeEditOriginalFetch !== "function") return false;
    globalThis.fetch = globalThis.__openworkSafeEditOriginalFetch;
    delete globalThis.__openworkSafeEditOriginalFetch;
    delete globalThis.__openworkSafeEditFaultCount;
    return true;
  })()`)).toBe(true);
  await user.click({ role: "button", label: "Dismiss error" });
  await user.click({ role: "button", label: "Edit message" });
  await user.see("composer", { text: safeSecondPrompt });
  await user.type("composer", safeEditedPrompt, { replace: true });
  await user.click("Run task");
  await user.see({ text: safeReplies[2] }, { timeoutMs: 120_000 });
  await user.see({ text: safeEditedPrompt });
  await user.notSee({ text: safeSecondPrompt });
  await user.notSee({ text: safeReplies[1] });
  const replaced = await waitForSnapshot(
    probe,
    world.workspace.workspaceId,
    firstSessionId,
    "successful edited turn",
    (value) => value.revertMessageId === null
      && value.messages.some((message) => message.text.includes(safeEditedPrompt))
      && value.messages.some((message) => message.text === safeReplies[2]),
  );
  expect(replaced.messages.some((message) => message.text === safeSecondPrompt)).toBe(false);
  expect(replaced.messages.some((message) => message.text === safeReplies[1])).toBe(false);
  expect(replaced.messages.some((message) => message.text === safeReplies[0])).toBe(true);
  expect(world.mainCompletionCount()).toBe(3);

  const legacy = await seed.session(world.app, { title: "Legacy restore" });
  expect(legacy.sessionId).not.toBe(firstSessionId);
  await user.type("composer", safeLegacyPrompt);
  await user.click("Run task");
  await user.see({ text: safeReplies[3] }, { timeoutMs: 120_000 });
  const legacySeeded = await waitForSnapshot(
    probe,
    world.workspace.workspaceId,
    legacy.sessionId,
    "legacy session seed",
    (value) => value.messages.length === 2 && value.messages.some((message) => message.text === safeReplies[3]),
  );
  const legacyFirstUser = legacySeeded.messages.find((message) => message.role === "user");
  if (!legacyFirstUser) throw new Error("Legacy seed has no user message.");

  // TODO(primitive): apply a local engine session revert as mid-flow arranged state.
  expect(await seed.evalIn(world.app, `(workspaceId, sessionId, messageId) => {
    const port = localStorage.getItem("openwork.server.port");
    const token = localStorage.getItem("openwork.server.token");
    const request = new XMLHttpRequest();
    request.open("POST", "http://127.0.0.1:" + port + "/workspace/" + encodeURIComponent(workspaceId) + "/opencode/session/" + encodeURIComponent(sessionId) + "/revert", false);
    request.setRequestHeader("Authorization", "Bearer " + token);
    request.setRequestHeader("Content-Type", "application/json");
    request.send(JSON.stringify({ messageID: messageId }));
    return request.status >= 200 && request.status < 300;
  }`, { args: [world.workspace.workspaceId, legacy.sessionId, legacyFirstUser.id] })).toBe(true);
  const stranded = await waitForSnapshot(probe, world.workspace.workspaceId, legacy.sessionId, "legacy stranded cursor", (value) => value.revertMessageId === legacyFirstUser.id);
  expect(stranded.messages).toHaveLength(legacySeeded.messages.length);

  await user.reload();
  await user.see({ testId: "reverted-messages-banner" }, { timeoutMs: 30_000 });
  await user.see({ text: `${legacySeeded.messages.length} earlier messages are hidden` });
  await user.see({ role: "button", text: "Restore" });
  await user.notSee({ text: safeReplies[3] });
  await user.looks([
    `A visible banner says ${legacySeeded.messages.length} earlier messages are hidden and offers a Restore button`,
    "The conversation is not a silent blank state even though its reverted transcript is hidden",
    "No crash dialog is visible",
  ]);
  await user.click({ role: "button", text: "Restore" });
  await user.notSee({ testId: "reverted-messages-banner" });
  await user.see({ text: safeLegacyPrompt });
  await user.see({ text: safeReplies[3] });
  const restored = await waitForSnapshot(
    probe,
    world.workspace.workspaceId,
    legacy.sessionId,
    "engine unreverted",
    (value) => value.revertMessageId === null && value.messages.length === legacySeeded.messages.length,
  );
  expect(restored.messages.map((message) => message.id)).toEqual(legacySeeded.messages.map((message) => message.id));
  await user.looks([
    "The restored conversation visibly contains both the user prompt and deterministic assistant reply",
    "The hidden-messages banner and Restore button are gone",
    "No error or crash dialog is visible",
  ]);
});
