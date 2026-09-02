import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
import { needs, test, unmetNeeds } from "@openwork/testkit";
import type { TestNeeds } from "@openwork/testkit";
import constants from "../../constants.json" with { type: "json" };
import { validateEffectiveEngineSnapshot } from "../../apps/server/src/agent-context-engine-inspection.js";
import { attributeRule, selectGoverningAgent, winningRule } from "../../apps/server/src/effective-permissions.js";
import { readJsoncFile } from "../../apps/server/src/jsonc.js";
import {
  addWorkspacePermissionRule,
  listWorkspacePermissionRules,
  removeWorkspacePermissionRule,
} from "../../apps/server/src/workspace-permission-rules.js";

/**
 * "Always allow in this workspace" writes the engine's suggested pattern into
 * the workspace's opencode.json. This boots the pinned engine on such a
 * workspace and checks that the engine reads the written rule as the last
 * word — allow for the covered command, unchanged elsewhere — attributes it
 * to the workspace file, and that removing the entry restores the previous
 * decision. The file's own comments survive the round trip.
 */

const requirements: TestNeeds = { commands: ["opencode"] };
const missingRequirements = unmetNeeds(requirements, process.env);
const skipSuffix = missingRequirements.length > 0 ? ` skipped — needs: ${missingRequirements.join(", ")}` : "";
const AUTH = "Basic " + Buffer.from("probe:probe").toString("base64");
const emptyConfig: Record<string, unknown> = {};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

interface Engine {
  version: string;
  workspace: string;
  home: string;
  /** Rebuild the instance so the workspace file is re-read, then return the governing agent's ruleset. */
  reloadRules: () => Promise<Array<{ permission: string; pattern: string; action: "allow" | "ask" | "deny" }>>;
  [Symbol.asyncDispose]: () => Promise<void>;
}

async function bootEngine(workspaceFile: string): Promise<Engine> {
  const root = await mkdtemp(join(tmpdir(), "openwork-workspace-rules-engine-"));
  const workspace = join(root, "workspace");
  const home = join(root, "home");
  const xdg = join(root, "xdg");
  await Promise.all([mkdir(workspace, { recursive: true }), mkdir(home, { recursive: true }), mkdir(join(xdg, "config", "opencode"), { recursive: true })]);
  await writeFile(join(workspace, "opencode.json"), workspaceFile, "utf8");
  await writeFile(join(xdg, "config", "opencode", "opencode.json"), "{}", "utf8");
  const port = await freePort();
  const child = spawn("opencode", ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: workspace,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
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
  const request = async (method: string, path: string): Promise<unknown> => {
    const url = new URL(path, baseUrl);
    url.searchParams.set("directory", workspace);
    const response = await fetch(url.toString(), { method, headers: { Authorization: AUTH }, signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`${method} ${path} → ${response.status}`);
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  };
  const deadline = Date.now() + 45_000;
  let version = "";
  while (Date.now() < deadline && !version) {
    if (child.exitCode !== null) break;
    try {
      const health = await request("GET", "/global/health");
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
  const reloadRules = async () => {
    await request("POST", "/instance/dispose");
    const [config, agents] = await Promise.all([request("GET", "/config"), request("GET", "/agent")]);
    const snapshot = validateEffectiveEngineSnapshot({ config, agents });
    if (!snapshot) throw new Error("engine snapshot did not validate");
    const agent = selectGoverningAgent(snapshot.agents, snapshot.defaultAgent);
    if (!agent) throw new Error("no governing agent");
    return agent.permission;
  };
  return { version, workspace, home, reloadRules, [Symbol.asyncDispose]: dispose };
}

test.skipIf(missingRequirements.length > 0)(
  `a rule saved into the workspace's opencode.json is read by the engine as the last word and can be removed again${skipSuffix}`,
  async ({ evidence }) => {
    needs(requirements);
    await using engine = await bootEngine(`{
  // project policy: shell commands ask
  "$schema": "https://opencode.ai/config.json",
  "permission": { "bash": "ask" }
}
`);
    expect(engine.version).toBe(constants.opencodeVersion.replace(/^v/, ""));
    const workspaceLayer = async () => (await readJsoncFile(join(engine.workspace, "opencode.json"), emptyConfig, { allowInvalid: true })).data.permission;

    const before = await engine.reloadRules();
    expect(winningRule(before, "bash", "git status --porcelain")?.action).toBe("ask");

    // What the prompt button does: the engine's suggested pattern becomes an allow entry in the file.
    expect(await addWorkspacePermissionRule(engine.workspace, { permission: "bash", pattern: "git status *", action: "allow" })).toBe(true);
    const after = await engine.reloadRules();
    const saved = winningRule(after, "bash", "git status --porcelain");
    expect(saved?.action).toBe("allow");
    expect(saved ? attributeRule(saved, { global: undefined, openwork: undefined, workspace: await workspaceLayer() }, engine.home) : null).toBe("workspace");
    // Everything else keeps asking; the rule is exactly as narrow as the engine proposed.
    expect(winningRule(after, "bash", "git push origin main")?.action).toBe("ask");
    expect(winningRule(after, "bash", "rm -rf build")?.action).toBe("ask");
    expect(await readFile(join(engine.workspace, "opencode.json"), "utf8")).toContain("// project policy: shell commands ask");
    evidence.recordAssertionEvidence(
      "An allow rule saved from a prompt is enforced by the engine for exactly that pattern and attributed to the workspace file",
      `bash "git status --porcelain" ask → allow (source workspace); "git push" and "rm -rf" still ask; the file's comment survived.`,
      true,
    );

    // Revoking from Settings removes the entry; the engine asks again.
    expect(await removeWorkspacePermissionRule(engine.workspace, { permission: "bash", pattern: "git status *" })).toBe(true);
    expect(await listWorkspacePermissionRules(engine.workspace)).toEqual([{ permission: "bash", pattern: "*", action: "ask" }]);
    const restored = await engine.reloadRules();
    expect(winningRule(restored, "bash", "git status --porcelain")?.action).toBe("ask");
    evidence.recordAssertionEvidence(
      "Removing the saved rule restores the previous decision",
      `bash "git status --porcelain" is back to ask after the entry was removed from opencode.json.`,
      true,
    );
  },
);
