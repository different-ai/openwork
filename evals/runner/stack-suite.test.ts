import assert from "node:assert/strict";
import test from "node:test";
import { shouldPrepareSuite, suiteWorkerCount, workerSlot } from "./stack-suite.ts";

test("single explicit E2E tests keep their one-off setup", () => {
  assert.equal(shouldPrepareSuite(["vitest", "specs/example.e2e.test.ts"]), false);
});

test("Vitest option values do not count as test selection arguments", () => {
  const argv = [
    "vitest",
    "--reporter",
    "verbose",
    "--config",
    "vitest.evals.config.ts",
    "--project",
    "evals",
    "evals/specs/streamed-markdown-answer.e2e.test.ts",
    "--testNamePattern",
    "^CONT-01(?:\\s|$)",
  ];

  assert.equal(shouldPrepareSuite(argv), false);
  assert.equal(suiteWorkerCount(argv, { OPENWORK_EVAL_DAYTONA: "1" }), 1);
  assert.equal(
    shouldPrepareSuite([...argv, "evals/specs/second.e2e.test.ts"]),
    true,
  );
  assert.equal(shouldPrepareSuite(["vitest", "evals/specs/*.e2e.test.ts", "-t", "CONT-01"]), true);
});

test("test name patterns never count as files or globs", () => {
  const file = "evals/specs/streamed-markdown-answer.e2e.test.ts";

  assert.equal(shouldPrepareSuite(["vitest", file, "-t", "pretend.test.ts"]), false);
  assert.equal(shouldPrepareSuite(["vitest", file, "--testNamePattern", "CONT-*?[01]"]), false);
  assert.equal(shouldPrepareSuite(["vitest", file, "--testNamePattern=pretend.test.ts"]), false);
  assert.equal(shouldPrepareSuite(["vitest", file, "--reporter=verbose", "--config=vitest.ts", "--project=evals"]), false);
});

test("multi-file, glob, and whole-project runs prepare shared stack resources", () => {
  assert.equal(shouldPrepareSuite(["vitest", "specs/a.e2e.test.ts", "specs/b.e2e.test.ts"]), true);
  assert.equal(shouldPrepareSuite(["vitest", "specs/*.e2e.test.ts"]), true);
  assert.equal(shouldPrepareSuite(["vitest"]), true);
});

test("Daytona defaults to two workers and never prepares more slots than explicit files", () => {
  assert.equal(suiteWorkerCount(["vitest", "specs/a.test.ts", "specs/b.test.ts"], { OPENWORK_EVAL_DAYTONA: "1" }), 2);
  assert.equal(suiteWorkerCount(["vitest", "specs/a.test.ts"], { OPENWORK_EVAL_DAYTONA: "1", OPENWORK_EVAL_MAX_WORKERS: "8" }), 1);
  assert.equal(suiteWorkerCount(["vitest", "specs/*.test.ts"], { OPENWORK_EVAL_DAYTONA: "1", OPENWORK_EVAL_MAX_WORKERS: "4" }), 4);
});

test("worker ids wrap onto the prepared slot pool", () => {
  assert.equal(workerSlot("1", 2), 0);
  assert.equal(workerSlot("2", 2), 1);
  assert.equal(workerSlot("3", 2), 0);
  assert.equal(workerSlot(undefined, 2), 0);
});
