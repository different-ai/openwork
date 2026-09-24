import { expect } from "vitest";
import { spec, type SpecBodyContext } from "@openwork/testkit";
import { normalizeContinuityText } from "../worlds/chat-continuity.ts";
import { chatStreamContinuityLiveWeb, liveContinuityPrompt } from "../worlds/chat-stream-continuity.ts";

// Before, returning to an ongoing answer could freeze it or lose its prefix; now the original
// prefix keeps growing into the complete generated result without reload or resend, leaving the neighbor untouched.
// Witnesses: UI send/switch, session/message-scoped SSE, and normalized final text equality.
// Scope: paid OpenAI, local web/native v1, initially empty neighbor; not guide accuracy, v2, or cross-account isolation.
const liveContinuityTest = spec.world(chatStreamContinuityLiveWeb, {
  timeout: 480_000,
  needs: { placement: "local", optIn: ["OPENWORK_EVAL_LIVE_OPENAI"], env: ["OPENAI_API_KEY"] },
  resources: { surfaces: ["appWeb"], services: [] },
});

liveContinuityTest("CONT-01-live a member returns to an answer that keeps growing", async (context) => {
  await liveContinuityJourney(context, false);
});

liveContinuityTest("CONT-01-live-history a member returns to an answer that keeps growing even while history loads", async (context) => {
  await liveContinuityJourney(context, true);
});

