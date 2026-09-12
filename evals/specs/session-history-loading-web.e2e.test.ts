import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { mixedHistoryWeb } from "../worlds/session-history-loading.ts";

const test = spec.world(mixedHistoryWeb, { timeout: 600_000, resources: { surfaces: ["appWeb"], services: [] } });

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function witness(value: unknown) {
  if (!record(value) || !Array.isArray(value.opens) || !Array.isArray(value.reads)
    || typeof value.installedAt !== "number" || typeof value.samples !== "number") throw new Error("Missing initial history observer");
  return {
    installedAt: value.installedAt, samples: value.samples, expired: value.expired,
    opens: value.opens.map((opening: unknown) => {
      if (!record(opening) || typeof opening.at !== "number" || typeof opening.samples !== "number") throw new Error("Invalid opening witness");
      return { sessionId: opening.sessionId, at: opening.at, samples: opening.samples, trusted: opening.trusted, initialRows: opening.initialRows, statusSeen: opening.statusSeen };
    }),
    reads: value.reads.map((read: unknown) => {
      if (!record(read) || typeof read.startedAt !== "number" || typeof read.parts !== "number" || typeof read.messages !== "number"
        || typeof read.reasoning !== "number" || typeof read.tools !== "number"
        || (read.deliveredAt !== null && typeof read.deliveredAt !== "number")) throw new Error("Invalid history read witness");
      return { sessionId: read.sessionId, limit: read.limit, startedAt: read.startedAt, deliveredAt: read.deliveredAt, messages: read.messages, parts: read.parts, reasoning: read.reasoning, tools: read.tools };
    }),
  };
}

