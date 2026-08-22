import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { readRuntimeOpencodeConfig, writeRuntimeOpencodeConfig } from "./runtime-opencode-config-store.js";
import type { ServerConfig } from "./types.js";
import {
  OFFICECLI_MCP_NAME,
  markOfficeCliManagedMcpRemoved,
  readOfficeCliProvisionState,
  reconcileOfficeCliMcp,
  reconcileOfficeCliMcpForAllWorkspaces,
  resolveOfficeCliBinary,
  writeOfficeCliProvisionState,
} from "./officecli-mcp.js";

const previousPlatform = process.platform;

afterEach(() => {
  Object.defineProperty(process, "platform", { value: previousPlatform });
});

function testServerConfig(workspaceRoot: string, workspaceId: string): ServerConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    token: "token",
    hostToken: "host-token",
    configPath: join(workspaceRoot, "server.json"),
    approval: { mode: "auto", timeoutMs: 0 },
    corsOrigins: [],
    workspaces: [{ id: workspaceId, name: "Test", path: workspaceRoot, preset: "starter", workspaceType: "local" }],
    authorizedRoots: [workspaceRoot],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "generated",
    hostTokenSource: "generated",
    logFormat: "pretty",
    logRequests: false,
  } satisfies ServerConfig;
}

describe("resolveOfficeCliBinary", () => {
  test("returns OPENWORK_OFFICECLI_PATH when the file exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "officecli-resolve-"));
    const binary = join(root, "officecli.exe");
    await writeFile(binary, "");
    try {
      const resolved = resolveOfficeCliBinary({
        OPENWORK_OFFICECLI_PATH: binary,
        LOCALAPPDATA: join(root, "unused"),
        PATH: "",
      });
      expect(resolved).toBe(binary);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("returns default LOCALAPPDATA install path on win32", async () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    const root = await mkdtemp(join(tmpdir(), "officecli-localappdata-"));
    const officeCliDir = join(root, "OfficeCLI");
    const binary = join(officeCliDir, "officecli.exe");
    await mkdir(officeCliDir, { recursive: true });
    await writeFile(binary, "");
    try {
      const resolved = resolveOfficeCliBinary({
        LOCALAPPDATA: root,
        PATH: "",
      });
      expect(resolved).toBe(binary);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("returns null on non-windows when override is unset", () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    expect(resolveOfficeCliBinary({ LOCALAPPDATA: "/tmp", PATH: "/usr/bin" })).toBeNull();
  });

  test("returns null when no candidate exists", () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    expect(resolveOfficeCliBinary({ LOCALAPPDATA: "C:\\missing", PATH: "" })).toBeNull();
  });
});

describe("officecli provision state", () => {
  test("reads and writes managed state in openwork workspace config", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "officecli-provision-"));
    const workspaceId = "ws_officecli";
    const previousDb = process.env.OPENWORK_RUNTIME_DB;
    process.env.OPENWORK_RUNTIME_DB = join(workspaceRoot, "runtime.sqlite");
    const config = testServerConfig(workspaceRoot, workspaceId);
    try {
      expect(await readOfficeCliProvisionState(config, workspaceId)).toBeNull();
      await writeOfficeCliProvisionState(config, workspaceId, "managed");
      expect(await readOfficeCliProvisionState(config, workspaceId)).toBe("managed");
      await writeOfficeCliProvisionState(config, workspaceId, "removed");
      expect(await readOfficeCliProvisionState(config, workspaceId)).toBe("removed");
    } finally {
      process.env.OPENWORK_RUNTIME_DB = previousDb;
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});

describe("reconcileOfficeCliMcp", () => {
  test("adds managed local MCP when absent", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "officecli-reconcile-add-"));
    const workspaceId = "ws_add";
    const previousDb = process.env.OPENWORK_RUNTIME_DB;
    process.env.OPENWORK_RUNTIME_DB = join(workspaceRoot, "runtime.sqlite");
    const config = testServerConfig(workspaceRoot, workspaceId);
    const binary = join(workspaceRoot, "officecli.exe");
    await writeFile(binary, "");
    try {
      const result = await reconcileOfficeCliMcp(config, workspaceId, binary);
      expect(result).toBe("added");
      const runtime = await readRuntimeOpencodeConfig(config, workspaceId);
      expect(runtime.mcp?.[OFFICECLI_MCP_NAME]).toEqual({
        type: "local",
        enabled: true,
        command: [binary, "mcp"],
        openworkManaged: true,
      });
    } finally {
      process.env.OPENWORK_RUNTIME_DB = previousDb;
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("skips when provision state is removed", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "officecli-reconcile-removed-"));
    const workspaceId = "ws_removed";
    const previousDb = process.env.OPENWORK_RUNTIME_DB;
    process.env.OPENWORK_RUNTIME_DB = join(workspaceRoot, "runtime.sqlite");
    const config = testServerConfig(workspaceRoot, workspaceId);
    const binary = join(workspaceRoot, "officecli.exe");
    await writeFile(binary, "");
    try {
      await writeOfficeCliProvisionState(config, workspaceId, "removed");
      const result = await reconcileOfficeCliMcp(config, workspaceId, binary);
      expect(result).toBe("skipped");
      expect(await readRuntimeOpencodeConfig(config, workspaceId)).toEqual({});
    } finally {
      process.env.OPENWORK_RUNTIME_DB = previousDb;
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("does not modify user-owned MCP entry", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "officecli-reconcile-user-"));
    const workspaceId = "ws_user";
    const previousDb = process.env.OPENWORK_RUNTIME_DB;
    process.env.OPENWORK_RUNTIME_DB = join(workspaceRoot, "runtime.sqlite");
    const config = testServerConfig(workspaceRoot, workspaceId);
    const binary = join(workspaceRoot, "officecli.exe");
    const userBinary = join(workspaceRoot, "custom-officecli.exe");
    await writeFile(binary, "");
    await writeFile(userBinary, "");
    try {
      await writeRuntimeOpencodeConfig(config, workspaceId, (current) => ({
        ...current,
        mcp: {
          [OFFICECLI_MCP_NAME]: {
            type: "local",
            enabled: true,
            command: [userBinary, "mcp"],
          },
        },
      }));
      const result = await reconcileOfficeCliMcp(config, workspaceId, binary);
      expect(result).toBe("skipped");
      const runtime = await readRuntimeOpencodeConfig(config, workspaceId);
      expect(runtime.mcp?.[OFFICECLI_MCP_NAME]?.command).toEqual([userBinary, "mcp"]);
    } finally {
      process.env.OPENWORK_RUNTIME_DB = previousDb;
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});

describe("reconcileOfficeCliMcpForAllWorkspaces", () => {
  test("provisions officecli MCP for every workspace when binary exists", async () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    const workspaceRoot = await mkdtemp(join(tmpdir(), "officecli-all-"));
    const workspaceId = "ws_all";
    const previousDb = process.env.OPENWORK_RUNTIME_DB;
    process.env.OPENWORK_RUNTIME_DB = join(workspaceRoot, "runtime.sqlite");
    const binary = join(workspaceRoot, "officecli.exe");
    await writeFile(binary, "");
    const config = testServerConfig(workspaceRoot, workspaceId);
    try {
      process.env.OPENWORK_OFFICECLI_PATH = binary;
      await reconcileOfficeCliMcpForAllWorkspaces(config);
      const runtime = await readRuntimeOpencodeConfig(config, workspaceId);
      expect(runtime.mcp?.[OFFICECLI_MCP_NAME]?.command).toEqual([binary, "mcp"]);
    } finally {
      delete process.env.OPENWORK_OFFICECLI_PATH;
      process.env.OPENWORK_RUNTIME_DB = previousDb;
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});

describe("officecli managed delete opt-out", () => {
  test("marks provision removed when managed officecli MCP is deleted", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "officecli-delete-"));
    const workspaceId = "ws_delete";
    const previousDb = process.env.OPENWORK_RUNTIME_DB;
    process.env.OPENWORK_RUNTIME_DB = join(workspaceRoot, "runtime.sqlite");
    const config = testServerConfig(workspaceRoot, workspaceId);
    const binary = join(workspaceRoot, "officecli.exe");
    await writeFile(binary, "");
    try {
      await reconcileOfficeCliMcp(config, workspaceId, binary);
      await markOfficeCliManagedMcpRemoved(config, workspaceId);
      expect(await readOfficeCliProvisionState(config, workspaceId)).toBe("removed");
      const retry = await reconcileOfficeCliMcp(config, workspaceId, binary);
      expect(retry).toBe("skipped");
    } finally {
      process.env.OPENWORK_RUNTIME_DB = previousDb;
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});
