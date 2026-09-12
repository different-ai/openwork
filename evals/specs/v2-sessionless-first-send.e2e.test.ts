import { expect } from "vitest";
import { resolveEvalEngine, spec } from "@openwork/testkit";
import { sessionlessFirstSendWorld } from "../worlds/first-run.ts";

const test = spec.world(sessionlessFirstSendWorld, {
  timeout: 420_000,
  resources: { surfaces: ["appWeb"], services: ["mock"] },
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
    const response = await world.readNative(world.sessionsPath);
    expect(response.status, world.sessionsPath).toBe(200);
    return nativeSessionIds(response.body);
  };

  await step("the person lands on the sessionless New task route with an empty, editable composer", async () => {
    await world.openNewTask();
    const routing = await world.readNative("/experimental/engine-v2-preview/status");
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

  for (const newerDraft of ["", "Keep this newer continuation intact."]) {
    await step(newerDraft ? "creation failure preserves a newer draft and guards restoration of the unsent prompt" : "creation failure restores the unsent prompt without creating a session", async () => {
      await user.type("composer", prompt);
      await using rejected = await world.transition();
      evidence.recordJsonArtifact("Creation failure recording", { engine, newerDraft: Boolean(newerDraft), path: rejected.filmPath });
      await user.press("Enter");
      await probe.eventually(() => rejected.read(), {
        within: 10_000, label: "creation held before rejection", until: (state) => state.held === 1,
      });
      if (newerDraft) await user.type("composer", newerDraft);
      await rejected.fail();
      const recovered = await probe.eventually(async () => ({ composer: await probe.composer(), recovery: await world.recovery() }), {
        within: 15_000, label: "failed creation preserves editable content and exposes its error",
        until: (state) => state.composer.composerEditable && state.composer.draftText === (newerDraft || prompt)
          && !state.recovery.starting && state.recovery.error.length > 0,
      });
      evidence.recordJsonArtifact("Creation failure restoration", recovered);
      expect(recovered.composer.route).toBe(world.sessionlessRoute);
      expect(recovered.composer.userMessageCount).toBe(0);
      expect(recovered.recovery.restoreVisible).toBe(Boolean(newerDraft));
      expect(recovered.recovery.restoreDisabled).toBe(Boolean(newerDraft));
      expect(rejected.read()).toMatchObject({ creation: 1, prompt: 0, expired: false });
      expect(await readSessions()).toEqual(sessionsBefore);
      expect(await world.requests()).toHaveLength(0);
      await user.screenshot();
      await user.click({ placeholder: "Describe your task..." });
      await user.press(world.app.handle.hostKind !== "daytona" && process.platform === "darwin" ? "Meta+A" : "Control+A");
      await user.press("Backspace");
      if (newerDraft) {
        await user.click({ role: "button", label: "Clear the current draft to restore the unsent message" });
        await user.see("composer", { text: prompt, editable: true });
        expect((await world.recovery()).restoreVisible).toBe(false);
        await user.screenshot();
        await user.click({ placeholder: "Describe your task..." });
        await user.press(world.app.handle.hostKind !== "daytona" && process.platform === "darwin" ? "Meta+A" : "Control+A");
        await user.press("Backspace");
      }
      expect((await probe.composer()).draftText).toBe("");
      evidence.recordAssertionEvidence("Rejected creation retains recoverable content without admitting a session or prompt",
        newerDraft ? "Newer draft remains editable; restoration stays disabled until it is cleared, then restores the original prompt exactly." : "Original prompt is restored automatically; no session or provider request is created.", true);
    });
  }

  await user.reload();
  await user.see("composer", { text: "", editable: true });
  expect((await world.recovery()).error).toBe("");
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

  await using transition = await world.transition();
  evidence.recordJsonArtifact("Sessionless transition recording", { engine, path: transition.filmPath });
  await user.screenshot();
  await user.press("Enter");
  await user.press("Enter");
  await step("slow session creation keeps Starting above an unmoved hero composer without a temporary user row", async () => {
    await probe.eventually(() => transition.read(), {
      within: 10_000, label: "one held session creation", until: (state) => state.held === 1,
    });
    const samples = await probe.eventually(() => transition.samples(), {
      within: 10_000, label: "Starting sampled across the slow creation interval",
      until: (values) => {
        const starting = values.filter((sample) => sample.starting && sample.source === "raf");
        return starting.length >= 20 && starting[starting.length - 1]!.elapsed - starting[0]!.elapsed >= 1500;
      },
    }).finally(async () => {
      evidence.recordJsonArtifact("Immediate sessionless RAF and mutation observations", await transition.samples());
    });
    await user.screenshot();
    expect(transition.read()).toMatchObject({ creation: 1, prompt: 0, held: 1, expired: false });
    const baseline = samples[0]!;
    expect(baseline.width).toBeGreaterThan(0);
    expect(baseline.height).toBeGreaterThan(0);
    expect(samples.some((sample) => sample.source === "mutation" && sample.starting)).toBe(true);
    expect(samples.slice(samples.findIndex((sample) => sample.starting)).every((sample) => sample.starting)).toBe(true);
    expect(samples.every((sample) => sample.users === 0)).toBe(true);
    for (const sample of samples) {
      expect(sample.route).toBe(world.sessionlessRoute);
      expect(Math.abs(sample.top - baseline.top)).toBeLessThanOrEqual(1);
      expect(Math.abs(sample.left - baseline.left)).toBeLessThanOrEqual(1);
      expect(Math.abs(sample.width - baseline.width)).toBeLessThanOrEqual(1);
      expect(Math.abs(sample.height - baseline.height)).toBeLessThanOrEqual(1);
    }
    evidence.recordAssertionEvidence("Slow creation preserves hero layout without a temporary user bubble",
      `${samples.length} immediate RAF/mutation observations preserve the editor rect within one pixel and contain zero user rows; Starting persists for at least 1500ms; duplicate Enter admits one creation and no prompt before release.`, true);
  });
  await transition.release();
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
      probe.eventually(() => world.readNative(path), {
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
    expect(transition.read()).toMatchObject({ creation: 1, prompt: 1, expired: false });
    expect(await world.requests()).toHaveLength(1);
    await user.screenshot();
    evidence.recordAssertionEvidence(
      `${engine} creates exactly one session without replaying the first send`,
      "After the real engine reply, the session inventory is the original inventory plus exactly the routed session; one user row remains and the composer is empty.",
      true,
    );
  });
});
