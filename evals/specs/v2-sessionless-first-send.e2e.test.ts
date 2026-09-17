import { expect } from "vitest";
import { browserScript, resolveEvalEngine, spec } from "@openwork/testkit";
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
    expect(await world.route()).toBe(world.sessionlessRoute);
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
      await using rejected = await world.transition(evidence.dir);
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
      expect(await world.route()).toBe(world.sessionlessRoute);
      expect(recovered.composer.userMessageCount).toBe(0);
      expect(recovered.recovery.restoreVisible).toBe(Boolean(newerDraft));
      expect(recovered.recovery.restoreDisabled).toBe(Boolean(newerDraft));
      expect(rejected.read()).toMatchObject({ creation: 1, prompt: 0, expired: false });
      expect(await readSessions()).toEqual(sessionsBefore);
      expect(await world.requests()).toHaveLength(0);
      await user.looks(newerDraft ? [
        `The New task hero shows the creation error "Session creation rejected by OPE-51 fixture." and the composer contains "${newerDraft}".`,
        "The action 'Clear the current draft to restore the unsent message' is visible below the error; there is no submitted user-message bubble or Starting indicator.",
      ] : [
        "The New task hero shows the creation error 'Session creation rejected by OPE-51 fixture.' and the original prompt beginning 'Summarize this workspace in one sentence.' is restored inside the composer.",
        "There is no submitted user-message bubble, Starting indicator, or 'Clear the current draft to restore the unsent message' action.",
      ]);
      await user.click({ placeholder: "Describe your task..." });
      await user.press(world.app.handle.hostKind !== "daytona" && process.platform === "darwin" ? "Meta+A" : "Control+A");
      await user.press("Backspace");
      if (newerDraft) {
        await user.click({ role: "button", label: "Clear the current draft to restore the unsent message" });
        await user.see("composer", { text: prompt, editable: true });
        expect((await world.recovery()).restoreVisible).toBe(false);
        await user.looks([
          "The original prompt beginning 'Summarize this workspace in one sentence.' is visible inside the New task composer, with the creation error still visible above it.",
          "The newer text 'Keep this newer continuation intact.' and the 'Clear the current draft to restore the unsent message' action are absent; there is no submitted user-message bubble or Starting indicator.",
        ]);
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
    expect(await world.route()).toBe(world.sessionlessRoute);
  });

  await using transition = await world.transition(evidence.dir);
  evidence.recordJsonArtifact("Sessionless transition recording", { engine, path: transition.filmPath });
  await user.looks([
    "The 'What do you need done?' hero heading is visible above a composer containing the prompt beginning 'Summarize this workspace in one sentence.'.",
    "There is no creation error, Starting indicator, or submitted user-message bubble above the populated composer.",
  ]);
  await user.press("Enter");
  await user.press("Enter");
  await step("slow session creation keeps an unmoved busy hero composer without intermediate labels or a temporary user row", async () => {
    await probe.eventually(() => transition.read(), {
      within: 10_000, label: "one held session creation", until: (state) => state.held === 1,
    });
    const samples = await probe.eventually(() => transition.samples(), {
      within: 10_000, label: "busy creating control sampled across the slow creation interval",
      until: (values) => {
        const preparing = values.filter((sample) => sample.submitted && sample.preparing && sample.source === "raf");
        return preparing.length >= 20 && preparing[preparing.length - 1]!.elapsed - preparing[0]!.elapsed >= 1500;
      },
    }).finally(async () => {
      evidence.recordJsonArtifact("Immediate sessionless RAF and mutation observations", await transition.samples());
    });
    await user.looks([
      "The 'What do you need done?' hero remains visible above the stationary empty composer showing 'Describe your task...', with a visible busy spinner in its send control.",
      "There is no submitted user-message bubble, Starting indicator, or Working indicator between the hero heading and the composer.",
    ]);
    expect(transition.read()).toMatchObject({ creation: 1, prompt: 0, held: 1, expired: false });
    const submissionIndex = samples.findIndex((sample) => sample.submitted);
    expect(submissionIndex).toBeGreaterThanOrEqual(0);
    const baseline = samples[submissionIndex]!;
    const heldSamples = samples.slice(submissionIndex);
    evidence.recordJsonArtifact("Trusted submission through held creation", { submissionIndex, submittedAt: baseline.submittedAt, samples: heldSamples });
    expect(baseline.source).toMatch(/^trusted-submit-(enter|click)$/);
    expect(baseline.submissionIndex).toBe(submissionIndex);
    expect(baseline.submittedAt).not.toBeNull();
    expect(baseline.width).toBeGreaterThan(0);
    expect(baseline.height).toBeGreaterThan(0);
    expect(heldSamples.filter((sample) => sample.source === "raf").length).toBeGreaterThanOrEqual(20);
    expect(heldSamples.some((sample) => sample.source === "mutation" && sample.preparing)).toBe(true);
    const firstPreparing = heldSamples.findIndex((sample) => sample.preparing);
    expect(firstPreparing).toBeGreaterThanOrEqual(0);
    expect(heldSamples.slice(firstPreparing).every((sample) => sample.preparing)).toBe(true);
    for (const [offset, sample] of heldSamples.entries()) {
      expect(sample.index).toBe(submissionIndex + offset);
      expect(sample.submitted).toBe(true);
      expect(sample.submissionIndex).toBe(submissionIndex);
      expect(sample.submittedAt).toBe(baseline.submittedAt);
      expect(sample.hero).toBe(true);
      expect(sample.starting).toBe(false);
      expect(sample.working).toBe(false);
      expect(sample.persisted).toEqual([]);
      expect(sample.users).toBe(0);
      expect(sample.totalUsers).toBe(0);
      expect(Math.abs(sample.top - baseline.top)).toBeLessThanOrEqual(1);
      expect(Math.abs(sample.left - baseline.left)).toBeLessThanOrEqual(1);
      expect(Math.abs(sample.width - baseline.width)).toBeLessThanOrEqual(1);
      expect(Math.abs(sample.height - baseline.height)).toBeLessThanOrEqual(1);
    }
    evidence.recordAssertionEvidence("Slow creation preserves hero layout without a temporary user bubble",
      `${heldSamples.length} contiguous observations from trusted submission preserve the visible hero and editor rect within one pixel with no user rows, persisted surfaces, Starting or Working; the busy creating spinner persists without gaps once shown for at least 1500ms; duplicate Enter admits one creation and no prompt before release.`, true);
  });
  await transition.release();
  const hash = await probe.eventually(() => world.route(), {
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
    expect(await world.route()).toBe(`${persistedPrefix}${sessionId}`);
    expect(composer.draftText.trim()).toBe("");
    expect(composer.userMessageCount).toBe(1);
  });

  await step("exactly one session was created and the engine reply arrives in it", async () => {
    await user.see({ text: world.reply }, { timeoutMs: 120_000 });
    expect(await readSessions()).toEqual([...sessionsBefore, sessionId].sort());
    expect(await world.route()).toBe(`${persistedPrefix}${sessionId}`);
    expect((await probe.composer()).userMessageCount).toBe(1);
    expect(transition.read()).toMatchObject({ creation: 1, prompt: 1, expired: false });
    expect(await world.requests()).toHaveLength(1);
    const rows = await probe.eval(browserScript((id) => {
      const surface = document.querySelector<HTMLElement>('[data-session-surface-id="' + id + '"]');
      return [...(surface?.querySelectorAll<HTMLElement>('[data-message-role]') ?? [])]
        .filter((node) => node.getClientRects().length && getComputedStyle(node).visibility !== "hidden")
        .map((node) => ({ role: node.getAttribute("data-message-role"), text: node.innerText }));
    }, [sessionId]));
    expect(rows.filter((row) => row.role === "user")).toHaveLength(1);
    expect(rows[0]?.role).toBe("user");
    expect(rows[0]?.text).toContain(prompt);
    expect(rows.slice(1).some((row) => row.role === "assistant" && row.text.includes(world.reply))).toBe(true);
    evidence.recordAssertionEvidence("The opening prompt stays before its response",
      "The created thread has exactly one user row, first in transcript order, followed by the engine reply; the prompt is neither duplicated nor rendered below its answer.", true);
    await user.looks([
      `The conversation transcript shows exactly one user-message bubble containing the prompt beginning 'Summarize this workspace in one sentence.' and an assistant reply reading '${world.reply}'.`,
      "An empty composer is visible below the transcript; the 'What do you need done?' hero and Starting indicator are absent.",
    ]);
    const handoff = await transition.samples();
    evidence.recordJsonArtifact("Hero to persisted session DOM ownership", handoff);
    const submissionIndex = handoff.findIndex((sample) => sample.submitted);
    expect(submissionIndex).toBeGreaterThanOrEqual(0);
    const takeoverIndex = handoff.findIndex((sample, index) => index >= submissionIndex && sample.persisted.length > 0);
    expect(takeoverIndex).toBeGreaterThan(submissionIndex);
    const baseline = handoff[submissionIndex]!;
    const takeover = handoff[takeoverIndex]!;
    const heroSamples = handoff.slice(submissionIndex, takeoverIndex);
    evidence.recordJsonArtifact("Trusted submission and first persisted takeover boundaries", {
      submissionIndex, submittedAt: baseline.submittedAt, takeoverIndex, takeoverAt: takeover.elapsed,
      submission: baseline, takeover, samples: heroSamples,
    });
    expect(baseline.source).toMatch(/^trusted-submit-(enter|click)$/);
    expect(baseline.submissionIndex).toBe(submissionIndex);
    expect(baseline.submittedAt).not.toBeNull();
    expect(heroSamples.length).toBeGreaterThan(20);
    expect(heroSamples.every((sample, offset) => sample.index === submissionIndex + offset
      && sample.submitted && sample.submissionIndex === submissionIndex && sample.submittedAt === baseline.submittedAt
      && sample.hero && sample.users === 0 && sample.totalUsers === 0 && sample.persisted.length === 0)).toBe(true);
    expect(heroSamples.every((sample) => !sample.starting && !sample.working)).toBe(true);
    const firstPreparing = heroSamples.findIndex((sample) => sample.preparing);
    expect(firstPreparing).toBeGreaterThanOrEqual(0);
    expect(heroSamples.slice(firstPreparing).every((sample) => sample.preparing)).toBe(true);
    expect(heroSamples.every((sample) => Math.abs(sample.top - baseline.top) <= 1
      && Math.abs(sample.left - baseline.left) <= 1 && Math.abs(sample.width - baseline.width) <= 1
      && Math.abs(sample.height - baseline.height) <= 1)).toBe(true);
    expect(takeover.hero).toBe(false);
    expect(takeover.persisted).toEqual([sessionId]);
    const persistedSamples = handoff.slice(takeoverIndex);
    expect(persistedSamples.every((sample) => !sample.hero && sample.persisted.length === 1 && sample.persisted[0] === sessionId)).toBe(true);
    expect(persistedSamples.some((sample) => sample.totalUsers === 1)).toBe(true);
    evidence.recordAssertionEvidence("DOM ownership stays with the unchanged hero until the persisted thread takes over",
      `${heroSamples.length} contiguous observations from trusted submission index ${submissionIndex} to first visible persisted surface index ${takeoverIndex} retain the hero, zero user rows, no persisted surfaces and a stable editor rectangle; Starting and Working remain absent and the busy creating spinner has no gaps once shown. The first takeover is exactly the created session, which then owns one visible user row.`, true);
    evidence.recordAssertionEvidence(
      `${engine} creates exactly one session without replaying the first send`,
      "After the real engine reply, the session inventory is the original inventory plus exactly the routed session; one user row remains and the composer is empty.",
      true,
    );
  });
});
