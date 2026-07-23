import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildOpenworkPluginSpecs,
  openworkCorePluginSpecs,
} from "./openwork-core-plugin-specs.js";
import { buildOpenworkRuntimeConfigObjectFromSnapshot } from "./openwork-runtime-config.js";
import { addPlugin, listPlugins, removePlugin } from "./plugins.js";
import { readRuntimeOpencodeConfig, writeRuntimeOpencodeConfig } from "./runtime-opencode-config-store.js";
import { startServer } from "./server.js";
import type { ServerConfig } from "./types.js";

const WORKSPACE_ID = "ws_core_plugins";
const roots: string[] = [];
let previousDb: string | undefined;

type Served = {
  port: number;
  stop: (closeActiveConnections?: boolean) => void | Promise<void>;
};

afterEach(async () => {
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
  if (previousDb === undefined) delete process.env.OPENWORK_RUNTIME_DB;
  else process.env.OPENWORK_RUNTIME_DB = previousDb;
});

async function setup(): Promise<{ root: string; config: ServerConfig }> {
  const root = await mkdtemp(join(tmpdir(), "openwork-core-plugins-"));
  roots.push(root);
  previousDb = process.env.OPENWORK_RUNTIME_DB;
  process.env.OPENWORK_RUNTIME_DB = join(root, "runtime.sqlite");
  return {
    root,
    config: {
      host: "127.0.0.1",
      port: 0,
      token: "token",
      hostToken: "host-token",
      approval: { mode: "auto", timeoutMs: 0 },
      corsOrigins: [],
      workspaces: [{
        id: WORKSPACE_ID,
        name: "Test",
        path: root,
        preset: "starter",
        workspaceType: "local",
      }],
      authorizedRoots: [root],
      readOnly: false,
      startedAt: Date.now(),
      tokenSource: "generated",
      hostTokenSource: "generated",
      logFormat: "pretty",
      logRequests: false,
    },
  };
}

describe("OpenWork core plugin inventory", () => {
  test("reports the exact managed-config sequence as a partial read-only inventory", async () => {
    const { root, config } = await setup();
    const coreSpecs = openworkCorePluginSpecs();
    await writeFile(join(root, "opencode.jsonc"), JSON.stringify({
      plugin: ["opencode-chrome-devtools@latest", "project-plugin"],
    }), "utf8");
    await writeRuntimeOpencodeConfig(config, WORKSPACE_ID, (current) => ({
      ...current,
      plugin: [coreSpecs[coreSpecs.length - 1], "runtime-plugin"],
    }));

    const listed = await listPlugins(config, WORKSPACE_ID, root, false);

    expect(listed.items.map((item) => item.spec)).toEqual([
      "opencode-chrome-devtools",
      "openwork-context",
      "runtime-plugin",
      "openwork-prompt-log",
      "opencode-chrome-devtools@latest",
      "project-plugin",
    ]);
    expect(listed.items.map((item) => item.source)).toEqual([
      "core",
      "core",
      "config",
      "core",
      "config",
      "config",
    ]);
    expect(listed.items[0]?.shadowedWithinInventoryBy).toBe("opencode-chrome-devtools@latest");
    expect(listed.items[4]?.shadowedWithinInventoryBy).toBeUndefined();
    expect(listed.loadOrder).toEqual([
      "config.managed",
      "config.project",
      "dir.project",
    ]);
    expect(listed.orderSemantics).toBe("partial-stage-order");
    expect(listed.uninspectedStages).toEqual([
      "config.global",
      "config.remote-account-managed",
      "dir.global",
    ]);
    expect(JSON.stringify(listed)).not.toContain(root);
    expect(JSON.stringify(listed)).not.toContain("openwork-context.ts");

    const managed = buildOpenworkRuntimeConfigObjectFromSnapshot({ plugin: ["runtime-plugin"] });
    expect(managed.plugin).toEqual(buildOpenworkPluginSpecs(["runtime-plugin"]));
  });

  test("deduplicates stale core and runtime identities in effective engine config", () => {
    const coreSpecs = openworkCorePluginSpecs();

    expect(buildOpenworkPluginSpecs([
      "opencode-chrome-devtools@latest",
      coreSpecs[1],
      "runtime-plugin@1.0.0",
      "runtime-plugin@2.0.0",
      coreSpecs[2],
    ])).toEqual([
      coreSpecs[0],
      coreSpecs[1],
      "runtime-plugin@2.0.0",
      coreSpecs[2],
    ]);
  });

  test("rejects adding a core identity before changing runtime state", async () => {
    const { config } = await setup();

    await expect(addPlugin(config, WORKSPACE_ID, "opencode-chrome-devtools@latest")).rejects.toMatchObject({
      status: 400,
      code: "core_plugin_read_only",
      message: "OpenWork core plugins are managed by OpenWork",
    });
    expect(await readRuntimeOpencodeConfig(config, WORKSPACE_ID)).toEqual({});
  });

  test("removes a stale runtime duplicate without removing the effective core plugin", async () => {
    const { config } = await setup();
    const coreSpec = openworkCorePluginSpecs()[1];
    await writeRuntimeOpencodeConfig(config, WORKSPACE_ID, (current) => ({
      ...current,
      plugin: [coreSpec, "runtime-plugin"],
    }));

    expect(await removePlugin(config, WORKSPACE_ID, coreSpec)).toBe(true);
    expect((await readRuntimeOpencodeConfig(config, WORKSPACE_ID)).plugin).toEqual(["runtime-plugin"]);
    expect(buildOpenworkRuntimeConfigObjectFromSnapshot({ plugin: [coreSpec, "runtime-plugin"] }).plugin)
      .toEqual(buildOpenworkPluginSpecs(["runtime-plugin"]));
  });

  test("rejects every core spec before changing runtime state", async () => {
    const { config } = await setup();

    for (const spec of openworkCorePluginSpecs()) {
      await expect(removePlugin(config, WORKSPACE_ID, spec)).rejects.toMatchObject({
        status: 400,
        code: "core_plugin_read_only",
        message: "OpenWork core plugins cannot be removed",
      });
    }

    expect(await readRuntimeOpencodeConfig(config, WORKSPACE_ID)).toEqual({});
  });

  test("returns a stable HTTP 400 when a core plugin removal is requested", async () => {
    const { config } = await setup();
    config.approval = { mode: "manual", timeoutMs: 10 };
    const server = await startServer(config) as Served;
    try {
      const response = await fetch(
        `http://127.0.0.1:${server.port}/workspace/${WORKSPACE_ID}/plugins/${encodeURIComponent("opencode-chrome-devtools@latest")}`,
        {
          method: "DELETE",
          headers: { authorization: `Bearer ${config.token}` },
        },
      );

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        code: "core_plugin_read_only",
        message: "OpenWork core plugins cannot be removed",
      });
    } finally {
      await server.stop(true);
    }
  });
});
