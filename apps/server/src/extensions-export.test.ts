import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addMcp } from "./mcp.js";
import { exportExtensions, redactMcpConfig, type ExportedMcp, type ExportedSkill } from "./extensions-export.js";
import { startServer } from "./server.js";
import type { ServerConfig } from "./types.js";

const WORKSPACE_ID = "ws_extensions_export_test";

type Served = {
  port: number;
  stop: (closeActiveConnections?: boolean) => void | Promise<void>;
};

function serverConfig(root: string): ServerConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    token: "token",
    hostToken: "host-token",
    configPath: join(root, "server.json"),
    approval: { mode: "auto", timeoutMs: 0 },
    corsOrigins: [],
    workspaces: [{ id: WORKSPACE_ID, name: "Test", path: root, preset: "starter", workspaceType: "local" }],
    authorizedRoots: [root],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "generated",
    hostTokenSource: "generated",
    logFormat: "pretty",
    logRequests: false,
  } satisfies ServerConfig;
}

async function withWorkspace(fn: (input: { root: string; config: ServerConfig }) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "openwork-extensions-export-"));
  const previousDb = process.env.OPENWORK_RUNTIME_DB;
  process.env.OPENWORK_RUNTIME_DB = join(root, "runtime.sqlite");
  try {
    await mkdir(join(root, ".git"), { recursive: true });
    await fn({ root, config: serverConfig(root) });
  } finally {
    if (previousDb === undefined) delete process.env.OPENWORK_RUNTIME_DB;
    else process.env.OPENWORK_RUNTIME_DB = previousDb;
    await rm(root, { recursive: true, force: true });
  }
}

const SKILL_CONTENT = "---\nname: release-notes\ndescription: Draft release notes\n---\n\nDo the thing.\n";

async function writeSkill(root: string) {
  const dir = join(root, ".opencode", "skills", "release-notes");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), SKILL_CONTENT, "utf8");
}

function findSkill(components: Array<ExportedSkill | ExportedMcp>, name: string): ExportedSkill | undefined {
  return components.find((item): item is ExportedSkill => item.kind === "skill" && item.name === name);
}

function findMcp(components: Array<ExportedSkill | ExportedMcp>, name: string): ExportedMcp | undefined {
  return components.find((item): item is ExportedMcp => item.kind === "mcp" && item.name === name);
}

describe("redactMcpConfig", () => {
  test("redacts header and environment values but keeps keys", () => {
    const { config, redactedKeys } = redactMcpConfig({
      type: "remote",
      url: "https://example.com/mcp",
      headers: { Authorization: "Bearer secret" },
      environment: { API_KEY: "sk-123" },
    });
    expect(config.url).toBe("https://example.com/mcp");
    expect(config.headers).toEqual({ Authorization: "<redacted>" });
    expect(config.environment).toEqual({ API_KEY: "<redacted>" });
    expect(redactedKeys.sort()).toEqual(["environment.API_KEY", "headers.Authorization"]);
  });

  test("leaves configs without secrets untouched", () => {
    const { config, redactedKeys } = redactMcpConfig({ type: "remote", url: "https://example.com/mcp" });
    expect(config).toEqual({ type: "remote", url: "https://example.com/mcp" });
    expect(redactedKeys).toEqual([]);
  });
});

describe("exportExtensions", () => {
  test("exports skill files and runtime MCPs with secrets redacted", async () => {
    await withWorkspace(async ({ root, config }) => {
      await writeSkill(root);
      await addMcp(config, WORKSPACE_ID, "linear", {
        type: "remote",
        url: "https://mcp.linear.app/sse",
        headers: { Authorization: "Bearer secret" },
        enabled: true,
      });

      const result = await exportExtensions({
        serverConfig: config,
        workspaceId: WORKSPACE_ID,
        workspaceRoot: root,
        skills: ["release-notes"],
        mcps: ["linear"],
      });

      const skill = findSkill(result.components, "release-notes");
      expect(skill?.content).toBe(SKILL_CONTENT);
      expect(skill?.description).toBe("Draft release notes");

      const mcp = findMcp(result.components, "linear");
      expect(mcp?.source).toBe("config.remote");
      expect(mcp?.config.url).toBe("https://mcp.linear.app/sse");
      expect(mcp?.config.headers).toEqual({ Authorization: "<redacted>" });
      expect(mcp?.redactedKeys).toEqual(["headers.Authorization"]);
      expect(result.missing).toEqual({ skills: [], mcps: [] });
    });
  });

  test("reports missing skills and MCPs", async () => {
    await withWorkspace(async ({ root, config }) => {
      const result = await exportExtensions({
        serverConfig: config,
        workspaceId: WORKSPACE_ID,
        workspaceRoot: root,
        skills: ["nope"],
        mcps: ["missing-mcp"],
      });
      expect(result.components).toEqual([]);
      expect(result.missing).toEqual({ skills: ["nope"], mcps: ["missing-mcp"] });
    });
  });
});

