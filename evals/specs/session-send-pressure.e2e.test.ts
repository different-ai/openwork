import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { sendPressureMode, sessionSendPressure } from "../worlds/session-send-pressure.ts";

const mode = sendPressureMode();
const test = spec.world(sessionSendPressure, {
  timeout: 10 * 60_000,
  resources: { surfaces: ["desktop"], services: ["mock"],
    nativeReason: "Real HTTP/1.1 SSE pressure and trusted prompt/Stop actions in an isolated source-built Electron with its own engine and provider witness." },
});

test(`${mode}: ordinary prompt and Stop under sustained renderer SSE pressure`, async ({ world, user, agent, probe, step, evidence }) => {
  const target = world.selected;
  const admission = async () => (await world.readMessages()).filter(message => message.role === "user" && message.text.includes(world.prompt));
  const held = async () => {
    const value = await world.renderer();
    expect(value.released).toBe(false);
    expect(value.expired).toBe(false);
    expect(value.streams).toHaveLength(8);
    expect(value.streams.every(stream => !stream.closed && !stream.error)).toBe(true);
    const established = value.streams.filter(stream => stream.established);
    expect(established.length).toBeGreaterThan(0);
    expect(value.streams.some(stream => stream.status === null)).toBe(true);
    const network = world.network();
    const connections = established.map(stream => {
      const request = network.find(request => request.fixtureKey === stream.key && request.method === "GET");
      expect(request).toMatchObject({ protocol: "http/1.1", status: 200, wireRequestObserved: true, finished: false });
      return request?.connectionId;
    });
    expect(new Set(connections).size).toBe(established.length);
    return { renderer: value, network };
  };
  try {
    await agent.run("route.settings.appearance");
    await user.click({ role: "button", label: "Dark" });
    await probe.eventually(() => probe.eval(() => document.documentElement.dataset.theme), {
      within: 5_000, label: "fixture uses the selected dark theme for readable screenshots", until: value => value === "dark",
    });
    await user.click({ role: "button", label: "Back to app" });
    await user.see("composer", { editable: true });
    expect(await agent.run("session.open", { sessionId: target.sessionId })).toMatchObject({ ok: true });
    await user.see("composer", { editable: true });
    expect(await world.canary()).toMatchObject({ status: 200, bodyComplete: true });
    await user.type("composer", world.prompt, { replace: true });
    await probe.eventually(() => probe.composer(), { within: 30_000, label: "selected session is ready to send",
      until: value => value.runTaskEnabled });
    await world.startPressure();
    await probe.eventually(() => world.renderer(), { within: 25_000, label: "real SSE body bytes with queued excess streams",
      until: value => value.streams.some(stream => stream.established) && value.streams.some(stream => stream.status === null) });
    expect(await world.canary()).toMatchObject({ status: null, bodyComplete: false, abortReason: { name: "TimeoutError" } });
    evidence.recordJsonArtifact("Established real SSE pressure", await held());
    await user.press("Enter");
    if (mode === "baseline") {
      const ui = await probe.eventually(() => world.ui(), { within: 45_000, label: "baseline prompt reaches a visible error or witness admission",
        until: value => /timed out|acceptance is unknown|failed/i.test(value.text) });
      evidence.recordJsonArtifact("Exact baseline draft error status", { ui, admissions: await admission(), provider: await world.providerRequests(), pressure: await held() });
      await step("baseline visible outcome with pressure held", () => user.screenshot());
      expect(ui.trusted).toBe(true);
      expect(ui.text).toContain("Request timed out.");
      expect(ui.draft).toBe(world.prompt);
      expect(ui.status).toEqual([]);
      expect(ui.action).toBe("Run task");
      expect(ui.atMs).toBeGreaterThanOrEqual(9_000);
      expect(ui.atMs).toBeLessThan(13_000);
      expect(await admission()).toHaveLength(0);
      expect(await world.providerRequests()).toHaveLength(0);
      evidence.recordAssertionEvidence("Investigative baseline is visible timeout plus draft restoration, not silent failure",
        `At ${ui.atMs}ms: Request timed out.; draft=${JSON.stringify(ui.draft)}; status=${JSON.stringify(ui.status)}; action=${ui.action}. Zero engine admissions and provider calls under established SSE pressure.`, true);
    } else {
      const ui = await probe.eventually(() => world.ui(), { within: 2_000, label: "prompt bubble and Starting appear within one second",
        until: value => value.messageMs !== null && value.startingMs !== null });
      evidence.recordJsonArtifact("Immediate send UI timings", ui);
      expect(ui.trusted).toBe(true);
      expect(ui.startingMs).toBeLessThan(1_000);
      expect(ui.messageMs).toBeLessThan(1_000);
      await user.type("composer", world.newerDraft, { replace: true });
      await probe.eventually(admission, { within: 12_000, label: "exactly one engine admission while pressure stays held", until: rows => rows.length === 1 });
      await probe.eventually(() => world.providerRequests(), { within: 10_000, label: "real provider receives admitted turn", until: rows => rows.length === 1 });
      await step("fixed accepted run and newer draft with pressure held", () => user.screenshot());
      await world.releaseRun();
      await probe.eventually(() => world.readMessages(), { within: 15_000, label: "witness completion persists without releasing pressure",
        until: rows => rows.some(row => row.role === "assistant" && row.completed && row.text.includes(world.reply)) });
      expect(await admission()).toHaveLength(1);
      expect((await world.ui()).draft).toBe(world.newerDraft);
      expect((await world.ui()).text).not.toContain("Request timed out.");
      const firstMain = await world.mainRequests();
      const posts = firstMain.filter(request => request.action === "prompt_async");
      expect(posts).toEqual([expect.objectContaining({ sessionId: target.sessionId, result: 204 })]);
      if (ui.submittedAt === null) throw new Error("Trusted submission timestamp was not captured");
      const sendMs = posts[0].at - ui.submittedAt;
      expect(sendMs).toBeGreaterThanOrEqual(0);
      expect(sendMs).toBeLessThan(1_000);
      const samples = (await world.ui()).samples;
      const cleared = samples.findIndex(sample => sample.draft === "");
      expect(cleared).toBeGreaterThanOrEqual(0);
      expect(samples.slice(cleared).every(sample => !sample.draft.includes(world.prompt))).toBe(true);
      evidence.recordAssertionEvidence("Ordinary send bypasses sustained SSE pressure exactly once without restoring the submitted draft",
        `Starting=${ui.startingMs}ms; user bubble=${ui.messageMs}ms; prompt POST=${sendMs}ms. Exactly one native user admission and provider request; witness completed while streams stayed held and the newer draft survived.`, true);
      evidence.recordJsonArtifact("Completed once under pressure", { ui: await world.ui(), messages: await world.readMessages(), main: firstMain, pressure: await held() });
      await step("fixed completed turn and preserved draft", () => user.screenshot());
      await world.holdRun();
      await user.type("composer", "Hold the second isolated turn for Stop verification.", { replace: true });
      await user.press("Enter");
      await probe.eventually(() => world.providerRequests(), { within: 15_000, label: "second real turn reaches held provider", until: rows => rows.length === 2 });
      await user.type("composer", world.newerDraft, { replace: true });
      const beforeStop = await world.mainRequests();
      const startStop = performance.now();
      await user.click({ role: "button", label: "Stop" });
      await probe.eventually(() => world.ui(), { within: 8_000, label: "normal Stop finishes all verification under pressure",
        until: value => value.action !== null && !/stop/i.test(value.action) });
      const stopMs = performance.now() - startStop;
      const afterStop = (await world.mainRequests()).slice(beforeStop.length);
      for (const action of ["abort", "session", "messages", "session/status", "question", "permission"]) {
        expect(afterStop.some(request => request.action === action && request.result === 200)).toBe(true);
      }
      const engine = await world.readEngine();
      expect(engine.sessions.every(session => session.idle && session.archivedAt === 0)).toBe(true);
      expect(engine.sessions.filter(session => session.sessionId !== target.sessionId).every(session => session.messageCount === 0)).toBe(true);
      expect(afterStop.filter(request => request.action === "abort").every(request => request.sessionId === target.sessionId)).toBe(true);
      expect(await admission()).toHaveLength(1);
      expect((await world.ui()).draft).toBe(world.newerDraft);
      expect((await world.mainRequests()).filter(request => request.action === "prompt_async")).toHaveLength(2);
      expect(await world.canary()).toMatchObject({ status: null, bodyComplete: false });
      evidence.recordJsonArtifact("Stop completes verification with pressure held", { stopMs, afterStop, engine, ui: await world.ui(), pressure: await held() });
      evidence.recordAssertionEvidence("Normal Stop completes abort, ownership, transcript, idle, approval reads and final refresh while renderer GETs still time out",
        `Stop settled in ${stopMs}ms. Neighbor sessions remained idle, unarchived and empty; newer composer draft remained unchanged. Two deliberate prompts total, no replay.`, true);
      await step("fixed Stop settled with newer draft", () => user.screenshot());
    }
  } catch (error) {
    await user.screenshot();
    throw error;
  } finally {
    evidence.recordJsonArtifact("Final send pressure outcome", { ui: await world.ui(), messages: await world.readMessages(), main: await world.mainRequests(), pressure: await world.renderer(), network: world.network() });
    const released = await world.releasePressure();
    expect(released.streams.every(stream => stream.closed)).toBe(true);
    expect(await world.canary()).toMatchObject({ status: 200, bodyComplete: true });
  }
});
