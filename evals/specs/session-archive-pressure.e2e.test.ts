import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { archivePressureMode, sessionArchivePressure } from "../worlds/session-archive-pressure.ts";

const mode = archivePressureMode();
const test = spec.world(sessionArchivePressure, {
  timeout: 10 * 60_000,
  resources: {
    surfaces: ["desktop"], services: ["mock"],
    nativeReason: "Exercises the isolated Electron renderer's HTTP/1.1 connection pool, sidebar archive hook, and renderer control affordance against its own loopback server.",
  },
});

const title = mode === "baseline"
  ? "investigative baseline: real SSE pool pressure times out sidebar archive before PATCH and releasing it recovers the renderer affordance"
  : "regression: sidebar archive succeeds while real same-origin HTTP/1.1 SSE pressure remains held";

test(title, async ({ world, user, agent, probe, step, evidence }) => {
  const { target, selected, targetPath } = world;
  const route = `#/workspace/${selected.workspaceId}/session/${selected.sessionId}`;
  let establishedKeys: string[] = [];
  const stamp = (value: Awaited<ReturnType<typeof world.readEngine>>) => value.sessions
    .map(session => ({ ...session })).sort((left, right) => left.sessionId.localeCompare(right.sessionId));
  const held = async () => {
    const renderer = await world.renderer();
    const streams = renderer.streams.filter(stream => stream.established && !stream.closed);
    expect(renderer.released).toBe(false);
    expect(renderer.expired).toBe(false);
    expect(renderer.streams).toHaveLength(8);
    expect(renderer.streams.every(stream => !stream.closed && stream.error === null)).toBe(true);
    expect(streams.length).toBeGreaterThanOrEqual(1);
    expect(streams.length).toBeLessThanOrEqual(6);
    expect(renderer.streams.filter(stream => stream.status === null).length).toBeGreaterThan(0);
    expect([...new Set(renderer.streams.map(stream => stream.path))].sort()).toEqual([...world.eventPaths].sort());
    for (const stream of streams) {
      expect(stream).toMatchObject({ status: 200, contentType: "text/event-stream" });
      expect(stream.chunks).toBeGreaterThan(0);
    }
    const network = world.network();
    expect(network.filter(request => request.method === "GET" && request.fixtureKey?.startsWith("stream-"))).toHaveLength(8);
    const connections = streams.map(stream => {
      const request = network.find(request => request.method === "GET" && request.fixtureKey === stream.key);
      expect(request).toMatchObject({ path: stream.path, status: 200, protocol: "http/1.1", wireRequestObserved: true, finished: false });
      expect(request?.connectionId).toBeGreaterThan(0);
      return request?.connectionId;
    });
    expect(new Set(connections).size).toBe(streams.length);
    const keys = streams.map(stream => stream.key).sort();
    // The app's finite requests/long poll can free additional slots. Pressure
    // may grow, but none of the initially established blockers may disappear.
    if (establishedKeys.length) expect(keys).toEqual(expect.arrayContaining(establishedKeys));
    return { renderer, network, establishedKeys: keys, establishedCount: streams.length };
  };
  const unchangedNeighbors = (value: Awaited<ReturnType<typeof world.readEngine>>) => {
    for (const session of value.sessions.filter(session => session.sessionId !== target.sessionId)) {
      expect(session).toMatchObject({ archivedAt: 0, idle: true, messageCount: 0 });
    }
    expect(value.sessions.map(session => session.sessionId).sort()).toEqual(world.targets.map(session => session.sessionId).sort());
  };
  evidence.recordJsonArtifact("Archive pressure contract", {
    mode,
    fixture: "archiveActiveSessions: two workspaces, five empty idle sessions; no installed app or direct database access",
    injection: "Eight real renderer fetches to fixture /workspace/{id}/opencode/event; bodies drained until explicit AbortController cleanup",
    sameOrigin: "All injected streams, canaries and observed application requests share the exact fixture server scheme/host/port; the Electron document itself may have a different origin",
    establishedCount: "Counts only injected streams with received body bytes and HTTP/1.1 response metadata; existing app subscriptions are not included",
    saturation: "A previously successful renderer GET must queue without headers for its real two-second abort deadline while SSE connections remain open",
    readback: "Authenticated runner fetch is read-only and independent of the renderer pool; credentials stay in memory",
    scope: "Controlled transport hypothesis, not proof of a production incident; mailbox registration/expiry is not covered",
  });

  try {
    await step("the isolated fixture has two workspaces and idle nonpinned short sessions before transport pressure", async () => {
      // Route setup is not the behavior under test; the archive below remains
      // a trusted sidebar click. Avoid a hover-preview row intercepting setup.
      expect(await agent.run("session.open", { sessionId: selected.sessionId })).toMatchObject({ ok: true });
      await probe.eventually(() => probe.hash(), { within: 30_000, label: "selected fixture session opens", until: hash => hash === route });
      await user.see("composer", { editable: true });
      const inventory = await agent.run("session.list_sessions");
      for (const candidate of world.rootTargets) {
        expect(inventory).toEqual(expect.arrayContaining([
          expect.objectContaining({ sessionId: candidate.sessionId, pinned: false, working: false, status: "idle" }),
        ]));
      }
      expect(new Set(world.workspaceIds).size).toBe(2);
      const initial = await world.readEngine();
      expect(initial.sessions).toHaveLength(5);
      for (const session of initial.sessions) expect(session).toMatchObject({ archivedAt: 0, idle: true, messageCount: 0 });
      const control = await world.canary();
      expect(control).toMatchObject({ method: "GET", status: 200, abortReason: null, error: null, bodyComplete: true });
      expect(control.elapsedMs).toBeLessThan(2_000);
      const network = await probe.eventually(() => world.network(), {
        within: 3_000, label: "unpressured renderer control uses HTTP/1.1",
        until: requests => requests.some(request => request.method === "GET" && request.fixtureKey === control.fixtureKey && request.finished),
      });
      expect(network.find(request => request.method === "GET" && request.fixtureKey === control.fixtureKey))
        .toMatchObject({ path: control.path, protocol: "http/1.1", status: 200, wireRequestObserved: true, failure: null });
      evidence.recordJsonArtifact("Unpressured controls", { engine: initial, rendererGet: control });
    });

    await world.phase("pressure");
    await world.startPressure();
    await step("real SSE responses occupy the shared origin pool while timers and animation frames continue", async () => {
      await probe.eventually(() => world.renderer(), {
        within: 25_000, label: "real SSE body bytes arrive (including the server's quiet-stream heartbeat) and excess streams remain pending",
        until: value => value.streams.some(stream => stream.established)
          && value.streams.some(stream => stream.status === null),
      });
      const before = await world.renderer();
      const canary = await world.canary();
      expect(canary).toMatchObject({ method: "GET", status: null, abortReason: { name: "TimeoutError" }, error: { name: "TimeoutError" }, bodyComplete: false });
      expect(canary.elapsedMs).toBeGreaterThanOrEqual(1_800);
      expect(canary.elapsedMs).toBeLessThan(3_500);
      const queued = await probe.eventually(() => world.network(), {
        within: 3_000, label: "CDP observes cancellation without response headers for the saturated renderer GET",
        until: requests => requests.some(request => request.method === "GET" && request.fixtureKey === canary.fixtureKey && request.finished),
      });
      expect(queued.find(request => request.method === "GET" && request.fixtureKey === canary.fixtureKey))
        .toMatchObject({ path: canary.path, status: null, responseMs: null, wireRequestObserved: false, canceled: true, failure: "net::ERR_ABORTED" });
      const pressure = await held();
      establishedKeys = pressure.establishedKeys;
      expect(pressure.renderer.ticks - before.ticks).toBeGreaterThan(10);
      expect(pressure.renderer.frames - before.frames).toBeGreaterThan(5);
      expect(pressure.renderer.maxTickGapMs).toBeLessThan(1_500);
      const native = await world.readEngine();
      for (const session of native.sessions) expect(session).toMatchObject({ archivedAt: 0, idle: true, messageCount: 0 });
      expect(native.elapsedMs).toBeLessThan(10_000);
      expect(native.statusReads.map(read => read.path)).toContain(canary.path);
      for (const read of native.statusReads) expect(read.elapsedMs).toBeLessThan(1_500);
      const mainFetch = await world.mainFetchControl();
      evidence.recordJsonArtifact("Existing main-fetch pool calibration", mainFetch);
      if (mode === "fixed") {
        expect(mainFetch).toMatchObject({ completed: true, status: 200 });
        expect(mainFetch.elapsedMs).toBeLessThan(1_500);
      }
      evidence.recordJsonArtifact("Established HTTP/1.1 pressure and responsive event loop", { ...pressure, canary, independentEngine: native });
      evidence.recordAssertionEvidence("Network pressure is real rather than a blocked JavaScript promise",
        `${pressure.establishedCount} injected SSE streams delivered bytes on distinct HTTP/1.1 connections; excess streams and the two-second GET had no headers. Renderer timers/frames advanced and runner-side engine reads succeeded.`, true);
    });

    await world.phase("sidebar");
    const beforeArchive = await world.readEngine();
    await user.hover({ testId: `sidebar-session-${target.sessionId}` });
    await user.click({ testId: `session-archive-${target.sessionId}` });
    const outcome = await probe.eventually(() => world.renderer(), {
      within: 20_000, label: `${mode} sidebar archive reaches an observed toast outcome`,
      until: value => value.ui.failureMs !== null || value.ui.successMs !== null,
    });
    expect(outcome.ui.trustedClick).toBe(true);
    await user.notSee({ text: "This session is still working" });
    const pressureAtOutcome = await held();
    evidence.recordJsonArtifact("Sidebar result with streams still held", pressureAtOutcome);

    if (mode === "baseline") {
      await step("baseline investigative outcome is a roughly ten-second GET timeout with zero PATCH attempts", async () => {
        expect(outcome.ui).toMatchObject({ successMs: null, timeoutDescription: true });
        expect(outcome.ui.failureMs).toBeGreaterThanOrEqual(9_000);
        expect(outcome.ui.failureMs).toBeLessThan(13_000);
        expect(outcome.ui.ticks).toBeGreaterThan(40);
        expect(outcome.ui.frames).toBeGreaterThan(10);
        expect(outcome.ui.maxTickGapMs).toBeLessThan(1_500);
        await user.see({ text: "Couldn't archive session" });
        await user.see({ text: "Request timed out." });
        const failedReads = outcome.requests.filter(request => request.phase === "sidebar" && request.method === "GET" && world.ownershipPaths.includes(request.path));
        expect(failedReads).toEqual(expect.arrayContaining([expect.objectContaining({ path: targetPath, status: null, fixtureKey: null })]));
        const timedOut = failedReads.filter(request => request.abortReason?.message === "Request timed out.");
        expect(timedOut.length).toBeGreaterThan(0);
        for (const request of timedOut) {
          expect(request).toMatchObject({
            status: null, fixtureKey: null,
            abortReason: { name: "Error", message: "Request timed out." },
            error: { name: "Error", message: "Request timed out." },
          });
          expect(request.elapsedMs).toBeGreaterThanOrEqual(9_000);
          expect(request.elapsedMs).toBeLessThan(13_000);
        }
        const network = await probe.eventually(() => world.network(), {
          within: 3_000, label: "the actual archive ownership GETs abort in Chromium without receiving headers",
          until: requests => failedReads.every(read => requests.some(request => request.phase === "sidebar" && request.method === "GET" && request.path === read.path && request.finished)),
        });
        const nativeGet = network.filter(request => request.phase === "sidebar" && request.method === "GET" && world.ownershipPaths.includes(request.path));
        expect(nativeGet).toHaveLength(failedReads.length);
        for (const request of nativeGet) {
          expect(request).toMatchObject({ status: null, responseMs: null, wireRequestObserved: false, canceled: true, failure: "net::ERR_ABORTED" });
          expect(request.elapsedMs).toBeGreaterThanOrEqual(9_000);
          expect(request.elapsedMs).toBeLessThan(13_000);
        }
        expect(outcome.requests.filter(request => request.method === "PATCH")).toEqual([]);
        expect(network.filter(request => request.method === "PATCH")).toEqual([]);
        expect(stamp(await world.readEngine())).toEqual(stamp(beforeArchive));
        expect(outcome.activeRows).toContain(target.sessionId);
        expect(await probe.hash()).toBe(route);
        evidence.recordJsonArtifact("Exact baseline GET timeout and no archive mutation", { rendererGets: failedReads, timeoutGets: timedOut, chromiumGets: nativeGet, patchAttempts: 0, establishedCount: establishedKeys.length });
        evidence.recordAssertionEvidence("Investigative baseline reproduces transport starvation, not a production incident",
          `Trusted sidebar click failed with Request timed out. after ${outcome.ui.failureMs} ms; GET ${targetPath} aborted before headers, zero PATCH was attempted, all native sessions remained unchanged, and the renderer event loop continued.`, true);
      });
    } else {
      await step("fixed regression archives only its target before any injected stream is released", async () => {
        expect(outcome.ui.failureMs).toBeNull();
        expect(outcome.ui.successMs).not.toBeNull();
        expect(outcome.ui.successMs).toBeLessThan(15_000);
        await user.see({ text: `Session archived: ${target.title}` });
        await user.notSee({ text: "Couldn't archive session" });
        const native = await probe.eventually(() => world.readEngine(), {
          within: 10_000, label: "independent engine confirms the UI archive while pressure is held",
          until: value => value.sessions.some(session => session.sessionId === target.sessionId && session.archivedAt > 0),
        });
        unchangedNeighbors(native);
        expect(native.sessions.find(session => session.sessionId === target.sessionId)).toMatchObject({ idle: true, messageCount: 0 });
        const pressure = await held();
        expect(pressure.renderer.activeRows).not.toContain(target.sessionId);
        expect(pressure.renderer.activeRows).toContain(selected.sessionId);
        expect(await probe.hash()).toBe(route);
        const rendererPatches = pressure.renderer.requests.filter(request => request.method === "PATCH");
        expect(rendererPatches).toEqual([]);
        const main = await world.mainRequests();
        const patches = main.filter(request => request.action === "metadata");
        expect(patches).toEqual([expect.objectContaining({ path: targetPath, result: 200, transport: "main" })]);
        expect(main.some(request => request.path === targetPath && request.action === "session" && request.result === 200)).toBe(true);
        expect(main.filter(request => request.action === "abort" || request.action === "prompt_async")).toEqual([]);
        const stillQueued = await world.canary();
        expect(stillQueued).toMatchObject({ status: null, abortReason: { name: "TimeoutError" }, bodyComplete: false });
        await held();
        evidence.recordJsonArtifact("Fixed archive under sustained pressure", { native, pressure, stillQueued, mainRequests: main, rendererPatchAttempts: rendererPatches.length });
        evidence.recordAssertionEvidence("Fixed-mode UI archive succeeds under sustained real connection pressure",
          `The target was archived by the trusted sidebar click while the same ${establishedKeys.length} injected SSE connections stayed open; a subsequent raw renderer GET still queued. All neighbors remained unarchived and idle.`, true);
      });
    }

    await step("releasing only injected streams restores the same renderer HTTP pool", async () => {
      const released = await world.releasePressure();
      expect(released.released).toBe(true);
      expect(released.expired).toBe(false);
      expect(released.streams.every(stream => stream.closed)).toBe(true);
      await world.phase("recovery");
      const canary = await world.canary();
      expect(canary).toMatchObject({ method: "GET", status: 200, abortReason: null, error: null, bodyComplete: true });
      evidence.recordJsonArtifact("Released pool control", { streams: released.streams, canary });
    });

    if (mode === "baseline") {
      await step("the same target then archives through the renderer affordance and the same hook, without a runner-side write", async () => {
        expect(await agent.run("session.archive", { sessionId: target.sessionId, archived: true }))
          .toEqual({ ok: true, sessionId: target.sessionId, archived: true });
        await user.see({ text: `Session archived: ${target.title}` });
        const native = await probe.eventually(() => world.readEngine(), {
          within: 10_000, label: "independent readback confirms the recovered archive",
          until: value => value.sessions.some(session => session.sessionId === target.sessionId && session.archivedAt > 0),
        });
        unchangedNeighbors(native);
        const recovered = await world.renderer();
        const patches = recovered.requests.filter(request => request.method === "PATCH");
        expect(patches).toHaveLength(1);
        expect(patches[0]).toMatchObject({ phase: "recovery", path: targetPath, status: 200, abortReason: null, error: null });
        expect(recovered.requests.some(request => request.phase === "recovery" && request.path === targetPath && request.method === "GET" && request.status === 200)).toBe(true);
        const network = await probe.eventually(() => world.network(), {
          within: 3_000, label: "recovered archive PATCH completed in the renderer, not an independent main-process pool",
          until: requests => requests.some(request => request.phase === "recovery" && request.path === targetPath && request.method === "PATCH" && request.finished),
        });
        expect(network.filter(request => request.method === "PATCH"))
          .toEqual([expect.objectContaining({ phase: "recovery", path: targetPath, protocol: "http/1.1", status: 200, failure: null })]);
        expect(recovered.activeRows).not.toContain(target.sessionId);
        expect(recovered.activeRows).toContain(selected.sessionId);
        expect(await probe.hash()).toBe(route);
        evidence.recordJsonArtifact("Renderer-affordance recovery and independent readback", { native, renderer: recovered, network });
        evidence.recordAssertionEvidence("Releasing SSE pressure recovers archive through the renderer affordance",
          `session.archive archived the previously failing target. Both renderer fetch metadata and Chromium observed the successful GET/PATCH on ${targetPath}; runner fetch performed only authenticated readback. No neighbor changed.`, true);
      });
    }
    expect((await world.renderer()).requests.filter(request => request.method === "POST")).toEqual([]);
  } finally {
    try {
      evidence.recordJsonArtifact("Final pressure metadata (including unsuccessful runs)", { renderer: await world.renderer(), network: world.network() });
    } finally {
      const cleanup = await world.releasePressure();
      evidence.recordJsonArtifact("Injected SSE cleanup", { released: cleanup.released, expired: cleanup.expired, streams: cleanup.streams });
      expect(cleanup.streams.every(stream => stream.closed)).toBe(true);
      const network = await probe.eventually(() => world.network(), {
        within: 3_000, label: "all observed injected stream requests terminate in Chromium",
        until: requests => requests.filter(request => request.fixtureKey?.startsWith("stream-")).every(request => request.finished),
      });
      evidence.recordJsonArtifact("Chromium stream cleanup", network.filter(request => request.fixtureKey?.startsWith("stream-")));
    }
  }
});
