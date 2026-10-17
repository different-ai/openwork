import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { workshopNarrative, type NarrativeRow } from "../worlds/workshop-narrative.ts";
import { WORKSHOP_SCENES, verifyWorkshopScene, type SceneEvidence } from "../worlds/workshop-narrative-contract.ts";
import { observedServiceCalls } from "../worlds/workshop-narrative-witnesses.ts";
import { workshopTurnTerminal } from "../worlds/workshop-turn-diagnostics.ts";

const test = spec.world(workshopNarrative, {
  timeout: 420000,
  needs: { placement: "local", commands: ["bun", "infisical"], optIn: ["OPENWORK_WORKSHOP_DIAGNOSTIC"] },
  resources: { surfaces: ["appWeb", "web"], services: ["den"] },
});
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : {};

test("T07 only: diagnose finalization under the unchanged scene bound, not workshop acceptance", { timeout: 420000 }, async ({ world, user, agent, probe, step, evidence }) => {
  if (!world.ready) throw new Error(world.blockedReason);
  const scene = WORKSHOP_SCENES.find((scene) => scene.id === "T07");
  if (!scene) throw new Error("Shared T07 scene missing");
  const person = user.on(world.app), subject = agent.on(world.app);
  await person.resizeViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
  await step("submit the exact shared T07 prompt to the real configured subject", async () => {
    const started = Date.now();
    await world.assertIsolation();
    await subject.createSession("T07 bounded finalization diagnosis");
    const before = await world.observe();
    const nativeBefore = await world.nativeWorkflows();
    const inferenceStart = before.inference.length;
    const oldIds = new Set((Array.isArray(before.messages) ? before.messages : []).map((message) => record(record(message).info).id));
    let completed = true;
    await person.type("composer", scene.prompt, { replace: true });
    await person.click("Run task");
    await probe.eventually(() => world.current(), { within: scene.limitMs, intervalMs: 500, label: "same bounded T07 real subject completion", until: (value) => workshopTurnTerminal(value.messages, oldIds) }).catch(async () => {
      completed = false;
      await world.captureTurnDiagnostic("T07-diagnostic-before-stop");
      await world.assertScreenshotSafe(world.app); await person.screenshot();
      await subject.run("composer.stop");
      world.abortInferenceAfter(inferenceStart + 1);
    });
    await world.settleInference();
    await world.captureTurnDiagnostic("T07-diagnostic-final");
    const after = await world.observe();
    const requests = after.inference.slice(inferenceStart);
    const costUsd = requests.every((request) => request.estimatedUsd !== null) ? requests.reduce((total, request) => total + (request.estimatedUsd ?? 0), 0) : null;
    const tokens = requests.every((request) => request.inputTokens !== null && request.outputTokens !== null) ? requests.reduce((total, request) => total + (request.inputTokens ?? 0) + (request.outputTokens ?? 0), 0) : undefined;
    const check: SceneEvidence = { id: "T07", before, after, expected: { ...world.expectedModel, sessionId: after.sessionId ?? "missing-session" }, elapsedMs: Date.now() - started, costUsd, tokens, costKind: "estimate", serviceCalls: observedServiceCalls(before, after) };
    const verdict = verifyWorkshopScene(check);
    await world.retainSceneEvidence(check, { before: nativeBefore, after: await world.nativeWorkflows() });
    const exactInference = requests.length > 0 && requests.every((request) => request.status === "completed" && request.upstreamModel === world.expectedModel.modelID && (world.profile !== "gpt-sol-fast" || request.requestedServiceTier === "priority" && ["priority", "fast"].includes(request.returnedServiceTier ?? "")));
    const row: NarrativeRow = { id: "T07", title: "Single-scene finalization diagnosis only", status: completed && exactInference ? verdict.status : "FAIL", latencyMs: Date.now() - started, sessionId: after.sessionId ?? undefined, reason: [...verdict.reasons, ...(!completed ? ["Unchanged scene bound exhausted; pre-stop metadata retained"] : []), ...(!exactInference ? ["Inference completion/model/tier not verified"] : [])].join("; ") || "Single-scene shared contract passed; not a full narrative result", evidence: { requestCount: requests.length, estimatedUsd: costUsd, tokens } };
    await world.finishDiagnostic(row);
    await world.assertScreenshotSafe(world.app); await person.screenshot();
    evidence.recordAssertionEvidence("T07 diagnostic result only", `${row.status}: ${row.reason}`, row.status === "PASS");
    expect(row.status, row.reason).toBe("PASS");
  });
});
