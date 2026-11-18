import { expect, test as base } from "vitest";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import { enterTestEvidence } from "./ambient.ts";
import { createTestEvidence } from "./test-evidence.ts";
import type { TestEvidenceRecorder } from "./test-evidence.ts";
import type { VisualEvidenceResult } from "./validate.ts";

export const test = base.extend<{ evidence: TestEvidenceRecorder }>({
  evidence: [async ({ task, onTestFinished }, use) => {
    const testEvidence = createTestEvidence({
      name: task.name,
      specFile: relative(fileURLToPath(new URL("../../../../", import.meta.url)), task.file.filepath).replaceAll("\\", "/"),
    });
    const leaveTestEvidence = enterTestEvidence(testEvidence);
    let finalized = false;
    // Vitest stops unwinding fixtures when another fixture's teardown throws.
    // This independent hook still persists the real body evidence in that case.
    onTestFinished(async () => {
      if (finalized) return;
      if (task.result?.state === "fail") testEvidence.setOutcome("failed", "Test failed during fixture teardown.");
      leaveTestEvidence();
      await testEvidence.close();
    });
    try {
      await use(testEvidence);
    } finally {
      leaveTestEvidence();
      await testEvidence.close();
      finalized = true;
    }
  }, { auto: true }],
});

export function expectVisualEvidence(visualEvidence: VisualEvidenceResult): void {
  expect(visualEvidence.ok, visualEvidence.why).toBe(true);
}
