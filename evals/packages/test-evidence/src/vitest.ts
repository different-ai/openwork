import { expect, test as base } from "vitest";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import { enterTestEvidence } from "./ambient.ts";
import { createTestEvidence } from "./test-evidence.ts";
import type { TestEvidenceRecorder } from "./test-evidence.ts";
import type { VisualEvidenceResult } from "./validate.ts";

export const test = base.extend<{ evidence: TestEvidenceRecorder }>({
  evidence: [async ({ task }, use) => {
    const testEvidence = createTestEvidence({
      name: task.name,
      specFile: relative(fileURLToPath(new URL("../../../../", import.meta.url)), task.file.filepath).replaceAll("\\", "/"),
    });
    const leaveTestEvidence = enterTestEvidence(testEvidence);
    try {
      await use(testEvidence);
    } finally {
      leaveTestEvidence();
      await testEvidence.close();
    }
  }, { auto: true }],
});

export function expectVisualEvidence(visualEvidence: VisualEvidenceResult): void {
  expect(visualEvidence.ok, visualEvidence.why).toBe(true);
}
