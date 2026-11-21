import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { streamFeedback, streamFeedbackPrompt, streamFeedbackReasoning, streamFeedbackText } from "../worlds/stream-feedback.ts";
import { inspectStreamFeedback, streamFeedbackStayedCollapsed } from "../worlds/stream-feedback-summary.ts";

const test = spec.world(streamFeedback, {
  timeout: 240_000,
  resources: { surfaces: ["appWeb"], services: ["mock"] },
});

// Regression proof of EXISTING v2 streaming; baseline should pass. Samples are
// deltas in one turn, not independent turns. DOM/rAF are not physical paint.
// This small loopback fixture's 300 ms p95 budget is NOT a model/task SLA.
// Reasoning includes EVERY arrival after trusted opening intent, including slow
// opening. Pre-intent arrivals are retained separately, not measured as visible.
const frameP95BudgetMs = 300;
const pinnedVersion = "2.0.26";
const finalSentence = /The progress note is complete\./;

test("a member sees reasoning and an answer grow before the model finishes", async ({ world, user, probe, step, evidence }) => {
  const capture = async () => {
    const [feedback, provider, safeRuntime] = await Promise.all([
      world.feedback().catch(() => null), world.providerState().catch(() => null), world.runtime().catch(() => null),
    ]);
    const received = new Set([...(feedback?.preIntentReasoning ?? []), ...(feedback?.samples ?? [])].map(item => item.token));
    return {
      safeRuntime, provider, feedback,
      inspection: feedback ? inspectStreamFeedback(feedback.samples, feedback.observedAt) : null,
      missingNativeReasoningTokens: streamFeedbackReasoning.map(chunk => chunk.trim()).filter(token => !received.has(token)),
      missingNativeTextTokens: streamFeedbackText.map(chunk => chunk.trim()).filter(token => !received.has(token)),
      reasoningScope: "all post-trusted-intent arrivals, INCLUDING opening; pre-intent arrivals retained separately",
      openingDelayMs: feedback?.disclosureAt !== null && feedback?.disclosureReadyAt !== null && feedback
        ? feedback.disclosureReadyAt - feedback.disclosureAt : null,
      submitToFirstNativeDeltaMs: feedback?.firstDeltaAt !== null && feedback?.trustedSendAt !== null && feedback
        ? feedback.firstDeltaAt - feedback.trustedSendAt : null,
      promptPostToFirstNativeDeltaMs: feedback?.firstDeltaAt !== null && feedback?.promptPostAt !== null && feedback
        ? feedback.firstDeltaAt - feedback.promptPostAt : null,
      preArrivalIncludes: "submission, engine, provider and transport; excluded from app feedback distributions",
      boundary: "browser native SSE receipt -> matching viewport DOM -> rAF observation, NOT device paint",
      frameP95BudgetMs,
    };
  };
  let startingPid: number | null = null;
  try {
    await step("given: the member is using the pinned running native engine", async () => {
      await user.see("composer");
      const snapshot = await capture();
      evidence.recordAssertionEvidence("The actual running native engine matches the pin", JSON.stringify(snapshot),
        snapshot.safeRuntime?.running === true && snapshot.safeRuntime.chatRouting && snapshot.safeRuntime.version === pinnedVersion && snapshot.safeRuntime.pid !== null);
      expect(snapshot.safeRuntime?.httpStatus).toBe(200);
      expect(snapshot.safeRuntime?.running).toBe(true);
      expect(snapshot.safeRuntime?.chatRouting).toBe(true);
      expect(snapshot.safeRuntime?.version).toBe(pinnedVersion);
      expect(snapshot.safeRuntime?.pid).not.toBeNull();
      startingPid = snapshot.safeRuntime?.pid ?? null;
    });

    await step("before: reasoning stays collapsed after real deltas arrive and until the member opens it", async () => {
      await user.type("composer", streamFeedbackPrompt);
      await user.click("Run task");
      await probe.eventually(() => world.feedback(), {
        within: 60_000, label: "native reasoning receipt and actual collapsed disclosure",
        until: value => value.preIntentReasoning.length > 0
          && value.preIntentDisclosure.some(item => item.receivedReasoning > 0 && item.expanded === false),
      });
      await user.see({ role: "button", label: "Thinking…" });
      await user.notSee({ text: /\br00\b/ }, { timeoutMs: 100 });
      const snapshot = await capture();
      const feedback = snapshot.feedback;
      const collapsed = Boolean(feedback && streamFeedbackStayedCollapsed(feedback.preIntentDisclosure, feedback.disclosureTraceOverflow));
      evidence.recordAssertionEvidence("Actual expanded and visible state stays collapsed after receipt", JSON.stringify(snapshot), collapsed);
      expect(feedback?.trustedSendAt).not.toBeNull();
      expect(feedback?.promptPostAt).not.toBeNull();
      expect(feedback?.firstDeltaAt).not.toBeNull();
      expect(feedback?.disclosureAt).toBeNull();
      expect(collapsed).toBe(true);
      await user.screenshot();
    });

    await step("after: every reasoning arrival after the opening click gets feedback before completion", async () => {
      await user.click({ role: "button", label: "Thinking…" });
      await user.see({ text: /\br00\b/ });
      await probe.eventually(() => world.feedback(), {
        within: 30_000, label: "all reasoning arrivals, including those during opening, and their visible frames",
        until: value => value.preIntentReasoning.length + value.samples.filter(sample => sample.kind === "reasoning").length === streamFeedbackReasoning.length
          && value.samples.every(sample => sample.frameAt !== null),
      });
      const snapshot = await capture();
      const feedback = snapshot.feedback;
      const reasoning = feedback?.samples.filter(sample => sample.kind === "reasoning") ?? [];
      const report = snapshot.inspection?.find(item => item.kind === "reasoning");
      const lastArrival = reasoning.at(-1)?.receivedAt ?? 0;
      const incrementalFrames = reasoning.filter(sample => sample.frameAt !== null && sample.frameAt < lastArrival).length;
      const collapsed = Boolean(feedback && streamFeedbackStayedCollapsed(feedback.preIntentDisclosure, feedback.disclosureTraceOverflow));
      const withinBudget = (report?.frame?.p95Ms ?? Infinity) < frameP95BudgetMs;
      evidence.recordAssertionEvidence("Post-click reasoning includes opening delay, with no censored arrivals hidden", JSON.stringify({
        ...snapshot, incrementalFramesBeforeLastReasoningDelta: incrementalFrames,
      }), collapsed && reasoning.length >= 20 && incrementalFrames >= 20 && withinBudget
        && report?.censored.length === 0 && report.invalid.length === 0 && report.postCompletion.length === 0
        && snapshot.missingNativeReasoningTokens.length === 0 && feedback?.terminalAt === null
        && snapshot.provider?.complete === false && snapshot.provider.deliveredChunks === 0);
      expect(collapsed).toBe(true); // Includes the intent-time snapshot after the earlier screenshot.
      expect(reasoning.length).toBeGreaterThanOrEqual(20);
      expect(snapshot.missingNativeReasoningTokens).toHaveLength(0);
      expect(feedback?.disclosureAt).not.toBeNull();
      expect(feedback?.disclosureReadyAt).not.toBeNull();
      expect(feedback?.terminalAt).toBeNull();
      expect(snapshot.provider?.complete).toBe(false);
      expect(snapshot.provider?.deliveredChunks).toBe(0);
      expect(report?.censored).toHaveLength(0);
      expect(report?.invalid).toHaveLength(0);
      expect(report?.postCompletion).toHaveLength(0);
      expect(incrementalFrames).toBeGreaterThanOrEqual(20);
      expect(report?.frame?.p95Ms ?? Infinity).toBeLessThan(frameP95BudgetMs);
      await user.screenshot();
    });

    await step("after: each released answer chunk becomes visible before the next one or completion", async () => {
      for (const chunk of streamFeedbackText) {
        await world.releaseText();
        await probe.eventually(() => world.feedback(), {
          within: 15_000, label: `visible frame for ${chunk.trim()}`,
          until: value => value.samples.some(sample => sample.kind === "text" && sample.token === chunk.trim() && sample.frameAt !== null),
        });
        if (chunk === streamFeedbackText[0]) await user.screenshot();
      }
      await user.see({ text: /\bt23\b/ });
      await user.notSee({ text: finalSentence }, { timeoutMs: 100 });
      const snapshot = await capture();
      evidence.recordAssertionEvidence("Text and post-intent reasoning retain raw, missing and censored samples before budget checks", JSON.stringify(snapshot),
        snapshot.inspection?.every(item => item.censored.length === 0 && item.invalid.length === 0
          && item.postCompletion.length === 0 && (item.frame?.p95Ms ?? Infinity) < frameP95BudgetMs) === true
          && snapshot.missingNativeTextTokens.length === 0 && snapshot.feedback?.errors === 0 && snapshot.feedback.terminalAt === null
          && snapshot.provider?.complete === false && snapshot.provider.deliveredChunks === streamFeedbackText.length);
      expect(snapshot.feedback?.errors).toBe(0);
      expect(snapshot.feedback?.terminalAt).toBeNull();
      expect(snapshot.provider?.complete).toBe(false);
      expect(snapshot.provider?.deliveredChunks).toBe(streamFeedbackText.length);
      expect(snapshot.missingNativeTextTokens).toHaveLength(0);
      expect(snapshot.feedback?.samples.filter(sample => sample.kind === "text")).toHaveLength(streamFeedbackText.length);
      for (const report of snapshot.inspection ?? []) {
        expect(report.censored).toHaveLength(0);
        expect(report.invalid).toHaveLength(0);
        expect(report.postCompletion).toHaveLength(0);
        expect(report.frame?.p95Ms ?? Infinity).toBeLessThan(frameP95BudgetMs);
      }
    });

    await step("after: only releasing the final sentence lets the same pinned engine finish", async () => {
      await world.releaseText();
      await user.see({ text: finalSentence });
      await user.see({ role: "button", label: "Run task" }, { timeoutMs: 30_000 });
      await user.notSee({ role: "button", label: "Stop" }, { timeoutMs: 100 });
      await probe.eventually(() => world.providerState(), { within: 15_000, label: "the provider really completed", until: value => value.complete });
      const snapshot = await capture();
      evidence.recordAssertionEvidence("Completion follows final release on the same pinned runtime", JSON.stringify(snapshot),
        snapshot.provider?.complete === true && !snapshot.provider.aborted && !snapshot.provider.timedOut
          && snapshot.safeRuntime?.running === true && snapshot.safeRuntime.chatRouting
          && snapshot.safeRuntime.version === pinnedVersion && snapshot.safeRuntime.pid === startingPid);
      expect(snapshot.provider?.complete).toBe(true);
      expect(snapshot.provider?.aborted).toBe(false);
      expect(snapshot.provider?.timedOut).toBe(false);
      expect(snapshot.safeRuntime?.running).toBe(true);
      expect(snapshot.safeRuntime?.chatRouting).toBe(true);
      expect(snapshot.safeRuntime?.version).toBe(pinnedVersion);
      expect(snapshot.safeRuntime?.pid).toBe(startingPid);
      await user.screenshot();
    });
  } catch (error) {
    // Also runs for waits/locators/timeouts before the normal evidence line.
    // Never replace a red verdict or discard slow, missing or pending observations.
    evidence.recordAssertionEvidence("Failure retains raw, missing, censored and disclosure-history observations", JSON.stringify(await capture()), false);
    throw error;
  }
});
