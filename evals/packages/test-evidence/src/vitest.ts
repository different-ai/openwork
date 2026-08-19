import { expect, test as base } from "vitest";
import { enterTestEvidence } from "./ambient.ts";
import { createTestEvidence } from "./test-evidence.ts";
import type { TestEvidenceRecorder } from "./test-evidence.ts";
import type { VisualEvidenceResult } from "./validate.ts";

function slug(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "test";
}

export const test = base.extend<{ evidence: TestEvidenceRecorder }>({
  evidence: [async ({ task }, use) => {
    const testEvidence = createTestEvidence({ name: slug(task.name) });
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
