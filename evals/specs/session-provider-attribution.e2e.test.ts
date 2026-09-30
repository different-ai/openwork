import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { sessionProviderAttribution } from "../worlds/session-provider-attribution.ts";

const test = spec.world(sessionProviderAttribution, {
  timeout: 8 * 60_000,
  resources: { surfaces: ["desktop"], services: ["mock"],
    nativeReason: "Attribution of a real UI send to an isolated HTTP 400 provider witness before any assistant text, using source-built local Electron and its real engine." },
});

test("terminal provider rejection before assistant text has an attributable visible outcome", async ({ world, user, agent, probe, step, evidence }) => {
  try {
    expect(await agent.run("session.open", { sessionId: world.session.sessionId })).toMatchObject({ ok: true });
    await user.see("composer", { editable: true });
    await user.type("composer", world.prompt, { replace: true });
    await probe.eventually(() => probe.composer(), { within: 30_000, label: "real composer ready to send", until: value => value.runTaskEnabled });
    evidence.recordJsonArtifact("Before deliberate real UI send", { ui: await world.ui(), engine: await world.engine(), provider: world.providerRequests() });
    await user.press("Enter");
    await probe.eventually(() => world.engine(), { within: 30_000, label: "native assistant records provider terminal error", until: value => value.messages.some(message => message.role === "assistant" && Boolean(message.error)) });
    await probe.eventually(() => world.ui(), { within: 15_000, label: "real UI settles after terminal provider rejection", until: value => value.status.length === 0 && value.actions.includes("Run task") });
    await new Promise(resolve => setTimeout(resolve, 3_000));
    const ui = await world.ui();
    const engine = await world.engine();
    const provider = world.providerRequests();
    const visibleError = ui.text.includes(world.errorMessage) || ui.toasts.some(text => text.includes(world.errorMessage));
    const silentBounce = ui.draft === world.prompt && !visibleError && ui.status.length === 0;
    evidence.recordJsonArtifact("Exact provider terminal attribution outcome", { ui, engine, provider, visibleError, silentBounce, observationWindowMs: ui.submittedAt === null ? null : ui.at - ui.submittedAt });
    await step("provider terminal outcome exact visible error draft and status", () => user.screenshot());
    expect(ui.trusted).toBe(true);
    expect(engine.admissions).toBe(1);
    expect(engine.statuses).toEqual({});
    expect(engine.messages.filter(message => message.role === "assistant")).toEqual([expect.objectContaining({
      text: "", error: { name: "APIError", data: expect.objectContaining({ message: world.errorMessage, statusCode: 400, isRetryable: false }) },
    })]);
    const cleared = ui.samples.findIndex(sample => sample.draft === "");
    expect(cleared).toBeGreaterThanOrEqual(0);
    expect(ui.samples.slice(cleared).every(sample => sample.draft === "")).toBe(true);
    expect(engine.messages.filter(message => message.role === "assistant" && message.text.length > 0)).toHaveLength(0);
    expect(provider.filter(request => request.marker)).toEqual([expect.objectContaining({ status: 400, assistantTextBytes: 0 })]);
    expect(visibleError).toBe(true);
    expect(silentBounce).toBe(false);
    expect(ui.draft).toBe("");
    expect(ui.status).toEqual([]);
    evidence.recordAssertionEvidence("Terminal provider rejection is visible, with one admission and no assistant text or silent bounce",
      JSON.stringify({ visibleError, silentBounce, draft: ui.draft, status: ui.status, actions: ui.actions, admissions: engine.admissions, providerMarkerRequests: provider.filter(request => request.marker).length }), true);
  } catch (error) {
    await user.screenshot();
    throw error;
  } finally {
    evidence.recordJsonArtifact("Final provider attribution readback", { ui: await world.ui(), engine: await world.engine(), provider: world.providerRequests() });
  }
});
