import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
import { needs, test, unmetNeeds } from "@openwork/testkit";
import type { TestNeeds } from "@openwork/testkit";
import constants from "../../constants.json" with { type: "json" };
import type { EffectiveEnginePermissionRule } from "../../apps/server/src/agent-context-engine-inspection.js";
import { validateEffectiveEngineSnapshot } from "../../apps/server/src/agent-context-engine-inspection.js";
import {
  selectGoverningAgent,
  summarizeEffectivePermissions,
  type EffectivePermissionRow,
} from "../../apps/server/src/effective-permissions.js";
import { buildOpenworkRuntimeConfigObjectFromSnapshot } from "../../apps/server/src/openwork-runtime-config.js";
import type { RuntimeOpencodeConfig } from "../../apps/server/src/runtime-opencode-config-store.js";

/**
 * "How agents run here" must report what the engine will actually do and
 * which config layer decided it. This boots the pinned engine with a user
 * global file, OpenWork's rendered injected file, and a workspace file, reads
 * the evaluated ruleset from GET /agent exactly as the server route does, and
 * checks the summary rows and their attribution against known inputs.
 */

const requirements: TestNeeds = { commands: ["opencode"] };
const missingRequirements = unmetNeeds(requirements, process.env);
const skipSuffix = missingRequirements.length > 0 ? ` skipped — needs: ${missingRequirements.join(", ")}` : "";
const AUTH = "Basic " + Buffer.from("probe:probe").toString("base64");

interface EngineInput {
  runtime: RuntimeOpencodeConfig;
  globalConfig?: Record<string, unknown>;
  projectConfig?: Record<string, unknown>;
}

interface BootedEngine {
  version: string;
  home: string;
  rows: () => Promise<EffectivePermissionRow[]>;
  agentName: () => Promise<string>;
  [Symbol.asyncDispose]: () => Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stableJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableJson);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableJson(value[key])]));
}

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.unref();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (!address || typeof address === "string") {
        probe.close();
        reject(new Error("Failed to allocate a free port"));
        return;
      }
      probe.close(() => resolve(address.port));
    });
  });
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGTERM");
  const graceful = await Promise.race([exited.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2_500))]);
  if (!graceful) {
    child.kill("SIGKILL");
    await exited;
  }
}

async function bootEngine(input: EngineInput): Promise<BootedEngine> {
  const root = await mkdtemp(join(tmpdir(), "openwork-effective-permissions-"));
  const workspace = join(root, "workspace");
  const home = join(root, "home");
  const xdg = join(root, "xdg");
  await Promise.all([mkdir(workspace, { recursive: true }), mkdir(home, { recursive: true }), mkdir(join(xdg, "config", "opencode"), { recursive: true })]);

  // Plugins would pull packages at boot and do not affect permission rules.
  const { plugin: _plugin, ...injected } = buildOpenworkRuntimeConfigObjectFromSnapshot(input.runtime);
  const injectedPath = join(root, "runtime-opencode-config.json");
  await writeFile(injectedPath, JSON.stringify(stableJson(injected)), "utf8");
  await writeFile(join(xdg, "config", "opencode", "opencode.json"), JSON.stringify(input.globalConfig ?? {}), "utf8");
  if (input.projectConfig) await writeFile(join(workspace, "opencode.json"), JSON.stringify(input.projectConfig), "utf8");

  const port = await freePort();
  const child = spawn("opencode", ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: workspace,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      OPENCODE_CONFIG: injectedPath,
      OPENCODE_SERVER_USERNAME: "probe",
      OPENCODE_SERVER_PASSWORD: "probe",
      OPENCODE_TEST_HOME: home,
      XDG_CONFIG_HOME: join(xdg, "config"),
      XDG_DATA_HOME: join(xdg, "data"),
      XDG_CACHE_HOME: join(xdg, "cache"),
      XDG_STATE_HOME: join(xdg, "state"),
      OPENCODE_CLIENT: "openwork-test",
    },
  });
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => { stderr += chunk; });
  const baseUrl = `http://127.0.0.1:${port}`;
  const dispose = async () => {
    await stop(child);
    await rm(root, { recursive: true, force: true });
  };

  const request = async (path: string): Promise<unknown> => {
    const url = new URL(path, baseUrl);
    url.searchParams.set("directory", workspace);
    const response = await fetch(url.toString(), { headers: { Authorization: AUTH }, signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`GET ${path} → ${response.status}`);
    return response.json();
  };

  const deadline = Date.now() + 45_000;
  let version = "";
  while (Date.now() < deadline && !version) {
    if (child.exitCode !== null) break;
    try {
      const health = await request("/global/health");
      if (isRecord(health) && health.healthy === true && typeof health.version === "string") version = health.version;
    } catch {
      // not up yet
    }
    if (!version) await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!version) {
    await dispose();
    throw new Error(`opencode serve never became healthy: ${stderr.slice(0, 800)}`);
  }

  // Exactly what the server route does: validate the engine's answer, pick
  // the governing agent, summarise with the three config layers as written.
  const summarise = async () => {
    const [config, agents] = await Promise.all([request("/config"), request("/agent")]);
    const snapshot = validateEffectiveEngineSnapshot({ config, agents });
    if (!snapshot) throw new Error("engine snapshot did not validate");
    const agent = selectGoverningAgent(snapshot.agents, snapshot.defaultAgent);
    if (!agent) throw new Error("no governing agent");
    const rules: EffectiveEnginePermissionRule[] = agent.permission;
    return {
      agent: agent.name,
      rows: summarizeEffectivePermissions(rules, {
        global: input.globalConfig?.permission,
        openwork: injected.permission,
        workspace: input.projectConfig?.permission,
      }, home),
    };
  };
  return {
    version,
    home,
    rows: async () => (await summarise()).rows,
    agentName: async () => (await summarise()).agent,
    [Symbol.asyncDispose]: dispose,
  };
}

