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

test("T04 then T05 only: diagnose real report-to-PPTX upload without seeding a report or deck", { timeout: 600000 }, async ({ world, user, agent, probe, step, evidence }) => {
  if (!world.ready) throw new Error(world.blockedReason);
  const person = user.on(world.app), subject = agent.on(world.app);
  await person.resizeViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
  for (const id of ["T04", "T05"]) {
    const scene = WORKSHOP_SCENES.find((scene) => scene.id === id);
    if (!scene) throw new Error("Shared artifact diagnostic scene missing");
    await step(`${scene.id}: execute the exact shared scene with the actual subject`, async () => {
      const started = Date.now();
      await world.assertIsolation();
      await subject.createSession(`${scene.id} bounded artifact diagnosis`);
      const before = await world.observe(), nativeBefore = await world.nativeWorkflows();
      const inferenceStart = before.inference.length;
      const oldIds = new Set((Array.isArray(before.messages) ? before.messages : []).map((message) => record(record(message).info).id));
      let completed = true;
      await person.type("composer", scene.prompt, { replace: true });
      await person.click("Run task");
      await probe.eventually(() => world.current(), { within: scene.limitMs, intervalMs: 500, label: `${scene.id} unchanged real-subject completion bound`, until: (value) => workshopTurnTerminal(value.messages, oldIds) }).catch(async () => {
        completed = false;
        await world.captureTurnDiagnostic(`${scene.id}-artifact-before-stop`);
        await subject.run("composer.stop"); world.abortInferenceAfter(inferenceStart + 1);
      });
      await world.settleInference();
      await world.captureTurnDiagnostic(`${scene.id}-artifact-final`);
      const after = await world.observe(), requests = after.inference.slice(inferenceStart);
      const costUsd = requests.every((request) => request.estimatedUsd !== null) ? requests.reduce((sum, request) => sum + (request.estimatedUsd ?? 0), 0) : null;
      const tokens = requests.every((request) => request.inputTokens !== null && request.outputTokens !== null) ? requests.reduce((sum, request) => sum + (request.inputTokens ?? 0) + (request.outputTokens ?? 0), 0) : undefined;
      const check: SceneEvidence = { id: scene.id, before, after, expected: { ...world.expectedModel, sessionId: after.sessionId ?? "missing-session" }, elapsedMs: Date.now() - started, costUsd, tokens, costKind: "estimate", serviceCalls: observedServiceCalls(before, after) };
      let verdict = verifyWorkshopScene(check);
      if (scene.id === "T05" && verdict.artifactCandidate) {
        const inspected = await world.inspectPptx(verdict.artifactCandidate.fileId, after.sessionId ?? "");
        if ("artifact" in inspected) { check.artifact = inspected.artifact; verdict = verifyWorkshopScene(check); }
        else verdict.reasons.push(inspected.reason);
      }
      await world.retainSceneEvidence(check, { before: nativeBefore, after: await world.nativeWorkflows() });
      const exactInference = requests.length > 0 && requests.every((request) => request.status === "completed" && request.upstreamModel === world.expectedModel.modelID && (world.profile !== "gpt-sol-fast" || request.requestedServiceTier === "priority" && ["priority", "fast"].includes(request.returnedServiceTier ?? "")));
      const row: NarrativeRow = { id: scene.id, title: "Targeted report-to-PPTX diagnosis only", status: completed && exactInference ? verdict.status : "FAIL", latencyMs: Date.now() - started, sessionId: after.sessionId ?? undefined, reason: [...verdict.reasons, ...(!completed ? ["Unchanged scene bound exhausted"] : []), ...(!exactInference ? ["Inference completion/model/tier not verified"] : [])].join("; ") || "Shared artifact contract passed; not full workshop acceptance", evidence: { requestCount: requests.length, estimatedUsd: costUsd, tokens, artifact: check.artifact ?? null } };
      world.recordRow(row); await world.finishDiagnostic(row);
      await world.assertScreenshotSafe(world.app); await person.screenshot();
      evidence.recordAssertionEvidence(`${scene.id} diagnostic result only`, `${row.status}: ${row.reason}`, row.status === "PASS");
      expect(row.status, row.reason).toBe("PASS");
    });
  }
});
