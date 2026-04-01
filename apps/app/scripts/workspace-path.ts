import assert from "node:assert/strict";

import { resolveCreatedLocalWorkspacePath } from "../src/app/lib/workspace-path.ts";

const winRaw = "C:/Users/Test/OpenWork/starter";
const winCanonical = String.raw`C:\Users\Test\OpenWork\starter`;

const results = {
  ok: true,
  steps: [] as Array<Record<string, unknown>>,
};

async function step(name: string, fn: () => void | Promise<void>) {
  results.steps.push({ name, status: "running" });
  const index = results.steps.length - 1;

  try {
    await fn();
    results.steps[index] = { name, status: "ok" };
  } catch (error) {
    results.ok = false;
    results.steps[index] = {
      name,
      status: "error",
      error: error instanceof Error ? error.message : String(error),
    };
    throw error;
  }
}

try {
  await step("prefers persisted local workspace path over raw picker path", () => {
    assert.equal(
      resolveCreatedLocalWorkspacePath({
        workspaceId: "ws_test",
        fallbackPath: winRaw,
        workspaces: [
          {
            id: "ws_test",
            name: "starter",
            path: winCanonical,
            preset: "starter",
            workspaceType: "local",
            remoteType: null,
            baseUrl: null,
            directory: null,
            displayName: null,
            openworkHostUrl: null,
            openworkToken: null,
            openworkWorkspaceId: null,
            openworkWorkspaceName: null,
            sandboxBackend: null,
            sandboxRunId: null,
            sandboxContainerName: null,
          },
        ],
      }),
      winCanonical,
    );
  });

  await step("falls back to the original path when no workspace match exists", () => {
    assert.equal(
      resolveCreatedLocalWorkspacePath({
        workspaceId: "ws_missing",
        fallbackPath: winRaw,
        workspaces: [],
      }),
      winRaw,
    );
  });

  await step("ignores remote workspace rows when resolving a local workspace path", () => {
    assert.equal(
      resolveCreatedLocalWorkspacePath({
        workspaceId: "ws_test",
        fallbackPath: winRaw,
        workspaces: [
          {
            id: "ws_test",
            name: "starter",
            path: "",
            preset: "remote",
            workspaceType: "remote",
            remoteType: "openwork",
            baseUrl: "https://example.com",
            directory: winCanonical,
            displayName: null,
            openworkHostUrl: "https://example.com",
            openworkToken: null,
            openworkWorkspaceId: "ow_ws_test",
            openworkWorkspaceName: "starter",
            sandboxBackend: null,
            sandboxRunId: null,
            sandboxContainerName: null,
          },
        ],
      }),
      winRaw,
    );
  });

  console.log(JSON.stringify(results, null, 2));
} catch (error) {
  results.ok = false;
  console.error(
    JSON.stringify(
      {
        ...results,
        error: error instanceof Error ? error.message : String(error),
      },
      null,
      2,
    ),
  );
  process.exitCode = 1;
}
