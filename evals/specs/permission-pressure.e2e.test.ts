import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { permissionPressure, permissionPressureMode } from "../worlds/permission-pressure.ts";

const mode = permissionPressureMode();
const test = spec.world(permissionPressure, {
  timeout: 10 * 60_000,
  resources: {
    surfaces: ["desktop"], services: ["mock"],
    nativeReason: "Requires an isolated source Electron HTTP/1.1 renderer pool and trusted permission button input against real native permissions.",
  },
});

test(`${mode}: external-directory Allow once under real SSE pressure preserves unrelated approval and recovers independently of inference`, async ({ world, user, agent, probe, step, evidence }) => {
  let establishedKeys: string[] = [];
  const held = async () => {
    const renderer = await world.renderer();
    expect(renderer.released).toBe(false);
    expect(renderer.expired).toBe(false);
    expect(renderer.streams).toHaveLength(8);
    expect(renderer.streams.every(stream => !stream.closed && stream.error === null)).toBe(true);
    const streams = renderer.streams.filter(stream => stream.established);
    expect(streams.length).toBeGreaterThanOrEqual(1);
    expect(streams.length).toBeLessThanOrEqual(6);
    expect(renderer.streams.some(stream => stream.status === null)).toBe(true);
    const network = world.network();
    expect(network.filter(item => item.method === "GET" && item.fixtureKey?.startsWith("stream-"))).toHaveLength(8);
    const connections = streams.map(stream => {
      expect(stream).toMatchObject({ status: 200, contentType: "text/event-stream" });
      expect(stream.chunks).toBeGreaterThan(0);
      const wire = network.find(item => item.method === "GET" && item.fixtureKey === stream.key);
      expect(wire).toMatchObject({ path: stream.path, status: 200, protocol: "http/1.1", wireRequestObserved: true, finished: false });
      expect(wire?.connectionId).toBeGreaterThan(0);
      return wire?.connectionId;
    });
    expect(new Set(connections).size).toBe(streams.length);
    const keys = streams.map(stream => stream.key).sort();
    expect(keys).toEqual(expect.arrayContaining(establishedKeys));
    return { renderer, network, establishedKeys: keys };
  };
  evidence.recordJsonArtifact("Permission pressure contract", {
    mode, engine: "v1", placement: "local", sourceElectron: true,
    permissions: "Two real read tools request external_directory on a disposable fixture file; no synthetic approvals",
    pressure: "Archive witness mechanism: eight real SSE fetches on the exact local-server origin, drain bodies, abort only for cleanup",
    inference: "Mock final response held by agent-hold after the real tool result; no final text rendered",
    scope: "Controlled transport investigation only; no installed incident attribution, no engine database access",
  });
  try {
    const initial = await step("two native external-directory requests exist and the selected card has a working unpressured control", async () => {
      const pending = await probe.eventually(world.pending, {
        within: 45_000, label: "both sessions own real pending permissions", until: items => items.length === 2,
      });
      expect(pending.map(item => item.sessionId).sort()).toEqual([world.target.sessionId, world.unrelated.sessionId].sort());
      for (const item of pending) expect(item.permission).toBe("external_directory");
      expect(await agent.run("session.open", { sessionId: world.target.sessionId })).toMatchObject({ ok: true });
      await user.see({ text: "Access an external folder?" }, { timeoutMs: 30_000 });
      await user.see("Allow once");
      await user.screenshot();
      const canary = await world.canary();
      expect(canary).toMatchObject({ status: 200, error: null, abortReason: null, bodyComplete: true });
      expect(canary.elapsedMs).toBeLessThan(2_000);
      for (const session of [world.target, world.unrelated]) {
        expect((await world.providerCalls(session.prompt)).filter(call => call.kind !== "utility").map(call => call.kind)).toEqual(["tool"]);
        const tools = (await world.transcript(session.sessionId)).flatMap(message => message.tools);
        expect(tools).toEqual([expect.objectContaining({ tool: "read", status: "running", output: "" })]);
      }
      evidence.recordJsonArtifact("Native pending approvals and unpressured control", { pending, canary });
      return pending;
    });
    const target = initial.find(item => item.sessionId === world.target.sessionId);
    const unrelated = initial.find(item => item.sessionId === world.unrelated.sessionId);
    if (!target || !unrelated) throw new Error("Missing native approval identities");
    const replyPath = world.replyPath(target.id);
    const otherBefore = await world.transcript(world.unrelated.sessionId);
    await world.phase("pressure");
    await world.startPressure();
    await step("real HTTP/1.1 SSE saturates the pool without stopping renderer or engine", async () => {
      await probe.eventually(world.renderer, {
        within: 25_000, label: "SSE body bytes establish with excess streams queued",
        until: value => value.streams.some(stream => stream.established) && value.streams.some(stream => stream.status === null),
      });
      const before = await world.renderer();
      const canary = await world.canary();
      expect(canary).toMatchObject({ status: null, bodyComplete: false, abortReason: { name: "TimeoutError" } });
      expect(canary.elapsedMs).toBeGreaterThanOrEqual(1_800);
      expect(canary.elapsedMs).toBeLessThan(3_500);
      const pressure = await held();
      establishedKeys = pressure.establishedKeys;
      expect(pressure.renderer.ticks - before.ticks).toBeGreaterThan(10);
      expect(pressure.renderer.frames - before.frames).toBeGreaterThan(5);
      expect(pressure.renderer.maxTickGapMs).toBeLessThan(1_500);
      const network = await probe.eventually(() => world.network(), {
        within: 3_000, label: "canary cancellation before wire dispatch",
        until: items => items.some(item => item.fixtureKey === canary.fixtureKey && item.finished),
      });
      expect(network.find(item => item.fixtureKey === canary.fixtureKey && item.method === "GET"))
        .toMatchObject({ wireRequestObserved: false, status: null, canceled: true, failure: "net::ERR_ABORTED" });
      const start = performance.now();
      expect(await world.pending()).toEqual(initial);
      evidence.recordJsonArtifact("Sustained SSE and independent engine control", { pressure, canary, readbackMs: performance.now() - start });
    });
    await world.phase("sidebar");
    await user.click("Allow once");
    const outcome = await probe.eventually(world.renderer, {
      within: 16_000, label: "trusted Allow once produces timeout or acknowledgement",
      until: value => value.ui.failureMs !== null || value.ui.successMs !== null,
    });
    expect(outcome.ui.trustedClick).toBe(true);
    evidence.recordJsonArtifact("Allow once outcome while pressure is held", await held());
    if (mode === "baseline") {
      await step("baseline timeout occurs around ten seconds without a wire reply or permission resolution", async () => {
        expect(outcome.ui).toMatchObject({ successMs: null, timeoutDescription: true });
        expect(outcome.ui.failureMs).toBeGreaterThanOrEqual(9_000);
        expect(outcome.ui.failureMs).toBeLessThan(13_000);
        expect(outcome.ui.ticks).toBeGreaterThan(40);
        expect(outcome.ui.frames).toBeGreaterThan(10);
        expect(outcome.ui.maxTickGapMs).toBeLessThan(1_500);
        await user.see({ text: "Request timed out." });
        await user.see("Allow once");
        await user.screenshot();
        const replies = outcome.requests.filter(item => item.path === replyPath && item.method === "POST");
        expect(replies).toEqual([expect.objectContaining({ status: null,
          abortReason: expect.objectContaining({ name: "AbortError" }), error: expect.objectContaining({ name: "AbortError" }) })]);
        expect(replies[0]?.elapsedMs).toBeGreaterThanOrEqual(9_000);
        expect(replies[0]?.elapsedMs).toBeLessThan(13_000);
        const network = await probe.eventually(() => world.network(), {
          within: 3_000, label: "real reply aborts in Chromium before wire dispatch",
          until: items => items.some(item => item.path === replyPath && item.method === "POST" && item.finished),
        });
        const posts = network.filter(item => item.path === replyPath && item.method === "POST");
        expect(posts).toEqual([expect.objectContaining({ status: null, responseMs: null, wireRequestObserved: false,
          canceled: true, failure: "net::ERR_ABORTED" })]);
        expect(await world.mainRequests()).toEqual([]);
        expect(await world.pending()).toEqual(initial);
        expect((await world.transcript(world.target.sessionId)).flatMap(message => message.tools))
          .toEqual([expect.objectContaining({ tool: "read", status: "running", output: "" })]);
        expect((await world.providerCalls(world.target.prompt)).some(call => call.kind === "final")).toBe(false);
        evidence.recordJsonArtifact("Baseline numerical evidence", { toastMs: outcome.ui.failureMs, replies, posts,
          wireReplies: 0, resolvedPermissions: 0, establishedStreams: establishedKeys.length, eventLoop: outcome.ui });
        evidence.recordAssertionEvidence("Controlled permission timeout reproduced", `Trusted Allow once timed out at ${outcome.ui.failureMs}ms with zero wire replies; both real permissions remain pending.`, true);
      });
      await world.releasePressure();
      await world.phase("recovery");
      expect(await world.canary()).toMatchObject({ status: 200, bodyComplete: true });
      expect(await world.pending()).toEqual(initial);
      await user.click("Allow once");
    } else {
      expect(outcome.ui.failureMs).toBeNull();
      expect(outcome.ui.successMs).not.toBeNull();
      expect(outcome.ui.successMs).toBeLessThan(1_000);
      await user.notSee({ text: "Request timed out." });
    }
    await step("the same approval settles once and its real read proceeds while final inference remains held", async () => {
      const started = performance.now();
      const state = await probe.eventually(async () => ({
        pending: await world.pending(), messages: await world.transcript(world.target.sessionId), inference: await world.inference(),
      }), {
        within: 15_000, label: "native read completes with inference still gated",
        until: value => value.pending.length === 1 && value.pending[0]?.id === unrelated.id
          && value.messages.some(message => message.tools.some(tool => tool.status === "completed")) && value.inference.pending === 1,
      });
      expect(state.pending).toEqual([unrelated]);
      expect(state.messages.flatMap(message => message.tools)).toEqual([expect.objectContaining({
        tool: "read", status: "completed", output: expect.stringContaining(world.marker),
      })]);
      expect(state.inference).toMatchObject({ held: true, pending: 1 });
      expect(state.messages.some(message => message.text.includes(world.reply))).toBe(false);
      await user.notSee("Allow once", { timeoutMs: 3_000 });
      expect(await world.transcript(world.unrelated.sessionId)).toEqual(otherBefore);
      if (mode === "fixed") {
        await held();
        expect(await world.canary()).toMatchObject({ status: null, bodyComplete: false });
        await held();
      }
      const renderer = await world.renderer();
      const main = await world.mainRequests();
      const accepted = [...renderer.requests, ...main].filter(item => item.path === replyPath && item.method === "POST" && item.status === 200);
      expect(accepted).toHaveLength(1);
      const attempts = [...renderer.requests, ...main].filter(item => item.path === replyPath && item.method === "POST");
      expect(attempts).toHaveLength(mode === "baseline" ? 2 : 1);
      if (mode === "baseline") {
        const network = await probe.eventually(() => world.network(), {
          within: 3_000, label: "the recovered renderer permission reply completes over HTTP/1.1",
          until: items => items.some(item => item.path === replyPath && item.method === "POST" && item.status === 200 && item.finished),
        });
        expect(network.filter(item => item.path === replyPath && item.method === "POST" && item.wireRequestObserved))
          .toEqual([expect.objectContaining({ phase: "recovery", status: 200, protocol: "http/1.1", failure: null })]);
      }
      expect(main.every(item => item.path === replyPath)).toBe(true);
      expect(renderer.requests.filter(item => item.method === "POST" && item.path.includes("/permission/")).every(item => item.path === replyPath)).toBe(true);
      evidence.recordJsonArtifact("Acknowledgement independent of final inference", { state, main, renderer,
        acceptedReplies: accepted.length, readbackWaitMs: performance.now() - started });
      evidence.recordAssertionEvidence("Permission acknowledgement does not need final inference", "The real pending request disappeared, exactly one reply succeeded and the read output contains the fixture marker while the mock final response remains held and final text is absent; the unrelated request and transcript are unchanged.", true);
      await user.screenshot();
    });
    await world.releasePressure();
    await world.releaseInference();
    await user.see({ text: world.reply }, { timeoutMs: 30_000 });
    expect(await world.pending()).toEqual([unrelated]);
    expect((await world.providerCalls(world.target.prompt)).filter(call => call.kind !== "utility").map(call => ({ kind: call.kind, completedTools: call.completedTools })))
      .toEqual([{ kind: "tool", completedTools: 0 }, { kind: "final", completedTools: 1 }]);
    expect((await world.providerCalls(world.unrelated.prompt)).some(call => call.kind === "final")).toBe(false);
    const approvalMain = await world.mainRequests();
    expect(approvalMain).toEqual(mode === "fixed" ? [expect.objectContaining({
      path: replyPath, method: "POST", reply: "once", status: 200, failed: false,
    })] : []);
    // Baseline mode ends after failure/recovery; fixed mode also proves native Stop cleanup.
    if (mode === "baseline") return;
    const onlyScopedRejection = async () => {
      const path = world.replyPath(unrelated.id);
      const renderer = (await world.renderer()).requests.filter(item => item.path === path && item.method === "POST");
      const allMain = await world.mainRequests();
      const main = allMain.filter(item => item.path === path && item.method === "POST");
      const network = world.network().filter(item => item.path === path && item.method === "POST");
      expect(renderer).toEqual([]);
      expect(main).toEqual([expect.objectContaining({ reply: "reject", status: 200, failed: false, transport: "main" })]);
      expect(main.some(item => item.reply === "once" || item.reply === "always")).toBe(false);
      expect(allMain.filter(item => item.path !== path)).toEqual(approvalMain);
      expect(network).toEqual([]);
      return { renderer, main, network };
    };
    const stopped = await step("native Stop clears the remaining approval with only a scoped rejection and no final inference", async () => {
      expect((await world.renderer()).released).toBe(true);
      const targetBeforeStop = await probe.eventually(() => world.transcript(world.target.sessionId), {
        within: 10_000, label: "approved target final response is complete before Stop",
        until: messages => messages.some(message => message.text.includes(world.reply) && message.completed),
      });
      expect(await agent.run("session.open", { sessionId: world.unrelated.sessionId })).toMatchObject({ ok: true });
      await user.see("Allow once", { timeoutMs: 30_000 });
      await user.see({ role: "button", label: "Stop" });
      const before = await world.pending();
      expect(before).toEqual([unrelated]);
      expect(await world.transcript(world.unrelated.sessionId)).toEqual(otherBefore);
      await user.click({ role: "button", label: "Stop" });
      const state = await probe.eventually(async () => ({
        pending: await world.pending(), messages: await world.transcript(world.unrelated.sessionId),
      }), {
        within: 30_000, label: "native Stop removes only the stopped request and interrupts its read",
        until: value => value.pending.length === 0
          && value.messages.some(message => message.tools.some(tool => tool.status === "error")),
      });
      expect(state.pending).toEqual(before.filter(item => item.id !== unrelated.id));
      const tools = state.messages.flatMap(message => message.tools);
      expect(tools).toEqual([expect.objectContaining({
        callId: otherBefore.flatMap(message => message.tools)[0]?.callId, tool: "read", status: "error", output: "",
      })]);
      expect(state.messages.some(message => message.text.includes(world.reply))).toBe(false);
      const calls = await world.providerCalls(world.unrelated.prompt);
      expect(calls.filter(call => call.kind !== "utility").map(call => call.kind)).toEqual(["tool"]);
      expect(await world.transcript(world.target.sessionId)).toEqual(targetBeforeStop);
      await user.notSee("Allow once", { timeoutMs: 15_000 });
      await user.notSee({ role: "button", label: "Stop" });
      const replies = await onlyScopedRejection();
      evidence.recordJsonArtifact("Native Stop cleanup after permission recovery", {
        approvalPhase: { targetRequest: target, main: approvalMain, messages: targetBeforeStop },
        stopPhase: { before, stoppedRequest: unrelated, state, calls, replies },
      });
      evidence.recordAssertionEvidence("Native Stop cleans up its pending external-directory request", "After pressure release and the approved target's final reply, a trusted user Stop click removes the remaining native request through exactly one successful main-process reject reply scoped to it, with no once/always grant, duplicate, or renderer reply. Its read remains in error with no output and no final inference; the completed target transcript and earlier approval replies are unchanged. This verifies existing native Stop behavior, not an isolation improvement.", true);
      return { tools, targetBeforeStop };
    });
    await step("fresh work completes after native Stop without resuming the interrupted read", async () => {
      await user.type("composer", world.followup.prompt, { verify: true });
      await user.press("Enter");
      await user.see({ text: world.followup.reply }, { timeoutMs: 30_000 });
      expect((await world.providerCalls(world.followup.prompt)).filter(call => call.kind !== "utility").map(call => call.kind)).toEqual(["final"]);
      expect((await world.providerCalls(world.unrelated.prompt)).some(call => call.kind === "final")).toBe(false);
      expect(await world.pending()).toEqual([]);
      expect((await world.transcript(world.unrelated.sessionId)).flatMap(message => message.tools)).toEqual(stopped.tools);
      expect(await world.transcript(world.target.sessionId)).toEqual(stopped.targetBeforeStop);
      const replies = await onlyScopedRejection();
      evidence.recordJsonArtifact("Scoped rejection remains singular after fresh work", {
        replies, calls: await world.providerCalls(world.followup.prompt),
      });
      evidence.recordAssertionEvidence("Fresh work after native Stop", "A fresh composer turn completes exactly once without reload, new pending permissions, additional replies or grants for the stopped request, final inference for the stopped turn, or changes to its interrupted read and the approved target transcript. The stopped request retains exactly one scoped main-process reject reply and no renderer reply.", true);
    });
  } finally {
    try {
      evidence.recordJsonArtifact("Final permission pressure metadata", { renderer: await world.renderer(), network: world.network(), main: await world.mainRequests() });
    } finally {
      const cleanup = await world.releasePressure();
      expect(cleanup.expired).toBe(false);
      expect(cleanup.streams.every(stream => stream.closed)).toBe(true);
      evidence.recordJsonArtifact("Injected SSE cleanup", cleanup.streams);
      await probe.eventually(() => world.network(), {
        within: 3_000, label: "injected stream requests terminate in Chromium",
        until: items => items.filter(item => item.fixtureKey?.startsWith("stream-")).every(item => item.finished),
      });
    }
  }
});
