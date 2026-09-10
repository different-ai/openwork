import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { sessionlessFirstSendWorld } from "../worlds/first-run.ts";

const test = spec.world(sessionlessFirstSendWorld, { timeout: 420_000 });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Engine-native message list, normalized across v1 (array) and v2 ({ data }) bodies. */
function nativeMessages(body: unknown): { role: string; text: string }[] {
  const items = Array.isArray(body) ? body : isRecord(body) && Array.isArray(body.data) ? body.data : [];
  return items.flatMap((message) => {
    if (!isRecord(message)) return [];
    const info = isRecord(message.info) ? message.info : message;
    const parts = Array.isArray(message.parts) ? message.parts : [];
    return [{
      role: typeof info.role === "string" ? info.role : "",
      text: parts.map((part) => isRecord(part) && typeof part.text === "string" ? part.text : "").join("\n"),
    }];
  });
}

function nativeSessionIds(body: unknown): string[] {
  const items = Array.isArray(body) ? body : isRecord(body) && Array.isArray(body.data) ? body.data : [];
  return items.flatMap((session) => isRecord(session) && typeof session.id === "string" ? [session.id] : []).sort();
}

test("Run task on the sessionless New task route creates the session and delivers the first prompt", async ({ world, user, probe, step, evidence }) => {
  const { prompt, engine } = world;
  const persistedPrefix = `${world.sessionlessRoute}/`;
  const readSessions = async () => {
    const response = await probe.desktopApi(world.sessionsPath);
    expect(response.status, world.sessionsPath).toBe(200);
    return nativeSessionIds(response.body);
  };

  await step("the person lands on the sessionless New task route with an empty, editable composer", async () => {
    await world.openNewTask();
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

  const sentAt = Date.now();
  await user.click("Run task");
  const hash = await probe.eventually(() => probe.hash(), {
    within: 30_000,
    label: "navigation to the created session",
    until: (value) => value.startsWith(persistedPrefix) && value.slice(persistedPrefix.length).startsWith("ses_"),
  });
  const sessionId = hash.slice(persistedPrefix.length);
  expect(sessionId).toMatch(/^ses_[^/?#]+$/);

  await step("the prompt is visible in the new thread and the composer is empty", async () => {
    await user.see({ text: prompt }, { timeoutMs: 20_000 });
    const composer = await probe.eventually(() => probe.composer(), {
      within: 20_000,
      label: "composer cleared and one user turn shown",
      until: (state) => state.draftText.trim() === "" && state.userMessageCount === 1,
    });
    expect(composer.route).toBe(`${persistedPrefix}${sessionId}`);
    expect(composer.userMessageCount).toBe(1);
  });

  await step(`the ${engine} engine holds the user prompt for that session`, async () => {
    const path = world.messagesPath(sessionId);
    const messages = await probe.eventually(async () => {
      const response = await probe.desktopApi(path);
      expect(response.status, path).toBe(200);
      return nativeMessages(response.body);
    }, {
      within: 20_000,
      intervalMs: 1_000,
      label: `${engine} engine user message for ${sessionId}`,
      until: (value) => value.some((message) => message.role === "user" && message.text.includes(prompt)),
    });
    expect(messages.filter((message) => message.role === "user" && message.text.includes(prompt))).toHaveLength(1);
    evidence.recordAssertionEvidence(
      `the ${engine} engine received the sessionless first send`,
      `GET ${path} listed a user message containing the prompt ${Date.now() - sentAt}ms after Run task; the thread showed the same prompt once and the composer was empty.`,
      true,
    );
  });

  await step("exactly one session was created and the engine reply arrives in it", async () => {
    const sessionsAfter = await probe.eventually(readSessions, {
      within: 20_000,
      label: "engine session list includes the created session",
      until: (ids) => ids.includes(sessionId),
    });
    expect(sessionsAfter.filter((id) => !sessionsBefore.includes(id))).toEqual([sessionId]);
    await user.see({ text: world.reply }, { timeoutMs: 120_000 });
    expect(await probe.hash()).toBe(`${persistedPrefix}${sessionId}`);
    expect((await probe.composer()).userMessageCount).toBe(1);
  });
});