test("mixed active history clears its loading status and short history never announces earlier messages", async ({ user, agent, probe, step, world, evidence, place }) => {
  const surface = `[data-session-surface-id="${world.long.sessionId}"]`;
  const read = () => probe.storage(world.storageKey, witness);
  const rows = () => probe.dom(`${surface} [data-message-role="user"]`);
  await user.reload();
  await user.see({ testId: `sidebar-session-${world.long.sessionId}` }, { timeoutMs: 60_000 });
  expect((await read()).opens).toHaveLength(0);
  expect((await probe.dom(surface)).elements).toHaveLength(0);

  await step("more than 1000 mixed parts remain active while the uncapped read is held", async () => {
    await user.click({ testId: `sidebar-session-${world.long.sessionId}` });
    await probe.eventually(async () => {
      const state = await read();
      expect(state.expired).toBe(false);
      return state.reads.find(item => item.sessionId === world.long.sessionId && item.limit === null);
    }, { within: 15_000, label: "uncapped mixed history request starts", until: value => Boolean(value) });
    const state = await read();
    const full = state.reads.find(item => item.sessionId === world.long.sessionId && item.limit === null);
    expect(full?.parts).toBeGreaterThan(1000);
    expect(full?.reasoning).toBe(world.turns * 4);
    expect(full?.tools).toBe(world.turns * 4 + 1);
    expect(full?.messages).toBe(world.turns * 2);
    expect(full?.deliveredAt).toBeNull();
    expect((await rows()).elements.some(row => row.text.includes(world.first))).toBe(false);
    await probe.eventually(() => probe.dom(`${surface} [data-thread-history-status]`), {
      within: 5_000, label: "genuine earlier-history loading status is present", until: value => value.elements.length === 1,
    });
    await user.see({ role: "button", label: "Stop" });
    evidence.recordAssertionEvidence("More than 1000 mixed tool/reasoning parts load for an active session", JSON.stringify(state), true);
  });

  await step("switching away from pending history never shows its status in the short session's initial load", async () => {
    await user.click({ testId: `sidebar-session-${world.short.sessionId}` });
    const shortSurface = `[data-session-surface-id="${world.short.sessionId}"]`;
    await probe.eventually(read, {
      within: 10_000, label: "short initial preview and uncapped read are both observed", until: state => {
        const reads = state.reads.filter(item => item.sessionId === world.short.sessionId);
        const opening = state.opens.find(item => item.sessionId === world.short.sessionId);
        return reads.some(item => item.limit === 24 && item.deliveredAt !== null)
          && reads.some(item => item.limit === null && item.deliveredAt !== null) && Boolean(opening && opening.samples >= 30);
      },
    });
    await user.see({ text: world.shortText });
    expect((await probe.dom(`${shortSurface} [data-thread-history-status]`)).elements).toHaveLength(0);
    expect((await probe.dom(`${shortSurface} [data-message-role="user"]`)).elements).toHaveLength(1);
    expect((await probe.dom(`${shortSurface} [data-message-id]`)).elements.some(row => row.text.includes(world.first))).toBe(false);
    const state = await read();
    const opening = state.opens.find(item => item.sessionId === world.short.sessionId);
    if (!opening) throw new Error("Short opening was not observed");
    expect(opening).toMatchObject({ trusted: true, initialRows: 0, statusSeen: false });
    expect(opening.at).toBeGreaterThan(state.installedAt);
    const shortReads = state.reads.filter(item => item.sessionId === world.short.sessionId);
    expect(shortReads.every(item => item.startedAt >= opening.at)).toBe(true);
    expect(state.reads.filter(item => item.sessionId === world.long.sessionId && item.limit === null).every(item => item.deliveredAt === null)).toBe(true);
    expect(state.expired).toBe(false);
    evidence.recordAssertionEvidence("Short session never renders history status during initial preview or full loading", JSON.stringify(state), true);
  });

  await user.click({ testId: `sidebar-session-${world.long.sessionId}` });
  await probe.eventually(() => probe.dom(`${surface} [data-thread-history-status]`), {
    within: 5_000, label: "returning to pending long history resumes loading", until: value => value.elements.length === 1,
  });
  await step("scrolling to the top clears the status within 10 seconds and renders the first user row", async () => {
    await agent.run("session.scroll_top");
    await world.release();
    const complete = await probe.eventually(async () => {
      const status = await probe.dom(`${surface} [data-thread-history-status], ${surface} [data-thread-loading], ${surface} [data-testid="session-error-card"]`);
      const history = await rows();
      const mounted = await probe.dom(`${surface} [data-thread-history-complete="true"]`);
      return { status: status.elements.length, users: history.elements.length, first: history.elements[0]?.text, complete: mounted.elements.length };
    }, { within: 10_000, label: "earliest user row without orphaned history status", until: value => value.status === 0 && value.complete === 1 && value.users === world.turns && Boolean(value.first?.includes(world.first)) });
    await agent.run("session.scroll_top");
    await probe.eventually(() => probe.dom(`${surface} [data-thread-scroll], ${surface} [data-message-role="user"]`), {
      within: 5_000, label: "first user row is visible at the top", until: ({ elements }) => {
        const [viewport, first] = elements;
        return Boolean(viewport && first && first.text.includes(world.first) && first.rect.height > 0 && first.rect.top >= viewport.rect.top && first.rect.top < viewport.rect.bottom);
      },
    });
    expect((await read()).opens[0]).toMatchObject({ trusted: true, statusSeen: true, initialRows: 0 });
    evidence.recordAssertionEvidence("History status disappears within 10 seconds and the first user row renders", JSON.stringify({ complete, witness: await read() }), true);
  });

  await step("PageUp and Find do not resurrect history loading or lose earlier messages", async () => {
    await user.press(place.kind === "local" && process.platform === "darwin" ? "Meta+f" : "Control+f");
    await user.type({ placeholder: "Find in conversation" }, "Mixed history user 120", { replace: true });
    await user.see({ text: /^Mixed history user 120$/ });
    await user.click({ role: "button", label: "Close find" });
    await user.click({ text: /^Mixed history user 120$/ });
    const before = (await rows()).elements[119];
    if (!before) throw new Error("Find did not retain user 120");
    await user.press("PageUp");
    const after = await probe.eventually(rows, { within: 5_000, label: "PageUp moves the reading position above its Find anchor", until: ({ elements }) => (elements[119]?.rect.top ?? 0) > before.rect.top + 16 });
    expect(after.elements).toHaveLength(world.turns);
    const status = (await probe.dom(`${surface} [data-thread-history-status]`)).elements.length;
    expect(status).toBe(0);
    evidence.recordAssertionEvidence("PageUp and Find retain earlier messages without reviving history status", JSON.stringify({ users: after.elements.length, before: before.rect.top, after: after.elements[119]?.rect.top, status }), true);
  });
});
