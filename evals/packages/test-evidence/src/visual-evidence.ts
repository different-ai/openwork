import type { ScreenshotArtifact } from "./screenshot.ts";
import { createTestEvidence } from "./test-evidence.ts";
import type { VisualEvidenceResult } from "./validate.ts";

export interface VisualEvidenceRecorder {
  readonly dir: string;
  recordScreenshot(screenshotArtifact: ScreenshotArtifact, visualEvidence?: VisualEvidenceResult): Promise<string>;
  close(): Promise<string>;
  [Symbol.asyncDispose](): Promise<void>;
}

export function createVisualEvidence(name: string, opts: { outDir?: string } = {}): VisualEvidenceRecorder {
  const testEvidence = createTestEvidence({ name, outDir: opts.outDir });
  return {
    dir: testEvidence.dir,
    async recordScreenshot(screenshotArtifact, visualEvidence) {
      const screenshotPath = testEvidence.recordScreenshot(screenshotArtifact);
      return visualEvidence
        ? testEvidence.recordVisualValidation(screenshotArtifact.hash, visualEvidence)
        : screenshotPath;
    },
    close: () => testEvidence.close(),
    async [Symbol.asyncDispose]() {
      await testEvidence.close();
    },
  };
}