function byKey(rows: EffectivePermissionRow[]): Record<string, { action: string; source: string | null; exceptions: number }> {
  return Object.fromEntries(rows.map((row) => [row.key, { action: row.action, source: row.source, exceptions: row.exceptions }]));
}

test.skipIf(missingRequirements.length > 0)(
  `the effective permissions summary reports the engine's decisions and names the layer that made each${skipSuffix}`,
  async ({ evidence }) => {
    needs(requirements);

    // Default install with two authorized folders: everything the engine
    // allows by default is attributed to it; the outside-folder ask is the
    // engine's, its two grants are OpenWork's exceptions.
    await using plain = await bootEngine({ runtime: { permission: { external_directory: { "/shared/*": "allow", "/blocked/*": "deny" } } } });
    expect(plain.version).toBe(constants.opencodeVersion.replace(/^v/, ""));
    expect(await plain.agentName()).toBe("openwork");
    const defaults = byKey(await plain.rows());
    expect(defaults.shell).toEqual({ action: "allow", source: "engine", exceptions: 0 });
    expect(defaults.edit).toEqual({ action: "allow", source: "engine", exceptions: 0 });
    expect(defaults.web).toEqual({ action: "allow", source: "engine", exceptions: 0 });
    expect(defaults.mcp).toEqual({ action: "allow", source: "engine", exceptions: 0 });
    expect(defaults.outside_folders?.action).toBe("ask");
    expect(defaults.outside_folders?.source).toBe("engine");
    expect(defaults.outside_folders?.exceptions).toBeGreaterThanOrEqual(2);
    expect(defaults.env_files).toEqual({ action: "ask", source: "engine", exceptions: 2 });
    expect(defaults.doom_loop).toEqual({ action: "ask", source: "engine", exceptions: 0 });
    evidence.recordAssertionEvidence(
      "A default install is reported as the engine's own posture",
      `Engine ${plain.version}: ${JSON.stringify(defaults)}.`,
      true,
    );

    // Each layer wins for the key it sets, and the summary says which one.
    await using layered = await bootEngine({
      runtime: { permission: { external_directory: { "/shared/*": "allow" } } },
      // webfetch is action-only in the engine schema; bash takes the pattern map.
      globalConfig: { permission: { bash: { "*": "ask", "git status *": "allow" }, webfetch: "ask" } },
      projectConfig: { permission: { edit: "deny" } },
    });
    const rows = byKey(await layered.rows());
    // The global file asks for shell commands, with one narrower allow.
    expect(rows.shell).toEqual({ action: "ask", source: "global", exceptions: 1 });
    // The workspace file is the last word on edits.
    expect(rows.edit).toEqual({ action: "deny", source: "workspace", exceptions: 0 });
    expect(rows.web).toEqual({ action: "ask", source: "global", exceptions: 0 });
    // Nothing configured MCP tools or doom loops: engine defaults remain.
    expect(rows.mcp).toEqual({ action: "allow", source: "engine", exceptions: 0 });
    expect(rows.doom_loop).toEqual({ action: "ask", source: "engine", exceptions: 0 });
    expect(rows.outside_folders?.source).toBe("engine");
    evidence.recordAssertionEvidence(
      "Each decision is attributed to the layer that wrote the winning rule",
      `Global {bash: ask + "git status *" allow, webfetch: ask} and workspace {edit: deny} → ${JSON.stringify(rows)}.`,
      true,
    );
  },
);
