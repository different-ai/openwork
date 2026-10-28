import { describe, expect, it } from "vitest";
import { startMockMcp } from "@openwork/labs";
import { inspectStreamFeedback, streamFeedbackDistribution, streamFeedbackStayedCollapsed, type StreamFeedbackSample } from "../worlds/stream-feedback-summary.ts";

const sample = (kind: "text" | "reasoning", delay: number): StreamFeedbackSample => ({
  kind, token: kind, receivedAt: 10, domAt: 10 + delay, frameAt: 11 + delay, terminalAtFrame: false,
});

describe("stream feedback evidence", () => {
  it("uses nearest rank and retains every sample including tail outliers", () => {
    expect(streamFeedbackDistribution([100, ...Array.from({ length: 19 }, (_, i) => i)])).toEqual({ n: 20, p50Ms: 9, p95Ms: 18, maxMs: 100 });
    const summary = inspectStreamFeedback([sample("text", 3), sample("reasoning", 8)], 30).map(({ kind, dom, frame }) => ({ kind, dom, frame }));
    expect(summary).toEqual([
      { kind: "reasoning", dom: { n: 1, p50Ms: 8, p95Ms: 8, maxMs: 8 }, frame: { n: 1, p50Ms: 9, p95Ms: 9, maxMs: 9 } },
      { kind: "text", dom: { n: 1, p50Ms: 3, p95Ms: 3, maxMs: 3 }, frame: { n: 1, p50Ms: 4, p95Ms: 4, maxMs: 4 } },
    ]);
  });

  it("retains missing, invalid and post-completion observations instead of dropping them", () => {
    for (const values of [[], [-1], [NaN], [Infinity]]) expect(() => streamFeedbackDistribution(values)).toThrow();
    expect(inspectStreamFeedback([], 30).every(report => report.received === 0 && report.frame === null)).toBe(true);
    const report = inspectStreamFeedback([
      { ...sample("reasoning", 8), token: "pending", frameAt: null },
      { ...sample("reasoning", 8), token: "late", terminalAtFrame: true },
      { ...sample("reasoning", 8), token: "invalid", frameAt: 11 },
    ], 30)[0];
    expect(report.received).toBe(3);
    expect(report.censored.map(item => item.token)).toEqual(["pending"]);
    expect(report.postCompletion).toEqual(["late"]);
    expect(report.invalid).toEqual(["invalid"]);
    expect(report.distributionScope).toContain("incomplete");
  });

  it("retains slow opening arrivals as pending/censored rather than improving the observed distribution", () => {
    const pending = { ...sample("reasoning", 8), token: "during-opening", receivedAt: 100, domAt: null, frameAt: null, terminalAtFrame: null };
    const report = inspectStreamFeedback([pending, sample("reasoning", 8), sample("text", 3)], 2100)[0];
    expect(report.received).toBe(2);
    expect(report.censored).toEqual([{ token: "during-opening", missingDom: true, missingFrame: true, atLeastMs: 2000 }]);
    expect(report.distributionScope).toContain("incomplete");
    expect(report.frame?.n).toBe(1);
    const visible = inspectStreamFeedback([{ ...pending, domAt: 2110, frameAt: 2120, terminalAtFrame: false }], 2130)[0];
    expect(visible.frame?.p95Ms).toBe(2020);
    expect(visible.censored).toHaveLength(0);
  });

  it("rejects an automatic opening even if the final pre-click snapshot is collapsed", () => {
    const closed = { at: 1, source: "frame", expanded: false, bodyVisible: false, receivedReasoning: 1 };
    // Contextual typing keeps this fixture on the same trace protocol as the world.
    expect(streamFeedbackStayedCollapsed([{ ...closed, source: "frame" }], false)).toBe(true);
    expect(streamFeedbackStayedCollapsed([
      { ...closed, source: "frame" }, { at: 2, source: "attribute-history", expanded: true, bodyVisible: false, receivedReasoning: 2 },
      { ...closed, at: 3, source: "intent" },
    ], false)).toBe(false);
    expect(streamFeedbackStayedCollapsed([{ ...closed, source: "frame", bodyVisible: true }], false)).toBe(false);
    expect(streamFeedbackStayedCollapsed([{ ...closed, source: "frame" }], true)).toBe(false);
    expect(streamFeedbackStayedCollapsed([{ ...closed, source: "frame", receivedReasoning: 0 }], false)).toBe(false);
  });

  it("serves exact reasoning SSE deltas before the held answer through the shared HTTP provider", async () => {
    await using provider = await startMockMcp({ isolatedProcessEnv: true, agentWorkloads: [{
      promptMarker: "STREAM_FEEDBACK_HTTP", finalReply: "answer", finalReplyInitiallyReleasedChunks: 0,
      finalReasoning: "first second", finalReasoningChunks: ["first ", "second"], steps: [],
    }] });
    const response = await fetch(`${provider.url}/v1/chat/completions`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "stream-feedback-model", stream: true,
        tools: [{ type: "function", function: { name: "unused", parameters: { type: "object" } } }],
        messages: [{ role: "user", content: "STREAM_FEEDBACK_HTTP" }] }),
      signal: AbortSignal.timeout(15_000),
    });
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Provider response had no SSE body");
    const decoder = new TextDecoder();
    let received = "";
    while (!received.includes('"reasoning_content":"second"')) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error("Provider completed before reasoning arrived");
      received += decoder.decode(chunk.value, { stream: true });
    }
    expect(received).toContain('"reasoning_content":"first "');
    expect(received).not.toContain('"content":"answer"');
    const held = await provider.agentReplyState("STREAM_FEEDBACK_HTTP");
    expect(held.complete).toBe(false);
    expect(held.deliveredChunks).toBe(0);
    await provider.releaseAgentReply("STREAM_FEEDBACK_HTTP");
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      received += decoder.decode(chunk.value, { stream: true });
    }
    expect(received).toContain('"content":"answer"');
    expect(received).toContain("[DONE]");
    expect((await provider.agentReplyState("STREAM_FEEDBACK_HTTP")).complete).toBe(true);
    reader.releaseLock();
  });
});
