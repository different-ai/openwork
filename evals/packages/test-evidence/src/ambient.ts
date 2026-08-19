import { AsyncLocalStorage } from "node:async_hooks";
import type { TestEvidenceRecorder } from "./test-evidence.ts";

const testEvidenceStorage = new AsyncLocalStorage<TestEvidenceRecorder>();

export function currentTestEvidence(): TestEvidenceRecorder | null {
  return testEvidenceStorage.getStore() ?? null;
}

export function withTestEvidence<Result>(testEvidence: TestEvidenceRecorder, fn: () => Result): Result {
  return testEvidenceStorage.run(testEvidence, fn);
}

export function enterTestEvidence(testEvidence: TestEvidenceRecorder): () => void {
  const previous = testEvidenceStorage.getStore();
  testEvidenceStorage.enterWith(testEvidence);
  return () => {
    testEvidenceStorage.disable();
    if (previous) testEvidenceStorage.enterWith(previous);
  };
}
