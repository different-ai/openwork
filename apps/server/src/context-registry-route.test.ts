import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startServer } from "./server.js";
import type { ServerConfig } from "./types.js";

const CLIENT_TOKEN = "owt_context_registry_client";
const previousRuntimeDb = process.env.OPENWORK_RUNTIME_DB;
const previousUiControlTools = process.env.OPENWORK_UI_CONTROL_TOOLS;
const previousLeakSentinel = process.env.OPENWORK_REGISTRY_LEAK_SENTINEL;
const stops: Array<() => void | Promise<void>> = [];
const roots: string[] = [];

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(async () => {
  while (stops.length > 0) await stops.pop()?.();
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
  restoreEnv("OPENWORK_RUNTIME_DB", previousRuntimeDb);
  restoreEnv("OPENWORK_UI_CONTROL_TOOLS", previousUiControlTools);
  restoreEnv("OPENWORK_REGISTRY_LEAK_SENTINEL", previousLeakSentinel);
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function responseRecord(response: Response): Promise<Record<string, unknown>> {
  const body: unknown = await response.json();
  if (!isRecord(body)) throw new Error("Expected an object response");
  return body;
}

function recordArray(value: unknown, label: string): Record<string, unknown>[] {
  if (!Array.isArray(value) || !value.every(isRecord)) throw new Error(`Expected ${label} to be an object array`);
  return value;
}

function recordById(items: Record<string, unknown>[], id: string): Record<string, unknown> {
  const item = items.find((candidate) => candidate.id === id);
  if (!item) throw new Error(`Missing registry item ${id}`);
  return item;
}

async function boot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "openwork-context-registry-"));
  roots.push(root);
  process.env.OPENWORK_RUNTIME_DB = join(root, "runtime.sqlite");
  const config: ServerConfig = {
    host: "127.0.0.1",
    port: 0,
    token: CLIENT_TOKEN,
    hostToken: "owt_context_registry_host",
    configPath: join(root, "server.json"),
    approval: { mode: "auto", timeoutMs: 1_000 },
    corsOrigins: [],
    workspaces: [{
      id: "ws_context_registry",
      name: "Context registry",
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
  };
  const server = await startServer(config);
  stops.push(() => server.stop());
  return `http://127.0.0.1:${server.port}`;
}

describe("context registry route", () => {
  test("requires client auth, disables caching, and reports safe current gate results", async () => {
    const secret = "owt_context_registry_must_not_leak";
    process.env.OPENWORK_UI_CONTROL_TOOLS = secret;
    process.env.OPENWORK_REGISTRY_LEAK_SENTINEL = secret;
    const base = await boot();
    const url = `${base}/experimental/context/registry`;

    expect((await fetch(url)).status).toBe(401);

    const disabledResponse = await fetch(url, {
      headers: { authorization: `Bearer ${CLIENT_TOKEN}` },
    });
    expect(disabledResponse.status).toBe(200);
    expect(disabledResponse.headers.get("cache-control")).toBe("no-store");
    const disabledBody = await responseRecord(disabledResponse);
    expect(disabledBody.ok).toBe(true);
    expect(disabledBody.schemaVersion).toBe(1);
    expect(JSON.stringify(disabledBody)).not.toContain(secret);
    expect(recordById(recordArray(disabledBody.gates, "gates"), "ui-control-tools")).toEqual({
      id: "ui-control-tools",
      enabled: false,
      reason: "gate_disabled",
    });
    expect(recordById(recordArray(disabledBody.contributors, "contributors"), "ui-control-tools")).toMatchObject({
      kind: "tool",
      gate: "contributor-env",
      gateEnv: ["OPENWORK_UI_CONTROL_TOOLS"],
      toolNames: [
        "openwork_ui_snapshot",
        "openwork_ui_list_actions",
        "openwork_ui_execute_action",
      ],
    });

    process.env.OPENWORK_UI_CONTROL_TOOLS = "true";
    const enabledResponse = await fetch(url, {
      headers: { authorization: `Bearer ${CLIENT_TOKEN}` },
    });
    expect(enabledResponse.headers.get("cache-control")).toBe("no-store");
    const enabledBody = await responseRecord(enabledResponse);
    expect(recordById(recordArray(enabledBody.gates, "gates"), "ui-control-guidance")).toEqual({
      id: "ui-control-guidance",
      enabled: true,
      reason: "gate_enabled",
    });
    expect(recordById(recordArray(enabledBody.gates, "gates"), "ui-control-tools")).toEqual({
      id: "ui-control-tools",
      enabled: true,
      reason: "gate_enabled",
    });
    expect(JSON.stringify(enabledBody)).not.toContain(secret);
  });
});
