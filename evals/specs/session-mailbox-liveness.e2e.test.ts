import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { NO_WINDOW_ERROR, sessionMailboxLiveness } from "../worlds/session-mailbox-liveness.ts";

const test = spec.world(sessionMailboxLiveness, {
  timeout: 10 * 60_000,
  resources: {
    surfaces: ["desktop"], services: ["mock"],
    nativeReason: "Observes real renderer mailbox polling in a spawned isolated dev Electron and makes independent runner requests to its loopback server.",
  },
});

test("investigative: a synthetic single-poll body gap expires mailbox registration while the renderer stays alive, and releasing it restores context", async ({ world, probe, step, evidence }) => {
  const visible = (state: Awaited<ReturnType<typeof world.renderer>>) => {
    expect(state).toMatchObject({ hash: world.route, documentReady: true, composerVisible: true, failure: null });
    expect(state.activeRows).toEqual(expect.arrayContaining(world.rootTargets.map(target => target.sessionId)));
  };
  const idle = (snapshot: Awaited<ReturnType<typeof world.readEngine>>) => {
    expect(snapshot.sessions).toHaveLength(5);
    for (const session of snapshot.sessions) expect(session).toMatchObject({ archivedAt: 0, idle: true, messageCount: 0, todoCount: 0 });
  };
  const contextSucceeded = (response: Awaited<ReturnType<typeof world.readContext>>) => {
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ ok: true, context: {
      schemaVersion: 1, revision: expect.any(Number),
      screen: { kind: "conversation", route: world.route.slice(1), workspaceId: world.workspaceId },
    } });
    expect(response.elapsedMs).toBeLessThan(5_000);
  };
  evidence.recordJsonArtifact("Mailbox liveness contract", {
    fixture: "archiveActiveSessions; fresh spawned local source Electron, two workspaces and five idle sessions",
    boundary: "Only the next real GET /experimental/ui-control/pending response.text completion is held, after its actual response bytes are buffered; no response content is invented",
    reason: "A fetch-promise hold would hit the existing 15-second header deadline and permit replacement polls. Body consumption is outside that deadline.",
    clock: "Real Date.now plus independent performance.now; 21 seconds measured from the held response body, after server registration",
    expiry: "45-second renderer safety release, explicit release, and finally cleanup",
    traffic: "No injected SSE, no socket saturation, no direct runner pending poll, no engine writes by diagnostic requests",
    health: "GET /health is documented in apps/server/README.md; runner health is independent of Chromium",
    credentials: "Fixture tokens remain only in memory; response evidence projects an allowlisted context subset",
    scope: "Synthetic polling-gap -> no-window -> recovery only; not the original incident cause and not a proposed production fix",
  });

  try {
    const baseline = await step("an actual renderer poll registers the isolated window and a completed runner context read succeeds", async () => {
      await probe.eventually(() => world.renderer(), {
        within: 30_000, label: "actual renderer poll has returned real server bytes",
        until: state => state.pollsReturned > 0,
      });
      contextSucceeded(await world.readContext());
      const renderer = await probe.eventually(() => world.renderer(), {
        within: 3_000, label: "the baseline context was delivered and replied to by the renderer",
        until: state => state.deliveredContexts === 1 && state.replyPosts === 1,
      });
      visible(renderer);
      expect(renderer).toMatchObject({ holdCount: 0, deliveredOther: 0, engineWriteAttempts: 0 });
      const engine = await world.readEngine();
      idle(engine);
      const health = await world.health();
      expect(health.status).toBe(200);
      expect(health.elapsedMs).toBeLessThan(2_000);
      evidence.recordJsonArtifact("Registered window controls", { renderer, engine, health, contextRequests: world.contextRequests() });
      return { renderer, engine };
    });

    await world.arm();
    const held = await step("only the next renderer pending fetch body is held with actual interception and response timestamps", async () => {
      const state = await probe.eventually(() => world.renderer(), {
        within: 30_000, label: "next real pending response reaches its one-shot body boundary",
        until: value => value.held,
      });
      visible(state);
      expect(state).toMatchObject({
        holdCount: 1, armed: false, releasedAt: null, expired: false, heldItems: 0,
        pollsInFlight: 0, deliveredContexts: 1, deliveredOther: 0, replyPosts: 1, engineWriteAttempts: 0,
      });
      if (state.interceptedAt === null || state.heldAt === null || state.lastPollCompletedAt === null) {
        throw new Error("Held real poll is missing its interception or completion timestamps");
      }
      expect(state.interceptedAt).toBeLessThanOrEqual(state.heldAt);
      expect(state.lastPollStartedAt).toBe(state.interceptedAt);
      expect(state.lastPollCompletedAt).toBeLessThanOrEqual(state.heldAt);
      expect(state.pollsCompleted).toBe(state.pollsCompletedAtHold);
      expect(state.pollsReturned).toBe(state.pollsCompleted - 1);
      expect(state.timeOrigin).toBe(baseline.renderer.timeOrigin);
      evidence.recordJsonArtifact("One held actual pending response", state);
      return state;
    });

    await step("after 21 real seconds without another poll, direct context immediately reports exactly no-window while DOM and heartbeats remain live", async () => {
      const gap = await probe.eventually(() => world.renderer(), {
        within: 25_000, label: "real 21-second polling gap with renderer interval and animation frames still running",
        until: state => state.heldElapsedMs >= 21_000 && state.heldMonotonicMs >= 21_000,
      });
      visible(gap);
      expect(gap).toMatchObject({ held: true, releasedAt: null, expired: false, holdCount: 1, pollsInFlight: 0 });
      expect(gap.pollsStarted).toBe(held.pollsStartedAtHold);
      expect(gap.pollsCompleted).toBe(held.pollsCompletedAtHold);
      expect(gap.pollsReturned).toBe(held.pollsReturned);
      expect(gap.lastPollStartedAt).toBe(held.interceptedAt);
      expect(gap.heldElapsedMs).toBeGreaterThanOrEqual(21_000);
      expect(gap.heldElapsedMs).toBeLessThan(45_000);
      expect(gap.heldMonotonicMs).toBeGreaterThanOrEqual(21_000);
      expect(Math.abs(gap.heldElapsedMs - gap.heldMonotonicMs)).toBeLessThan(1_000);
      expect(gap.ticks - held.ticks).toBeGreaterThan(100);
      expect(gap.frames - held.frames).toBeGreaterThan(30);
      expect(gap.maxTickGapMs).toBeLessThan(1_500);
      expect(gap.timeOrigin).toBe(baseline.renderer.timeOrigin);
      const response = await world.readContext();
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ ok: false, error: NO_WINDOW_ERROR });
      expect(response.elapsedMs).toBeLessThan(1_000);
      const health = await world.health();
      expect(health).toMatchObject({ transport: "runner-fetch", path: "/health", status: 200 });
      expect(health.elapsedMs).toBeLessThan(2_000);
      const rendererHealth = await world.rendererHealth();
      expect(rendererHealth).toMatchObject({ transport: "renderer-fetch", path: "/health", status: 200 });
      expect(rendererHealth.elapsedMs).toBeLessThan(2_000);
      const engine = await world.readEngine();
      expect(engine).toEqual(baseline.engine);
      const stillHeld = await world.renderer();
      visible(stillHeld);
      expect(stillHeld).toMatchObject({ held: true, expired: false, holdCount: 1, deliveredContexts: 1, deliveredOther: 0, replyPosts: 1, engineWriteAttempts: 0 });
      expect(stillHeld.pollsStarted).toBe(held.pollsStartedAtHold);
      expect(stillHeld.pollsCompleted).toBe(held.pollsCompletedAtHold);
      expect(world.contextRequests()).toBe(2);
      evidence.recordJsonArtifact("Expired registration with independent live controls", { gap, stillHeld, response, health, rendererHealth, engine });
      evidence.recordAssertionEvidence("A live renderer can lose recent-poll mailbox registration",
        `One real pending response body remained held for ${gap.heldElapsedMs} ms with advancing interval/RAF heartbeats and unchanged DOM route. The runner context POST returned the exact no-window error in ${response.elapsedMs} ms, not the five-second reply timeout; health stayed reachable and engine state was unchanged.`, true);
    });

    await step("releasing only that body resumes actual polling before one safe context request recovers", async () => {
      const release = await world.release();
      expect(release).toMatchObject({ held: false, expired: false, holdCount: 1 });
      expect(release.releasedAt).not.toBeNull();
      await probe.eventually(() => world.renderer(), {
        within: 20_000, label: "a fresh real renderer poll completes after release, without diagnostic POST retries",
        until: state => state.pollsCompleted > held.pollsCompletedAtHold && state.pollsReturned === state.pollsCompleted,
      });
      const response = await world.readContext();
      contextSucceeded(response);
      const recovered = await probe.eventually(() => world.renderer(), {
        within: 3_000, label: "only the baseline and recovered contexts were delivered; rejected context was never enqueued",
        until: state => state.deliveredContexts === 2 && state.replyPosts === 2,
      });
      visible(recovered);
      expect(recovered).toMatchObject({ held: false, expired: false, holdCount: 1, deliveredOther: 0, engineWriteAttempts: 0 });
      expect(recovered.timeOrigin).toBe(baseline.renderer.timeOrigin);
      expect(world.contextRequests()).toBe(3);
      expect(await world.readEngine()).toEqual(baseline.engine);
      evidence.recordJsonArtifact("Actual mailbox recovery without replay or engine mutation", { release, response, recovered, contextRequests: world.contextRequests() });
      evidence.recordAssertionEvidence("Releasing the synthetic body gap restores the same window's mailbox",
        "Actual renderer polling resumed before one context POST succeeded. Exactly two contexts reached the renderer across three completed POSTs; no query/command was delivered, no engine write was attempted, no session changed, and the original document remained alive. This establishes the synthetic mechanism only.", true);
    });
  } finally {
    try {
      evidence.recordJsonArtifact("Final mailbox state, including unsuccessful runs", await world.renderer());
    } finally {
      try {
        const released = await world.release();
        expect(released.held).toBe(false);
        evidence.recordJsonArtifact("Mailbox hold released in finally", released);
      } finally {
        expect(await world.disposeObserver()).toEqual({ observerRemoved: true });
      }
    }
  }
});