async function liveContinuityJourney(
  { world, user, probe, step, evidence }: SpecBodyContext<Awaited<ReturnType<typeof chatStreamContinuityLiveWeb>>>,
  delayedHistory: boolean,
) {
  const stop: { role: "button"; label: string } = { role: "button", label: "Stop" };
  const hasStop = async () => (await probe.dom('[data-workbench-pane="primary"] button[aria-label="Stop"]'))
    .elements.some((element) => element.rect.width > 0 && element.rect.height > 0);
  const surface = (id: string) => `[data-workbench-pane="primary"] [data-session-surface-id="${id}"]`;
  const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
  const samples: Array<{
    phase: string; at: number; length: number; stop: boolean; deltas: number; nativeCharacters: number;
    lastDeltaAt: number; prefixPreserved: boolean | null;
  }> = [];
  let messageId = "";
  let returnedAt = 0;
  let originalPrefix = "";
  const native = async (id: string) => {
    const result = await world.readNative(id);
    expect(result.status).toBe(200);
    if (!Array.isArray(result.body)) throw new Error("Native v1 history must be an array");
    return result.body.filter(record);
  };
  const delta = async () => {
    const state = await world.engineHttpEvents();
    const parts = Object.values(state.textDeltas).filter((part) => part.sessionId === world.session.sessionId
      && (!messageId || part.messageId === messageId));
    return { count: parts.reduce((sum, part) => sum + part.count, 0),
      characters: parts.reduce((sum, part) => sum + part.characters, 0), lastAt: Math.max(0, ...parts.map((part) => part.lastAt)) };
  };
  const rendered = async () => {
    const rows = await world.continuity.assistantText(world.session.sessionId, messageId);
    expect(rows.length).toBeLessThanOrEqual(1);
    return normalizeContinuityText(rows[0] ?? "");
  };
  const sample = async (phase: string) => {
    const [text, active, stream] = await Promise.all([rendered(), hasStop(), delta()]);
    const value = { phase, at: Date.now(), length: text.length, stop: active,
      deltas: stream.count, nativeCharacters: stream.characters, lastDeltaAt: stream.lastAt,
      prefixPreserved: originalPrefix ? text.startsWith(originalPrefix) : null };
    samples.push(value);
    return { ...value, text };
  };
  const select = async (target: { sessionId: string; title: string }) => {
    await user.click({ text: target.title });
    await probe.eventually(() => world.continuity.surfaceState("primary"), {
      within: 10_000, intervalMs: 100, label: `selected ${target.title}`, until: (state) => state.sessionId === target.sessionId,
    });
  };
  try {
    await step("a member asks for a guide once and sees the answer begin", async () => {
      const facts = await world.runtimeFacts();
      evidence.recordJsonArtifact("CONT-01-live runtime", {
        ...facts, model: world.modelId, provider: world.providerId, outputBudget: 6_500, historyGetDelayMs: delayedHistory ? 8_000 : 0,
      });
      expect(facts).toMatchObject({ hostKind: "local", mockCount: 0, electronBridge: false });
      expect(facts.browser).toContain("HeadlessChrome/");
      await user.type("composer", liveContinuityPrompt);
      await user.click("Run task");
      await user.see(stop, { timeoutMs: 60_000 });
      const started = await probe.eventually(() => world.engineHttpEvents(), {
        within: 90_000, intervalMs: 200, label: "A-specific native text deltas from OpenAI",
        until: (state) => Object.values(state.textDeltas).some((part) => part.sessionId === world.session.sessionId && part.characters > 100),
      });
      const part = Object.values(started.textDeltas).find((part) => part.sessionId === world.session.sessionId && part.characters > 100);
      if (!part || !/^[a-zA-Z0-9_-]+$/.test(part.messageId)) throw new Error("Missing scoped native assistant identity");
      messageId = part.messageId;
      const initial = await probe.eventually(() => sample("before-away"), {
        within: 10_000, intervalMs: 200, label: "one rendered assistant text row while Stop is present",
        until: (value) => value.length > 100 && value.stop,
      });
      originalPrefix = initial.text;
      const initialPassed = initial.length > 100 && initial.stop && initial.deltas > 0 && initial.nativeCharacters > 100
        && started.promptPosts[world.session.sessionId] === 1 && Object.keys(started.promptPosts).length === 1;
      evidence.recordAssertionEvidence("a member asks for a guide once and sees the answer begin",
        `${initial.length} characters appeared after ${started.promptPosts[world.session.sessionId]} prompt. ${initial.stop ? "The Stop button shows the answer is still generating." : "The Stop button is missing."}`, initialPassed);
      evidence.recordJsonArtifact("CONT-01-live initial text", {
        renderedLength: initial.length, stop: initial.stop, scopedDeltas: initial.deltas, scopedNativeCharacters: initial.nativeCharacters,
        promptPostCount: started.promptPosts[world.session.sessionId], promptSessionCount: Object.keys(started.promptPosts).length,
      });
      expect(initialPassed).toBe(true);
      expect(started.promptPosts).toEqual({ [world.session.sessionId]: 1 });
      await user.screenshot();
    });

    await step("the member spends over twenty seconds in an empty neighboring conversation", async () => {
      await select(world.neighbor);
      const awayAt = Date.now();
      const before = await delta();
      const away = await probe.eventually(async () => {
        const neighborMessages = (await probe.dom(`${surface(world.neighbor.sessionId)} [data-message-role]`)).elements;
        const originalSurfaces = (await probe.dom(surface(world.session.sessionId))).elements;
        expect(neighborMessages).toHaveLength(0);
        expect(originalSurfaces).toHaveLength(0);
        const current = await sample("away");
        return { ...current, elapsed: Date.now() - awayAt, neighborVisibleMessages: neighborMessages.length, originalVisibleSurfaces: originalSurfaces.length };
      }, { within: 25_000, intervalMs: 500, label: "real wall-clock inactive interval beyond the 15-second GC window", until: (value) => value.elapsed >= 20_500 });
      const after = await delta();
      const lastDeltaAgeMs = Date.now() - after.lastAt;
      const awayPassed = away.elapsed >= 20_500 && away.neighborVisibleMessages === 0 && away.originalVisibleSurfaces === 0
        && after.count > before.count && lastDeltaAgeMs < 5_000;
      evidence.recordAssertionEvidence("the member spends over twenty seconds in an empty neighboring conversation",
        `After ${(away.elapsed / 1_000).toFixed(1)} seconds away, the neighbor showed ${away.neighborVisibleMessages} messages. The original answer ${after.count > before.count ? "kept receiving updates" : "received no new updates"} (${before.count} to ${after.count}); the latest was ${(lastDeltaAgeMs / 1_000).toFixed(1)} seconds old.`, awayPassed);
      evidence.recordJsonArtifact("CONT-01-live away measurements", {
        elapsedMs: away.elapsed, neighborVisibleMessages: away.neighborVisibleMessages, originalVisibleSurfaces: away.originalVisibleSurfaces,
        scopedDeltasBefore: before.count, scopedDeltasAfter: after.count, lastDeltaAgeMs,
      });
      expect(awayPassed).toBe(true);
      expect(after.count).toBeGreaterThan(before.count);
      expect(Date.now() - after.lastAt).toBeLessThan(5_000);
      await user.notSee({ text: liveContinuityPrompt });
      evidence.recordJsonArtifact("CONT-01-live away interval", { awayAt, endedAt: Date.now(), before, after });
    });

    const growthClaim = delayedHistory
      ? "after: the original answer keeps growing without asking again, even while history loads"
      : "after: the original answer keeps growing without asking again";
    await step(growthClaim, async () => {
      await using historyFault = delayedHistory ? await world.continuity.holdHistory(world.session.sessionId) : null;
      let releasedByTimer = false;
      const historyRelease = historyFault ? new Promise<void>((resolve) => setTimeout(resolve, 8_000)).then(() => {
        releasedByTimer = true;
        return historyFault.release();
      }) : null;
      void historyRelease?.catch(() => undefined);
      returnedAt = Date.now();
      const growthSample = async (phase: string) => {
        const historyBefore = historyFault?.read(world.session.sessionId) ?? null;
        const current = await sample(phase);
        const historyAfter = historyFault?.read(world.session.sessionId) ?? null;
        return { ...current, historyBefore, historyAfter, releasedByTimer };
      };
      try {
        await select(world.session);
        await user.see(stop, { timeoutMs: 5_000 });
        let previous = await probe.eventually(() => growthSample("returned"), {
          within: delayedHistory ? 3_000 : 10_000, intervalMs: 200, label: "return preserves the original assistant prefix while streaming",
          until: (value) => value.prefixPreserved === true && value.stop,
        });
        for (let increase = 1; increase <= 2; increase++) {
          const next = await probe.eventually(() => growthSample(`growth-${increase}`), {
            within: delayedHistory ? 2_000 : 12_000, intervalMs: 500, label: `prefix-preserving live increase ${increase} correlated with A text deltas`,
            until: (value) => value.at - previous.at >= 1_000 && value.stop && value.prefixPreserved === true
              && value.text.startsWith(previous.text) && value.length > previous.length
              && value.deltas > previous.deltas && value.nativeCharacters > previous.nativeCharacters,
          });
          const prefixPreserved = next.text.startsWith(originalPrefix);
          const previousTextPreserved = next.text.startsWith(previous.text);
          const growthPassed = next.at - previous.at >= 1_000 && next.stop && next.prefixPreserved === true
            && prefixPreserved && previousTextPreserved && next.length > previous.length
            && next.deltas > previous.deltas && next.nativeCharacters > previous.nativeCharacters && next.lastDeltaAt > previous.at
            && (!delayedHistory || ((next.historyBefore?.outstanding ?? 0) > 0
              && (next.historyAfter?.outstanding ?? 0) > 0 && !next.releasedByTimer));
          evidence.recordAssertionEvidence(`${growthClaim} (sample ${increase})`,
            `The answer ${next.length > previous.length ? "grew" : "changed"} from ${previous.length} to ${next.length} characters in ${((next.at - previous.at) / 1_000).toFixed(1)} seconds. ${prefixPreserved && previousTextPreserved ? "Its original beginning and all previously seen text remained intact." : "Previously seen text was not fully retained."} ${next.stop ? "Stop remained visible." : "Stop was missing."}${delayedHistory ? ((next.historyBefore?.outstanding ?? 0) > 0 && (next.historyAfter?.outstanding ?? 0) > 0 && !next.releasedByTimer ? " History was still loading throughout this sample." : "History was not held throughout this sample.") : ""}`, growthPassed);
          evidence.recordJsonArtifact(`CONT-01-live growth ${increase}`, {
            elapsedMs: next.at - previous.at, stop: next.stop, prefixPreserved, previousTextPreserved,
            renderedLengthBefore: previous.length, renderedLengthAfter: next.length,
            scopedDeltasBefore: previous.deltas, scopedDeltasAfter: next.deltas,
            scopedCharactersBefore: previous.nativeCharacters, scopedCharactersAfter: next.nativeCharacters,
            lastDeltaAfterPreviousMs: next.lastDeltaAt - previous.at, delayedHistory,
            outstandingBefore: next.historyBefore?.outstanding ?? null, outstandingAfter: next.historyAfter?.outstanding ?? null,
            releasedByTimer: next.releasedByTimer,
          });
          expect(growthPassed).toBe(true);
          expect(next.stop).toBe(true);
          expect(next.text.startsWith(originalPrefix)).toBe(true);
          expect(next.text.startsWith(previous.text)).toBe(true);
          expect(next.lastDeltaAt).toBeGreaterThan(previous.at);
          if (historyFault) {
            evidence.recordJsonArtifact(`CONT-01-live outstanding history at growth ${increase}`, {
              at: next.at, historyBefore: next.historyBefore, historyAfter: next.historyAfter, releasedByTimer: next.releasedByTimer,
            });
            expect(next.historyBefore?.outstanding).toBeGreaterThan(0);
            expect(next.historyAfter?.outstanding).toBeGreaterThan(0);
            expect(next.releasedByTimer).toBe(false);
          }
          previous = next;
          await user.screenshot();
        }
        expect((await world.engineHttpEvents()).promptPosts).toEqual({ [world.session.sessionId]: 1 });
      } finally {
        if (historyFault) {
          evidence.recordJsonArtifact("CONT-01-live delayed history", { ...historyFault.read(world.session.sessionId), returnedAt, observedAt: Date.now(), releasedByTimer });
          await historyRelease;
        }
      }
    });

    let nativeText = "";
    await step("after: the complete answer is ready without reloading or asking again", async () => {
      await user.see("Run task", { timeoutMs: 180_000 });
      await user.notSee(stop);
      const messages = await native(world.session.sessionId);
      const assistants = messages.filter((entry) => record(entry.info) && entry.info.role === "assistant");
      expect(assistants).toHaveLength(1);
      const assistant = assistants[0];
      const info = assistant?.info;
      if (!record(info) || !record(info.tokens) || !Array.isArray(assistant?.parts)) throw new Error("Native assistant lacks text or usage receipt");
      evidence.recordJsonArtifact("CONT-01-live native usage", info);
      expect(info).toMatchObject({ id: messageId, modelID: world.modelId, providerID: world.providerId, finish: "stop" });
      expect(info.error).toBeUndefined();
      expect(info.tokens.output).toBeGreaterThan(0);
      expect(info.tokens.output).toBeLessThanOrEqual(6_500);
      expect(messages.filter((entry) => record(entry.info) && entry.info.role === "user")).toHaveLength(1);
      nativeText = normalizeContinuityText(assistant.parts.filter(record)
        .filter((part) => part.type === "text" && typeof part.text === "string").map((part) => part.text).join("\n"));
      expect(nativeText.startsWith(originalPrefix)).toBe(true);
      expect(nativeText.length).toBeGreaterThan(originalPrefix.length);
      const settled = await probe.eventually(rendered, {
        within: 10_000, intervalMs: 200, label: "rendered assistant equals the entire normalized native answer", until: (text) => text === nativeText,
      });
      const completedPassed = settled === nativeText && settled.startsWith(originalPrefix)
        && nativeText.startsWith(originalPrefix) && nativeText.length > originalPrefix.length;
      evidence.recordAssertionEvidence("after: the complete answer is ready without reloading or asking again",
        `The ${settled.length}-character visible answer ${settled === nativeText ? "matches" : "does not match"} the entire ${nativeText.length}-character saved guide. ${settled.startsWith(originalPrefix) && nativeText.startsWith(originalPrefix) ? "Both retain" : "They do not both retain"} the original ${originalPrefix.length}-character beginning.`, completedPassed);
      evidence.recordJsonArtifact("CONT-01-live completion measurements", {
        nativeLength: nativeText.length, renderedLength: settled.length, originalPrefixLength: originalPrefix.length,
        completeTextMatches: settled === nativeText, renderedPrefixPreserved: settled.startsWith(originalPrefix),
        nativePrefixPreserved: nativeText.startsWith(originalPrefix),
      });
      expect(completedPassed).toBe(true);
      expect(settled).toBe(nativeText);
      expect(settled.startsWith(originalPrefix)).toBe(true);
      const until = Date.now() + 2_000;
      await probe.eventually(async () => {
        expect(await rendered()).toBe(nativeText);
        expect(await hasStop()).toBe(false);
        return Date.now() >= until;
      }, { within: 4_000, intervalMs: 250, label: "complete normalized answer remains stable" });
      expect(await native(world.neighbor.sessionId)).toEqual([]);
      expect((await world.engineHttpEvents()).promptPosts).toEqual({ [world.session.sessionId]: 1 });
      await user.screenshot();
    });

    await step("the neighboring conversation stays empty", async () => {
      const neighborNativeMessages = await native(world.neighbor.sessionId);
      expect(neighborNativeMessages).toEqual([]);
      await select(world.neighbor);
      await user.notSee(stop);
      await user.notSee({ text: liveContinuityPrompt });
      const neighborVisibleMessages = (await probe.dom(`${surface(world.neighbor.sessionId)} [data-message-role]`)).elements.length;
      expect(neighborVisibleMessages).toBe(0);
      await user.screenshot();
      await select(world.session);
      const revisited = await probe.eventually(rendered, {
        within: 10_000, intervalMs: 200, label: "the complete guide remains available after revisiting", until: (text) => text === nativeText,
      });
      expect(revisited).toBe(nativeText);
      const promptPosts = (await world.engineHttpEvents()).promptPosts;
      const revisitPassed = revisited === nativeText && revisited.startsWith(originalPrefix)
        && neighborVisibleMessages === 0 && neighborNativeMessages.length === 0
        && promptPosts[world.session.sessionId] === 1 && Object.keys(promptPosts).length === 1;
      evidence.recordAssertionEvidence("the neighboring conversation stays empty",
        `The neighbor has ${neighborVisibleMessages} visible and ${neighborNativeMessages.length} saved messages. On return, the ${revisited.length}-character guide ${revisited === nativeText ? "still matches" : "does not match"} the entire saved answer. ${promptPosts[world.session.sessionId]} prompt was sent across ${Object.keys(promptPosts).length} conversation.`, revisitPassed);
      evidence.recordJsonArtifact("CONT-01-live revisit measurements", {
        nativeLength: nativeText.length, renderedLength: revisited.length, completeTextMatches: revisited === nativeText,
        prefixPreserved: revisited.startsWith(originalPrefix), neighborVisibleMessages, neighborNativeMessages: neighborNativeMessages.length,
        promptPostCount: promptPosts[world.session.sessionId], promptSessionCount: Object.keys(promptPosts).length,
      });
      expect(revisitPassed).toBe(true);
      expect(promptPosts).toEqual({ [world.session.sessionId]: 1 });
      evidence.recordJsonArtifact("CONT-01-live completed guide", {
        prefixPreserved: revisited.startsWith(originalPrefix), nativeLength: nativeText.length, renderedLength: revisited.length,
        completeTextMatches: revisited === nativeText, neighborVisibleMessages, promptPosts,
      });
    });
  } catch (error) {
    await user.screenshot().catch(() => undefined);
    throw error;
  } finally {
    const state = await world.engineHttpEvents();
    evidence.recordJsonArtifact("CONT-01-live stream samples", {
      messageId, returnedAt, originalPrefix, samples, textDeltas: state.textDeltas, promptPosts: state.promptPosts,
      historyReads: state.historyReads, observerErrors: state.errors,
    });
    if (await hasStop()) {
      try { await user.see("Run task", { timeoutMs: 120_000 }); }
      catch { if (await hasStop()) await user.click(stop); }
    }
    evidence.recordJsonArtifact("CONT-01-live final native receipt", (await native(world.session.sessionId)).map((entry) => entry.info));
  }
}
