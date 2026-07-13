import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startServer } from "./server.js";
import type { ServerConfig } from "./types.js";

const stops: Array<() => void | Promise<void>> = [];
const tempDirs: string[] = [];

afterEach(async () => {
  while (stops.length > 0) await stops.pop()?.();
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop()!, { recursive: true, force: true });
  }
});

async function makeWorkspace(): Promise<{ workspace: string; data: string }> {
  const root = await mkdtemp(join(tmpdir(), "openwork-export-package-"));
  tempDirs.push(root);
  const workspace = join(root, "workspace");
  const data = join(root, "data");
  await mkdir(join(workspace, ".opencode", "plugins", "demo"), { recursive: true });
  await mkdir(join(workspace, ".opencode", "tools"), { recursive: true });
  await mkdir(data, { recursive: true });
  await writeFile(
    join(workspace, "opencode.jsonc"),
    JSON.stringify({
      mcp: {
        jira: {
          type: "remote",
          url: "https://jira.example.com/mcp",
          headers: { Authorization: "Bearer abcdefghijklmnop" },
        },
      },
    }),
    "utf8",
  );
  await writeFile(
    join(workspace, ".opencode", "plugins", "demo", "index.ts"),
    "const token = 'ghp_1234567890abcdef';",
    "utf8",
  );
  await writeFile(
    join(workspace, ".opencode", "tools", "run.ts"),
    "console.log('safe tool');",
    "utf8",
  );
  return { workspace, data };
}

async function startExportServer(workspace: string, data: string) {
  const config: ServerConfig = {
    host: "127.0.0.1",
    port: 0,
    token: "test-token",
    hostToken: "host-token",
    configPath: join(data, "config.json"),
    approval: { mode: "auto", timeoutMs: 1000 },
    corsOrigins: [],
    workspaces: [{
      id: "workspace",
      name: "workspace",
      path: workspace,
      preset: "default",
      workspaceType: "local",
    }],
    authorizedRoots: [workspace],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "generated",
    hostTokenSource: "generated",
    logFormat: "pretty",
    logRequests: false,
  };
  const server = await startServer(config);
  stops.push(() => server.stop());
  return {
    baseUrl: `http://127.0.0.1:${server.port}`,
    headers: { Authorization: `Bearer ${config.token}` },
  };
}

describe("workspace export package adapter", () => {
  test("preserves the explicit sensitive-data decision and exclude behavior", async () => {
    const { workspace, data } = await makeWorkspace();
    const { baseUrl, headers } = await startExportServer(workspace, data);

    const undecided = await fetch(`${baseUrl}/workspace/workspace/export`, { headers });
    expect(undecided.status).toBe(409);
    const error = await undecided.json() as {
      code: string;
      details?: { warnings?: Array<{ id: string }> };
    };
    expect(error.code).toBe("workspace_export_requires_decision");
    expect(error.details?.warnings?.map((warning) => warning.id)).toEqual([
      "mcp-config",
      "portable-file:.opencode/plugins/demo/index.ts",
    ]);

    const excluded = await fetch(
      `${baseUrl}/workspace/workspace/export?sensitive=exclude`,
      { headers },
    );
    expect(excluded.status).toBe(200);
    const bundle = await excluded.json() as {
      workspaceId: string;
      opencode: Record<string, unknown>;
      files?: Array<{ path: string; content: string }>;
    };
    expect(bundle.workspaceId).toBe("workspace");
    expect(bundle.opencode).toEqual({
      mcp: { jira: { type: "remote", url: "https://jira.example.com/mcp" } },
    });
    expect(bundle.files).toEqual([
      { path: ".opencode/tools/run.ts", content: "console.log('safe tool');" },
    ]);
  });

  test("preserves include mode and the transport error for an invalid mode", async () => {
    const { workspace, data } = await makeWorkspace();
    const { baseUrl, headers } = await startExportServer(workspace, data);

    const included = await fetch(
      `${baseUrl}/workspace/workspace/export?sensitive=include`,
      { headers },
    );
    expect(included.status).toBe(200);
    const bundle = await included.json() as {
      opencode: { mcp?: { jira?: { headers?: { Authorization?: string } } } };
      files?: Array<{ path: string }>;
    };
    expect(bundle.opencode.mcp?.jira?.headers?.Authorization).toBe(
      "Bearer abcdefghijklmnop",
    );
    expect(bundle.files?.map((file) => file.path)).toEqual([
      ".opencode/plugins/demo/index.ts",
      ".opencode/tools/run.ts",
    ]);

    const invalid = await fetch(
      `${baseUrl}/workspace/workspace/export?sensitive=maybe`,
      { headers },
    );
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({
      code: "invalid_workspace_export_sensitive_mode",
    });
  });
});
