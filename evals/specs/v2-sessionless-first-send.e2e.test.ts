import { expect } from "vitest";
import { resolveEvalEngine, spec } from "@openwork/testkit";
import { sessionlessFirstSendWorld } from "../worlds/first-run.ts";

const test = spec.world(sessionlessFirstSendWorld, {
  timeout: 420_000,
  needs: { env: ["OPENWORK_EVAL_ENGINE"] },
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textOf(value: unknown): string {
  return isRecord(value) && typeof value.text === "string" ? value.text : "";
}

function nativeItems(body: unknown): unknown[] {
  if (Array.isArray(body)) return body;
  if (isRecord(body) && Array.isArray(body.data)) return body.data;
  throw new Error(`Unexpected native list: ${JSON.stringify(body)}`);
}

/**
 * Engine-native message list, normalized the way the app reads each engine:
 * v1 returns an array of `{ info: { role }, parts: [{ text }] }`; v2 returns
 * `{ data: [{ role | type, content: [{ text }] | text }] }`.
 */
function nativeMessages(body: unknown): { role: string; text: string }[] {
  return nativeItems(body).flatMap((message) => {
    if (!isRecord(message)) return [];
    const info = isRecord(message.info) ? message.info : message;
    const role = typeof info.role === "string" ? info.role : typeof info.type === "string" ? info.type : "";
    const parts = Array.isArray(message.parts) ? message.parts : Array.isArray(message.content) ? message.content : [message];
    return [{ role, text: parts.map(textOf).join("\n") }];
  });
}

function nativeSessionIds(body: unknown): string[] {
  return nativeItems(body).flatMap((session) => isRecord(session) && typeof session.id === "string" ? [session.id] : []).sort();
}

test(`${resolveEvalEngine()}: Run task on the sessionless New task route creates the session and delivers the first prompt`, async ({ world, user, probe, step, evidence }) => {
  const { prompt, engine } = world;
  const persistedPrefix = `${world.sessionlessRoute}/`;
  const readSessions = async () => {
    const response = await probe.desktopApi(world.sessionsPath);
    expect(response.status, world.sessionsPath).toBe(200);
    return nativeSessionIds(response.body);
  };

  await step("the person lands on the sessionless New task route with an empty, editable composer", async () => {
    await world.openNewTask();
    const routing = await probe.desktopApi("/experimental/engine-v2-preview/status");
    expect(routing.status).toBe(200);
    expect(routing.body).toMatchObject({ chatRouting: engine === "v2" });
    if (engine === "v2") expect(routing.body).toMatchObject({ enabled: true, running: true });
    expect(await probe.hash()).toBe(world.sessionlessRoute);
    await user.see("composer", { editable: true });
    const composer = await probe.eventually(() => probe.composer(), {
      within: 60_000,
      label: "empty New task composer with its model ready",
      until: (state) => state.composerEditable && state.draftText.trim() === "" && !state.modelUnavailable,
    });
    expect(composer.userMessageCount).toBe(0);
  });
  const sessionsBefore = await readSessions();

  await step("typing a prompt enables Run task", async () => {
    await user.type("composer", prompt);
    await user.see("composer", { text: prompt });
    const composer = await probe.eventually(() => probe.composer(), {
      within: 30_000,
      label: "enabled Run task",
      until: (state) => state.runTaskEnabled && state.draftText.trim() === prompt,
    });
    expect(composer.route).toBe(world.sessionlessRoute);
  });

  await user.click("Run task");
  const hash = await probe.eventually(() => probe.hash(), {
    within: 30_000,
    label: "navigation to the created session",
    until: (value) => value.startsWith(persistedPrefix) && value.slice(persistedPrefix.length).startsWith("ses_"),
  });
  const sessionId = hash.slice(persistedPrefix.length);
  expect(sessionId).toMatch(/^ses_[^/?#]+$/);

  await step(`the ${engine} first send clears the composer and reaches both thread and engine`, async () => {
    await user.see("composer", { text: "" });
    // Observe BOTH boundaries even on a regression: a missing visible message
    // must not short-circuit the native probe and hide the empty engine list.
    const path = world.messagesPath(sessionId);
    const [visible, native] = await Promise.allSettled([
      user.see({ text: prompt }, { timeoutMs: 20_000 }),
      probe.eventually(() => probe.desktopApi(path), {
        within: 20_000,
        intervalMs: 1_000,
        label: `${engine} engine user message for ${sessionId}`,
        until: (response) => response.status === 200 && nativeMessages(response.body)
          .some((message) => message.role === "user" && message.text.includes(prompt)),
      }),
    ]);
    for (const [boundary, result] of [["thread", visible], ["engine", native]] satisfies [string, PromiseSettledResult<unknown>][]) {
      evidence.recordAssertionEvidence(
        `${engine} sessionless first prompt reaches the ${boundary}`,
        result.status === "fulfilled" ? `The ${boundary} retained the submitted prompt.` : String(result.reason),
        result.status === "fulfilled",
      );
    }
    expect(visible.status, "prompt visible outside the empty composer").toBe("fulfilled");
    if (native.status === "rejected") throw native.reason;
    const messages = nativeMessages(native.value.body);
    expect(messages.filter((message) => message.role === "user" && message.text.includes(prompt))).toHaveLength(1);
    const composer = await probe.composer();
    expect(composer.route).toBe(`${persistedPrefix}${sessionId}`);
    expect(composer.draftText.trim()).toBe("");
    expect(composer.userMessageCount).toBe(1);
  });

  await step("exactly one session was created and the engine reply arrives in it", async () => {
    await user.see({ text: world.reply }, { timeoutMs: 120_000 });
    expect(await readSessions()).toEqual([...sessionsBefore, sessionId].sort());
    expect(await probe.hash()).toBe(`${persistedPrefix}${sessionId}`);
    expect((await probe.composer()).userMessageCount).toBe(1);
    evidence.recordAssertionEvidence(
      `${engine} creates exactly one session without replaying the first send`,
      "After the real engine reply, the session inventory is the original inventory plus exactly the routed session; one user row remains and the composer is empty.",
      true,
    );
  });
});