describe("POST /workspace/:id/extensions/export", () => {
  test("exports over HTTP with the client token", async () => {
    await withWorkspace(async ({ root, config }) => {
      await writeSkill(root);
      await addMcp(config, WORKSPACE_ID, "linear", {
        type: "remote",
        url: "https://mcp.linear.app/sse",
        headers: { Authorization: "Bearer secret" },
        enabled: true,
      });

      const server = await startServer(config) as Served;
      try {
        const response = await fetch(`http://127.0.0.1:${server.port}/workspace/${WORKSPACE_ID}/extensions/export`, {
          method: "POST",
          headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json" },
          body: JSON.stringify({ skills: ["release-notes"], mcps: ["linear"] }),
        });
        expect(response.status).toBe(200);
        const payload = await response.json() as { components: Array<ExportedSkill | ExportedMcp>; missing: { skills: string[]; mcps: string[] } };
        expect(JSON.stringify(payload)).not.toContain("Bearer secret");
        expect(findSkill(payload.components, "release-notes")?.content).toBe(SKILL_CONTENT);
        expect(findMcp(payload.components, "linear")?.redactedKeys).toEqual(["headers.Authorization"]);

        const empty = await fetch(`http://127.0.0.1:${server.port}/workspace/${WORKSPACE_ID}/extensions/export`, {
          method: "POST",
          headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json" },
          body: JSON.stringify({}),
        });
        expect(empty.status).toBe(400);
      } finally {
        await server.stop(true);
      }
    });
  });
});

describe("openwork_extensions_export plugin tool", () => {
  test("exports end to end through the bundled plugin tool", async () => {
    await withWorkspace(async ({ root, config }) => {
      await writeSkill(root);
      await addMcp(config, WORKSPACE_ID, "linear", {
        type: "remote",
        url: "https://mcp.linear.app/sse",
        headers: { Authorization: "Bearer secret" },
        enabled: true,
      });

      const server = await startServer(config) as Served;
      const previousUrl = process.env.OPENWORK_SERVER_URL;
      const previousToken = process.env.OPENWORK_SERVER_TOKEN;
      process.env.OPENWORK_SERVER_URL = `http://127.0.0.1:${server.port}`;
      process.env.OPENWORK_SERVER_TOKEN = config.token;
      try {
        const { OpenWorkExtensionsPreview } = await import("./opencode-plugins/openwork-extensions-preview.js");
        const plugin = await OpenWorkExtensionsPreview();
        const output = await plugin.tool.openwork_extensions_export.execute(
          { skills: ["release-notes"], mcps: ["linear", "not-installed"] },
          { directory: root },
        );
        expect(output).not.toContain("Bearer secret");
        const parsed = JSON.parse(output) as {
          ok: boolean;
          workspaceId: string;
          components: Array<ExportedSkill | ExportedMcp>;
          missing: { skills: string[]; mcps: string[] };
        };
        expect(parsed.ok).toBe(true);
        expect(parsed.workspaceId).toBe(WORKSPACE_ID);
        expect(findSkill(parsed.components, "release-notes")?.content).toBe(SKILL_CONTENT);
        expect(findMcp(parsed.components, "linear")?.config.headers).toEqual({ Authorization: "<redacted>" });
        expect(parsed.missing).toEqual({ skills: [], mcps: ["not-installed"] });
      } finally {
        if (previousUrl === undefined) delete process.env.OPENWORK_SERVER_URL;
        else process.env.OPENWORK_SERVER_URL = previousUrl;
        if (previousToken === undefined) delete process.env.OPENWORK_SERVER_TOKEN;
        else process.env.OPENWORK_SERVER_TOKEN = previousToken;
        await server.stop(true);
      }
    });
  });
});
