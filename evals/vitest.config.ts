import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { parallelSuite, suiteWorkerCount } from "./runner/stack-suite.ts";

const common = {
  environment: "node",
  testTimeout: 120_000,
  // Tags are explicit opt-ins that CI reads; strictTags rejects unknown ones.
  tags: [
    { name: "checkpoints", description: "Save the world's end state (and marked steps) as reopenable checkpoints when run with --checkpoints on a world that can capture." },
    { name: "user-flow", description: "A person goes through the real UI; every step is a click or typed input that ends with a screenshot of what they see." },
    { name: "agent-flow", description: "The actor is an agent, an MCP client or a server; the proof is the requests and responses." },
  ],
};
const appSource = fileURLToPath(new URL("../apps/app/src/", import.meta.url));
const appResolve = {
  alias: [{ find: /^@\//, replacement: appSource }],
};

const attachedDen = Boolean(process.env.OPENWORK_EVAL_DEN_API_URL?.trim());
const managedStack = parallelSuite(process.argv) && !attachedDen;
const e2eWorkers = managedStack ? suiteWorkerCount(process.argv, process.env) : 1;
const namedLiveSpec = process.argv.some((argument) => argument.endsWith(".live.test.ts") || argument.endsWith("/live.test.ts"));

export default defineConfig({
  test: {
    ...common,
    projects: [
      {
        resolve: appResolve,
        test: {
          ...common,
          name: "pr",
          // Live specs are attached-system incident signals: exclude them unless explicitly named.
          include: ["specs/**/*.test.ts", "../scenarios/**/*.test.ts"],
          exclude: ["**/*.e2e.test.ts", "**/e2e.test.ts", ...(namedLiveSpec ? [] : ["**/*.live.test.ts", "**/live.test.ts"])],
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
          include: ["specs/**/*.e2e.test.ts", "../scenarios/**/e2e.test.ts"],
        },
      },
    ],
  },
});
