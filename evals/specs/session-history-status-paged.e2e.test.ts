import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { pagedHistoryStatusWeb } from "../worlds/session-history-status-paged.ts";

const test = spec.world(pagedHistoryStatusWeb, { timeout: 600_000, resources: { surfaces: ["appWeb"], services: [] } });

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function witness(value: unknown) {
  if (!record(value) || !Array.isArray(value.reads) || !Array.isArray(value.opens) || typeof value.samples !== "number") {
    throw new Error("Paged history witness is missing");
  }
  return {
    samples: value.samples, expired: value.expired,
    reads: value.reads.map((item) => {
      if (!record(item) || typeof item.sessionId !== "string" || (item.limit !== null && typeof item.limit !== "number")
        || (item.before !== null && typeof item.before !== "string") || (item.nextCursor !== null && typeof item.nextCursor !== "string")
        || (item.deliveredAt !== null && typeof item.deliveredAt !== "number") || typeof item.messages !== "number") {
        throw new Error("Invalid paged history read");
      }
      return { sessionId: item.sessionId, limit: item.limit, before: item.before, nextCursor: item.nextCursor,
        deliveredAt: item.deliveredAt, messages: item.messages };
    }),
    opens: value.opens.map((item) => {
      if (!record(item) || typeof item.sessionId !== "string" || typeof item.samples !== "number") throw new Error("Invalid opening witness");
      return { sessionId: item.sessionId, samples: item.samples, statusSeen: item.statusSeen };
    }),
  };
}

test("paged history clears status across an owner change and after the final page", async ({ user, agent, probe, step, world, evidence }) => {
  const read = () => probe.storage(world.storageKey, witness);
  const surface = (sessionId: string) => `[data-session-surface-id="${sessionId}"]`;
  await user.reload();
  await user.see({ testId: `sidebar-session-${world.long.sessionId}` }, { timeoutMs: 60_000 });

  await step("a delayed final page announces loading and exposes retry", async () => {
    await user.click({ testId: `sidebar-session-${world.long.sessionId}` });
    await user.see({ text: world.latestUser });
    await user.click({ text: world.latestUser });
    await user.press("Tab");
    await user.press("Home");
    const pending = await probe.eventually(read, { within: 10_000, label: "delayed cursor page starts", until: (state) =>
      Boolean(state.reads.find((item) => item.sessionId === world.long.sessionId && item.before !== null && item.deliveredAt === null)) });
    expect(pending.expired).toBe(false);
    await probe.eventually(() => probe.dom(`${surface(world.long.sessionId)} [data-thread-history-status]`), {
      within: 5_000, label: "earlier page loading status appears", until: ({ elements }) => elements.length === 1,
    });
    const cursorRead = pending.reads.find((item) => item.sessionId === world.long.sessionId && item.before !== null && item.deliveredAt === null);
    expect(cursorRead).toMatchObject({ limit: 24, nextCursor: null, messages: 6 });
    await world.failOlder();
    await user.see({ role: "button", label: "Retry" });
    evidence.recordAssertionEvidence("The final 24-message page contract exposes a retryable six-message remainder", JSON.stringify(pending), true);
  });

  await step("changing owners removes a pending retry and a complete short session never announces earlier history", async () => {
    await user.click({ role: "button", label: "Retry" });
    await probe.eventually(read, { within: 10_000, label: "final page retry starts", until: (state) =>
      state.reads.filter((item) => item.sessionId === world.long.sessionId && item.before !== null).length >= 2 });
    await user.click({ testId: `sidebar-session-${world.short.sessionId}` });
    await user.see({ text: world.shortText });
    const state = await probe.eventually(read, { within: 5_000, label: "short page settles without a cursor", until: (value) => {
      const reads = value.reads.filter((item) => item.sessionId === world.short.sessionId);
      const opening = value.opens.find((item) => item.sessionId === world.short.sessionId);
      return reads.some((item) => item.limit === 24 && item.deliveredAt !== null) && Boolean(opening && opening.samples >= 20);
    } });
    const opening = state.opens.find((item) => item.sessionId === world.short.sessionId);
    expect(opening?.statusSeen).toBe(false);
    expect((await probe.dom(`${surface(world.short.sessionId)} [data-thread-history-status]`)).elements).toHaveLength(0);
    expect(state.reads.filter((item) => item.sessionId === world.long.sessionId && item.before !== null).every((item) => item.deliveredAt === null)).toBe(true);
    evidence.recordAssertionEvidence("Changing owners removes the pending retry and short history never renders its status", JSON.stringify(state), true);
  });

  await step("the final page clears its status and Find retains one copy of an older message", async () => {
    await user.click({ testId: `sidebar-session-${world.long.sessionId}` });
    await user.see({ text: world.latestUser });
    await user.click({ text: world.latestUser });
    await user.press("Tab");
    await user.press("Home");
    await probe.eventually(read, { within: 10_000, label: "final cursor page restarts after owner return", until: (state) =>
      state.reads.filter((item) => item.sessionId === world.long.sessionId && item.before !== null).length >= 3 });
    await world.releaseOlder();
    const complete = await probe.eventually(async () => ({ state: await read(), status: await probe.dom(`${surface(world.long.sessionId)} [data-thread-history-status]`) }), {
      within: 10_000, label: "final page completes and status clears", until: ({ state, status }) =>
        state.reads.filter((item) => item.sessionId === world.long.sessionId && item.before !== null)
          .some((item) => item.deliveredAt !== null && item.nextCursor === null) && status.elements.length === 0,
    });
    await user.click({ role: "button", label: "Find in conversation" });
    await user.type({ placeholder: "Find in conversation" }, world.findText, { replace: true });
    await user.see({ text: world.findText });
    expect((await probe.dom(`${surface(world.long.sessionId)} [data-thread-history-status]`)).elements).toHaveLength(0);
    const transcript = await agent.run("session.read_transcript", { count: 30 });
    if (!record(transcript) || !Array.isArray(transcript.messages)) throw new Error("Complete transcript witness is missing");
    expect(transcript).toMatchObject({ historyComplete: true, messageCount: 30, returned: 30 });
    expect(transcript.messages.filter((message) => record(message) && message.text === `You\n${world.findText}`)).toHaveLength(1);
    evidence.recordAssertionEvidence("The final page clears its status and Find retains one older row", JSON.stringify({ complete, transcript }), true);
  });
});
