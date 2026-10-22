import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { chatDraftContinuity } from "../worlds/chat-draft-continuity.ts";

const test = spec.world(chatDraftContinuity, {
  resources: { surfaces: ["appWeb"], services: [] },
  timeout: 240_000,
});

const FIRST = "A separate draft for the first conversation.";
const SECOND = "Keep these unsent words in the second conversation.";

// This guards existing behavior, rather than claiming to fix a new incident.
// No message is sent and no model/provider is needed for local draft feedback.
test("a person switches conversations and reloads without losing or sending either draft", async ({ world, user, probe, step, evidence }) => {
  await step("the person types a draft without sending it", async () => {
    await user.see("composer", { editable: true, text: "" });
    await user.type("composer", SECOND, { intervalMs: 25, verify: true });
    await user.see("composer", { text: SECOND });
    const state = await probe.composer();
    expect(state.userMessageCount).toBe(0);
    evidence.recordAssertionEvidence("Typing leaves the words unsent", `Draft retained; user messages: ${state.userMessageCount}`, state.userMessageCount === 0);
    await user.screenshot();
  });

  await step("each conversation keeps its own words when the person switches", async () => {
    await user.click({ text: world.first.title });
    await user.see("composer", { editable: true, text: "" });
    await user.type("composer", FIRST, { intervalMs: 25, verify: true });
    await user.click({ text: world.second.title });
    await user.see("composer", { text: SECOND });
    expect(await probe.hash()).toContain(`/session/${world.second.sessionId}`);
    const state = await probe.composer();
    expect(state.userMessageCount).toBe(0);
    evidence.recordAssertionEvidence("Switching restores only this conversation's draft", `Second draft intact; user messages: ${state.userMessageCount}`, state.userMessageCount === 0 && state.draftText === SECOND);
    await user.screenshot();
  });

  await step("trusted typing is observed in frame callbacks without submitting a prompt", async () => {
    await user.see("composer", { text: SECOND });
    const feedback = await probe.eventually(() => world.feedback(), {
      within: 5_000,
      label: "trusted input frame observations are complete",
      until: (value) => value.started >= 20 && value.samples.length === value.started,
    });
    const values = feedback.samples.map((sample) => sample.ms).sort((left, right) => left - right);
    const percentile = (fraction: number) => values[Math.max(0, Math.ceil(values.length * fraction) - 1)];
    expect(values.length).toBeGreaterThanOrEqual(20);
    expect(feedback.samples.every((sample) => Number.isFinite(sample.ms) && sample.ms >= 0 && sample.observed)).toBe(true);
    const requests = await world.submissionWitness();
    expect(requests).toMatchObject({ connected: true, submissions: [] });
    evidence.recordAssertionEvidence("Local draft feedback is measured separately from model time", JSON.stringify({
      phase: feedback.phase, viewport: feedback.viewport, samples: values.length,
      p50Ms: percentile(0.5), p95Ms: percentile(0.95),
      submissions: requests.submissions.length,
      scope: "headless development build; observed DOM in frame callbacks, not display-device paint or whole-task latency",
    }), feedback.samples.every((sample) => sample.observed) && requests.connected && requests.submissions.length === 0);
  });

  await step("reload restores both drafts and never turns them into sent messages", async () => {
    const previousDocument = await world.documentGeneration();
    await user.reload();
    const currentDocument = await probe.eventually(() => world.documentGeneration(), {
      within: 30_000, label: "reload creates a new document", until: (value) => value !== previousDocument,
    });
    expect(currentDocument).not.toBe(previousDocument);
    await user.see("composer", { editable: true, text: SECOND });
    const second = await probe.composer();
    await user.click({ text: world.first.title });
    await user.see("composer", { editable: true, text: FIRST });
    const first = await probe.composer();
    expect(first.userMessageCount).toBe(0);
    expect(second.userMessageCount).toBe(0);
    const requests = await world.submissionWitness();
    expect(requests).toMatchObject({ connected: true, submissions: [] });
    expect(requests.documentRequests).toBeGreaterThan(0);
    evidence.recordAssertionEvidence("Reload preserves independent drafts without replay", `New document confirmed; first: ${first.userMessageCount} user messages; second: ${second.userMessageCount} user messages; prompt submissions: ${requests.submissions.length}; reload document requests: ${requests.documentRequests}; both drafts intact`, first.userMessageCount === 0 && second.userMessageCount === 0 && first.draftText === FIRST && second.draftText === SECOND && requests.connected && requests.submissions.length === 0 && requests.documentRequests > 0);
    await user.screenshot();
  });
});
