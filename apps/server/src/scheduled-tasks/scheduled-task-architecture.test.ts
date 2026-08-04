import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ScheduledTaskDefinition } from "@openwork/types/scheduled-tasks";
import type { ServerConfig, WorkspaceInfo } from "../types.js";
import type { ScheduledTaskExecutionAdapter } from "./execution.js";
import { createScheduledTasksModule } from "./module.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

const domainFiles = [
  "execution.ts",
  "scheduled-task-schedule.ts",
  "scheduled-task-scheduler.ts",
  "scheduled-task-service.ts",
  "scheduled-task-store.ts",
];

test("the Scheduled Tasks domain depends on an execution port, not OpenCode", async () => {
  for (const file of domainFiles) {
    const source = await readFile(
      join(process.cwd(), "src", "scheduled-tasks", file),
      "utf8",
    );
    expect(source).not.toContain("@opencode-ai/");
    expect(source).not.toContain("opencode-execution-adapter");
    expect(source).not.toContain("../server");
    expect(source).not.toContain("../routes/");
  }
});

test("the server composition root imports only the Scheduled Tasks module", async () => {
  const source = await readFile(join(process.cwd(), "src", "server.ts"), "utf8");
  const scheduledTaskImports = source
    .split("\n")
    .filter((line) => line.includes('from "./scheduled-tasks/'));
  expect(scheduledTaskImports).toEqual([
    '} from "./scheduled-tasks/module.js";',
  ]);
});

test("the module delivers a manual run through an engine-neutral adapter", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openwork-scheduled-module-"));
  cleanup.push(directory);
  const workspacePath = join(directory, "workspace");
  await mkdir(workspacePath);
  const artifactPath = join(workspacePath, "manual-result.md");
  const workspace: WorkspaceInfo = {
    id: "ws_manual",
    name: "Manual value",
    path: workspacePath,
    preset: "starter",
    workspaceType: "local",
  };
  const config: ServerConfig = {
    host: "127.0.0.1",
    port: 0,
    token: "client-token",
    hostToken: "host-token",
    configPath: join(directory, "openwork.json"),
    approval: { mode: "manual", timeoutMs: 60_000 },
    corsOrigins: [],
    workspaces: [workspace],
    authorizedRoots: [workspacePath],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "generated",
    hostTokenSource: "generated",
    logFormat: "json",
    logRequests: false,
  };
  const execution: ScheduledTaskExecutionAdapter = {
    async execute(request, options) {
      const sessionId = `ses_${request.runId}`;
      await options.onEvent?.({
        type: "session-created",
        at: Date.now(),
        sessionId,
      });
      await writeFile(artifactPath, "Manual Scheduled Tasks result\n", "utf8");
      return {
        status: "completed",
        sessionId,
        artifacts: [{
          id: "artifact_manual_result",
          kind: "file",
          value: "manual-result.md",
          name: "manual-result.md",
        }],
        boundedUsage: {
          inputTokens: 1,
          outputTokens: 1,
          costMicros: 1,
        },
      };
    },
    async cancel(request) {
      return { status: "cancelled", sessionId: request.sessionId };
    },
  };
  const module = await createScheduledTasksModule({
    config,
    logger: { log() {} },
    resolveWorkspace: async (workspaceId) => {
      if (workspaceId !== workspace.id) throw new Error("Workspace not found");
      return workspace;
    },
    createClient() {
      throw new Error("OpenCode must not be instantiated by this test");
    },
    createExecutionAdapter: () => execution,
  });
  if (!module) throw new Error("Scheduled Tasks module was not created");

  const definition: ScheduledTaskDefinition = {
    name: "Manual report",
    description: "Prove the bounded manual deliverable",
    prompt: "Write manual-result.md with a concise report.",
    workspaceId: workspace.id,
    schedule: { kind: "manual", timezone: "UTC" },
    model: { providerId: null, modelId: null, agent: null },
    maximumRuntimeMs: 60_000,
    overlapPolicy: "skip",
    retryPolicy: { maximumAttempts: 1, delayMs: 0 },
    missedRunPolicy: {
      kind: "skip",
      graceMs: 60_000,
      maximumRecoverableOccurrences: 1,
    },
  };
  const created = module.service.createDraft(definition, "owner");
  await module.service.review(workspace.id, created.task.id, {
    expectedRevisionId: created.revision.id,
    authorizedWorkspaceRoots: [workspacePath],
    capabilityIds: ["workspace.files.read", "workspace.files.write"],
    actionClasses: ["read", "write"],
    filesystem: { read: true, write: true },
    maximumRuntimeMs: definition.maximumRuntimeMs,
    model: definition.model,
    expiresAt: null,
    grantor: "ignored-client-value",
  }, "owner");
  const started = await module.service.runOnce(workspace.id, created.task.id);

  let receipt = module.service.getRunReceipt(workspace.id, created.task.id, started.id);
  for (let index = 0; index < 100 && receipt.run.status !== "completed"; index += 1) {
    await Bun.sleep(1);
    receipt = module.service.getRunReceipt(workspace.id, created.task.id, started.id);
  }
  expect(receipt.run.status).toBe("completed");
  expect(receipt.run.sessionId).toBe(`ses_${started.id}`);
  expect(receipt.artifacts.map((artifact) => artifact.value)).toEqual([
    "manual-result.md",
  ]);
  expect(await readFile(artifactPath, "utf8")).toContain("Manual Scheduled Tasks result");
  await module.stop();
});
