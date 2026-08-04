import { describe, expect, test } from "bun:test";
import type { ScheduledTaskScheduler } from "./scheduled-tasks/scheduled-task-scheduler.js";
import type { ScheduledTaskService } from "./scheduled-tasks/scheduled-task-service.js";
import { matchRoute, type Route } from "./routes/registry.js";
import { registerScheduledTaskRoutes } from "./routes/scheduled-tasks.js";
import type { ServerConfig } from "./types.js";

describe("scheduled task routes", () => {
  test("registers the stable collection, lifecycle, receipt, and deterministic tick paths", () => {
    const routes: Route[] = [];
    registerScheduledTaskRoutes({
      routes,
      config: {
        host: "127.0.0.1",
        port: 0,
        token: "token",
        hostToken: "host-token",
        approval: { mode: "manual", timeoutMs: 30_000 },
        corsOrigins: [],
        workspaces: [],
        authorizedRoots: [],
        readOnly: false,
        startedAt: 0,
        tokenSource: "cli",
        hostTokenSource: "cli",
        logFormat: "pretty",
        logRequests: false,
      } satisfies ServerConfig,
      service: {} as ScheduledTaskService,
      scheduler: {} as ScheduledTaskScheduler,
      jsonResponse: (data, status = 200) => Response.json(data, { status }),
      readJsonBody: async () => ({}),
      ensureWritable: () => undefined,
      requireClientScope: () => undefined,
      resolveWorkspaceWithoutBootstrap: async () => ({
        id: "ws_test",
        name: "Test",
        path: "/tmp/test",
        preset: "default",
        workspaceType: "local",
      }),
      allowDeterministicTick: true,
    });

    const paths: Array<[string, string]> = [
      ["GET", "/workspace/ws_test/scheduled-tasks"],
      ["POST", "/workspace/ws_test/scheduled-tasks"],
      ["POST", "/workspace/ws_test/scheduled-tasks/preview"],
      ["POST", "/workspace/ws_test/scheduled-tasks/scheduler/tick"],
      ["GET", "/workspace/ws_test/scheduled-tasks/task_1"],
      ["PATCH", "/workspace/ws_test/scheduled-tasks/task_1"],
      ["POST", "/workspace/ws_test/scheduled-tasks/task_1/review"],
      ["POST", "/workspace/ws_test/scheduled-tasks/task_1/enable"],
      ["POST", "/workspace/ws_test/scheduled-tasks/task_1/pause"],
      ["POST", "/workspace/ws_test/scheduled-tasks/task_1/resume"],
      ["POST", "/workspace/ws_test/scheduled-tasks/task_1/run"],
      ["POST", "/workspace/ws_test/scheduled-tasks/task_1/duplicate"],
      ["POST", "/workspace/ws_test/scheduled-tasks/task_1/revoke"],
      ["DELETE", "/workspace/ws_test/scheduled-tasks/task_1"],
      ["GET", "/workspace/ws_test/scheduled-tasks/task_1/runs"],
      ["GET", "/workspace/ws_test/scheduled-tasks/task_1/runs/run_1"],
      ["GET", "/workspace/ws_test/scheduled-tasks/task_1/runs/run_1/artifacts/artifact_1"],
      ["POST", "/workspace/ws_test/scheduled-tasks/task_1/runs/run_1/cancel"],
    ];

    for (const [method, path] of paths) {
      expect(matchRoute(routes, method, path)).not.toBeNull();
    }

    const ownerPaths: Array<[string, string]> = [
      ["POST", "/workspace/ws_test/scheduled-tasks/scheduler/tick"],
      ["POST", "/workspace/ws_test/scheduled-tasks/task_1/review"],
      ["POST", "/workspace/ws_test/scheduled-tasks/task_1/enable"],
      ["POST", "/workspace/ws_test/scheduled-tasks/task_1/resume"],
      ["POST", "/workspace/ws_test/scheduled-tasks/task_1/revoke"],
      ["DELETE", "/workspace/ws_test/scheduled-tasks/task_1"],
    ];
    for (const [method, path] of ownerPaths) {
      expect(matchRoute(routes, method, path)?.auth).toBe("host");
    }

    const collaboratorPaths: Array<[string, string]> = [
      ["POST", "/workspace/ws_test/scheduled-tasks"],
      ["PATCH", "/workspace/ws_test/scheduled-tasks/task_1"],
      ["POST", "/workspace/ws_test/scheduled-tasks/task_1/run"],
      ["POST", "/workspace/ws_test/scheduled-tasks/task_1/pause"],
      ["POST", "/workspace/ws_test/scheduled-tasks/task_1/runs/run_1/cancel"],
    ];
    for (const [method, path] of collaboratorPaths) {
      expect(matchRoute(routes, method, path)?.auth).toBe("client");
    }
  });
});
