import { defineConfig } from "vitest/config";
import { shouldPrepareSuite, suiteWorkerCount } from "./runner/stack-suite.ts";

const common = {
  environment: "node",
  testTimeout: 120_000,
};

const prepareSuite = shouldPrepareSuite(process.argv);
const attachedDen = Boolean(process.env.OPENWORK_EVAL_DEN_API_URL?.trim());
const managedStack = prepareSuite && !attachedDen;
const e2eWorkers = managedStack ? suiteWorkerCount(process.argv, process.env) : 1;

export default defineConfig({
  test: {
    ...common,
    fileParallelism: managedStack,
    maxWorkers: e2eWorkers,
    projects: [
      {
        test: {
          ...common,
          name: "pr",
          // Naming convention: *.e2e.test.ts drives the app/Den; every other test must be app-less.
          include: ["specs/**/*.test.ts"],
          exclude: ["**/*.e2e.test.ts"],
        },
      },
      {
        test: {
          ...common,
          name: "e2e",
          testTimeout: 600_000,
          hookTimeout: 600_000,
          globalSetup: ["./runner/prepare-stack.ts"],
          setupFiles: ["./runner/stack-env.ts"],
          include: ["specs/**/*.e2e.test.ts"],
        },
      },
    ],
  },
});
