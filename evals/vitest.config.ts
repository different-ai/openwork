import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { shouldPrepareSuite, suiteWorkerCount } from "./runner/stack-suite.ts";

const common = {
  environment: "node",
  testTimeout: 120_000,
};
const appSource = fileURLToPath(new URL("../apps/app/src/", import.meta.url));
const appResolve = {
  alias: [{ find: /^@\//, replacement: appSource }],
};

const prepareSuite = shouldPrepareSuite(process.argv);
const attachedDen = Boolean(process.env.OPENWORK_EVAL_DEN_API_URL?.trim());
const managedStack = prepareSuite && !attachedDen;
const e2eWorkers = managedStack ? suiteWorkerCount(process.argv, process.env) : 1;
const namedLiveSpec = process.argv.some((argument) => /\.live(?:\.e2e)?\.test\.ts$/.test(argument));

export default defineConfig({
  test: {
    ...common,
    projects: [
      {
        test: {
          ...common,
          name: "live",
          include: ["specs/**/*.live.test.ts", "specs/**/*.live.e2e.test.ts"],
          // Attached deployments only: no managed stack, retries, or parallel mutations.
          fileParallelism: false,
          maxWorkers: 1,
          retry: 0,
          testTimeout: 300_000,
          hookTimeout: 300_000,
        },
      },
      {
        resolve: appResolve,
        test: {
          ...common,
          name: "pr",
          // Live specs are attached-system incident signals: exclude them unless explicitly named.
          include: ["specs/**/*.test.ts"],
          exclude: ["**/*.e2e.test.ts", ...(namedLiveSpec ? [] : ["**/*.live.test.ts", "**/*.live.e2e.test.ts"])],
        },
      },
      {
        resolve: appResolve,
        test: {
          ...common,
          name: "e2e",
          fileParallelism: managedStack,
          maxWorkers: e2eWorkers,
          testTimeout: 600_000,
          hookTimeout: 600_000,
          globalSetup: ["./runner/prepare-stack.ts"],
          setupFiles: ["./runner/stack-env.ts"],
          include: ["specs/**/*.e2e.test.ts"],
          exclude: namedLiveSpec ? [] : ["**/*.live.e2e.test.ts"],
        },
      },
    ],
  },
});
