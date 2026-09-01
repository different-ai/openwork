import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
import { needs, test, unmetNeeds } from "@openwork/testkit";
import type { TestNeeds } from "@openwork/testkit";
import constants from "../../constants.json" with { type: "json" };
import { buildOpenworkRuntimeConfigObjectFromSnapshot } from "../../apps/server/src/openwork-runtime-config.js";
import type { RuntimeOpencodeConfig } from "../../apps/server/src/runtime-opencode-config-store.js";

/**
 * The run mode is only as real as the ruleset the engine actually evaluates.
 * `run-mode-run-everything` witnesses the rendered file; this spec boots the
 * pinned engine binary with that file under OPENCODE_CONFIG — exactly how the
 * managed engine receives it — and reads back each agent's effective ruleset
 * from GET /agent. Every decision below is the engine's own merge of its
 * defaults, the user's global config, the injected file, and the workspace's
 * own opencode.json.
 */

const requirements: TestNeeds = { commands: ["opencode"] };
const missingRequirements = unmetNeeds(requirements, process.env);
const skipSuffix = missingRequirements.length > 0 ? ` skipped — needs: ${missingRequirements.join(", ")}` : "";

type Action = "allow" | "ask" | "deny";
interface Rule {
  permission: string;
  pattern: string;
  action: Action;
}
interface Engine {
  decide: (agent: string, permission: string, pattern: string) => Promise<Action>;
  version: string;
  [Symbol.asyncDispose]: () => Promise<void>;
}
interface EngineInput {
  runtime: RuntimeOpencodeConfig;
  globalConfig?: Record<string, unknown>;
  projectConfig?: Record<string, unknown>;
}

const storedFolders = { "/shared/*": "allow", "/blocked/*": "deny" };
const AUTH = "Basic " + Buffer.from("probe:probe").toString("base64");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAction(value: unknown): value is Action {
  return value === "allow" || value === "ask" || value === "deny";
}

function parseRules(value: unknown): Rule[] {
  if (!Array.isArray(value)) throw new Error(`Expected a permission ruleset: ${JSON.stringify(value)}`);
  return value.map((entry) => {
    if (!isRecord(entry) || typeof entry.permission !== "string" || typeof entry.pattern !== "string" || !isAction(entry.action)) {
      throw new Error(`Invalid permission rule: ${JSON.stringify(entry)}`);
    }
    return { permission: entry.permission, pattern: entry.pattern, action: entry.action };
  });
}

// The engine renders the injected file with sorted keys (stableStringify);
// mirror that so the engine sees the same key order the server writes.
function stableJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableJson);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableJson(value[key])]));
}

// Engine `Wildcard.match` (packages/core/src/util/wildcard.ts) and the final
// step of `Permission.evaluate` (last matching rule wins, default ask).
function wildcard(input: string, pattern: string): boolean {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "s").test(input);
}

function evaluate(rules: Rule[], permission: string, pattern: string): Action {
  const winner = rules.findLast((rule) => wildcard(permission, rule.permission) && wildcard(pattern, rule.pattern));
  return winner?.action ?? "ask";
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

async function bootEngine(input: EngineInput): Promise<Engine> {
  const root = await mkdtemp(join(tmpdir(), "openwork-run-mode-engine-"));
  const workspace = join(root, "workspace");
  const home = join(root, "home");
  const xdg = join(root, "xdg");
  await Promise.all([mkdir(workspace, { recursive: true }), mkdir(home, { recursive: true }), mkdir(join(xdg, "config", "opencode"), { recursive: true })]);

  // Plugins are irrelevant to permission evaluation and would pull packages
  // from the network at boot; everything else is the server's real rendering.
  const { plugin: _plugin, ...rendered } = buildOpenworkRuntimeConfigObjectFromSnapshot(input.runtime);
  const injectedPath = join(root, "runtime-opencode-config.json");
  await writeFile(injectedPath, JSON.stringify(stableJson(rendered)), "utf8");
  await writeFile(join(xdg, "config", "opencode", "opencode.json"), JSON.stringify(input.globalConfig ?? {}), "utf8");
  if (input.projectConfig) {
    await writeFile(join(workspace, "opencode.json"), JSON.stringify(input.projectConfig), "utf8");
  }

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

  const deadline = Date.now() + 45_000;
  let version = "";
  while (Date.now() < deadline && !version) {
    if (child.exitCode !== null) break;
    try {
      const response = await fetch(`${baseUrl}/global/health`, {
        headers: { Authorization: AUTH },
        signal: AbortSignal.timeout(2_000),
      });
      if (response.ok) {
        const health: unknown = await response.json();
        if (isRecord(health) && health.healthy === true && typeof health.version === "string") version = health.version;
      }
    } catch {
      // not up yet
    }
    if (!version) await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!version) {
    await dispose();
    throw new Error(`opencode serve never became healthy on ${baseUrl}: ${stderr.slice(0, 800)}`);
  }

  const rulesets = new Map<string, Rule[]>();
  const loadRules = async (agent: string): Promise<Rule[]> => {
    const cached = rulesets.get(agent);
    if (cached) return cached;
    const response = await fetch(`${baseUrl}/agent?directory=${encodeURIComponent(workspace)}`, {
      headers: { Authorization: AUTH },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`GET /agent failed with ${response.status}`);
    const agents: unknown = await response.json();
    if (!Array.isArray(agents)) throw new Error("Expected an agent list");
    for (const entry of agents) {
      if (isRecord(entry) && typeof entry.name === "string") rulesets.set(entry.name, parseRules(entry.permission));
    }
    const rules = rulesets.get(agent);
    if (!rules) throw new Error(`Agent ${agent} is not defined by the engine`);
    return rules;
  };

  return {
    version,
    decide: async (agent, permission, pattern) => evaluate(await loadRules(agent), permission, pattern),
    [Symbol.asyncDispose]: dispose,
  };
}

async function decisions(engine: Engine, agent: string): Promise<Record<string, Action>> {
  const probes: Array<[string, string, string]> = [
    ["bash", "bash", "ls -la"],
    ["bash_rm", "bash", "rm -rf build"],
    ["edit", "edit", "src/index.ts"],
    ["webfetch", "webfetch", "https://example.com"],
    ["mcp_tool", "acme_mcp_search", "*"],
    ["read_env", "read", "config/.env"],
    ["read_env_local", "read", "config/.env.local"],
    ["outside_granted", "external_directory", "/shared/report.md"],
    ["outside_blocked", "external_directory", "/blocked/report.md"],
    ["outside_other", "external_directory", "/elsewhere/report.md"],
    ["doom_loop", "doom_loop", "*"],
    ["skill_customize", "skill", "customize-opencode"],
  ];
  const result: Record<string, Action> = {};
  for (const [name, permission, pattern] of probes) {
    result[name] = await engine.decide(agent, permission, pattern);
  }
  return result;
}

const defaultInstallExpectation: Record<string, Action> = {
  bash: "allow",
  bash_rm: "allow",
  edit: "allow",
  webfetch: "allow",
  mcp_tool: "allow",
  read_env: "ask",
  read_env_local: "ask",
  outside_granted: "allow",
  outside_blocked: "deny",
  outside_other: "ask",
  doom_loop: "ask",
  skill_customize: "deny",
};

test.skipIf(missingRequirements.length > 0)(
  `approve mode is the pinned engine's own posture and run everything keeps every protection interactive${skipSuffix}`,
  async ({ evidence }) => {
    needs(requirements);
    await using approve = await bootEngine({ runtime: { permission: { external_directory: storedFolders } } });
    expect(approve.version).toBe(constants.opencodeVersion.replace(/^v/, ""));

    // Claim: "Approve each step" adds nothing — it is the engine's default
    // posture plus the stored authorized-folder rules. On a default install
    // that posture already allows shell, edit, webfetch, and MCP tools and
    // asks only for outside-folder access, .env reads, and doom loops.
    const approveDecisions = await decisions(approve, "openwork");
    expect(approveDecisions).toEqual(defaultInstallExpectation);

    await using runEverything = await bootEngine({
      runtime: { run_mode: "run-everything", permission: { external_directory: storedFolders } },
    });
    const runEverythingDecisions = await decisions(runEverything, "openwork");
    // Protections stay interactive and stored denies plus the injected agent's
    // skill denies survive: the evaluated ruleset is identical for every probe.
    expect(runEverythingDecisions).toEqual(defaultInstallExpectation);
    evidence.recordAssertionEvidence(
      "Run everything keeps outside-folder, .env, and doom-loop prompts and never upgrades a stored or agent deny",
      `Engine ${runEverything.version} evaluated the openwork agent identically in both modes on a default install: ${JSON.stringify(runEverythingDecisions)}.`,
      true,
    );
    evidence.recordAssertionEvidence(
      "Run everything changes a default install's shell, edit, webfetch, or MCP decisions",
      `It does not: the pinned engine already allows them (${JSON.stringify(approveDecisions)}); the preset only matters where a global opencode.json asks.`,
      false,
    );

    // Known limit: the built-in read-only explore subagent is guarded by an
    // agent-level "*": deny that the engine merges before user config, so the
    // catch-all allow lifts it.
    expect(await approve.decide("explore", "edit", "src/index.ts")).toBe("deny");
    const exploreEdit = await runEverything.decide("explore", "edit", "src/index.ts");
    expect(exploreEdit).toBe("allow");
    evidence.recordAssertionEvidence(
      "Run everything leaves the engine's read-only explore subagent read-only",
      `explore edit decision is ${JSON.stringify(exploreEdit)} under run everything (deny under approve).`,
      exploreEdit === "deny",
    );
  },
);

test.skipIf(missingRequirements.length > 0)(
  `run everything skips a global opencode.json ask but overrides its deny rules unless a leading "*" entry orders them last${skipSuffix}`,
  async ({ evidence }) => {
    needs(requirements);
    const runtime: RuntimeOpencodeConfig = { run_mode: "run-everything", permission: { external_directory: storedFolders } };
    const globalDenies = { permission: { bash: { "rm *": "deny" }, edit: "deny" } };

    await using control = await bootEngine({ runtime: { permission: runtime.permission }, globalConfig: globalDenies });
    expect(await control.decide("openwork", "bash", "rm -rf build")).toBe("deny");
    expect(await control.decide("openwork", "edit", "src/index.ts")).toBe("deny");

    // Known limit: the engine merges the injected file after the global file
    // and appends new keys, so a catch-all lands after these denies and wins.
    await using overridden = await bootEngine({ runtime, globalConfig: globalDenies });
    const rmDecision = await overridden.decide("openwork", "bash", "rm -rf build");
    const editDecision = await overridden.decide("openwork", "edit", "src/index.ts");
    expect(rmDecision).toBe("allow");
    expect(editDecision).toBe("allow");
    evidence.recordAssertionEvidence(
      "Run everything preserves deny rules written in the user's global opencode.json",
      `Global {bash:{"rm *":deny}, edit:deny} without a leading "*" evaluates to rm=${rmDecision}, edit=${editDecision} under run everything (deny/deny under approve).`,
      rmDecision === "deny" && editDecision === "deny",
    );

    // When the user's file leads with "*" the injected allow replaces that
    // entry in place and the later deny rules keep winning.
    const globalWithStar = { permission: { "*": "ask", bash: { "rm *": "deny" }, edit: "deny" } };
    await using askControl = await bootEngine({ runtime: { permission: runtime.permission }, globalConfig: globalWithStar });
    expect(await askControl.decide("openwork", "bash", "ls -la")).toBe("ask");
    await using ordered = await bootEngine({ runtime, globalConfig: globalWithStar });
    expect(await ordered.decide("openwork", "bash", "ls -la")).toBe("allow");
    expect(await ordered.decide("openwork", "webfetch", "https://example.com")).toBe("allow");
    expect(await ordered.decide("openwork", "bash", "rm -rf build")).toBe("deny");
    expect(await ordered.decide("openwork", "edit", "src/index.ts")).toBe("deny");
    evidence.recordAssertionEvidence(
      "Run everything skips a global ask and keeps later deny rules when the global file leads with \"*\"",
      "bash ls: ask → allow; webfetch: ask → allow; bash rm and edit stay deny.",
      true,
    );
  },
);

test.skipIf(missingRequirements.length > 0)(
  `run everything never changes rules in a workspace's own opencode.json${skipSuffix}`,
  async ({ evidence }) => {
    needs(requirements);
    await using engine = await bootEngine({
      runtime: { run_mode: "run-everything", permission: { external_directory: storedFolders } },
      projectConfig: { permission: { bash: { "rm *": "deny" }, edit: "deny", webfetch: "ask" } },
    });
    // The workspace file is merged after the injected file, so its ask and
    // deny rules are the last word for this workspace.
    const rm = await engine.decide("openwork", "bash", "rm -rf build");
    const edit = await engine.decide("openwork", "edit", "src/index.ts");
    const fetchDecision = await engine.decide("openwork", "webfetch", "https://example.com");
    const ls = await engine.decide("openwork", "bash", "ls -la");
    expect({ rm, edit, fetchDecision, ls }).toEqual({ rm: "deny", edit: "deny", fetchDecision: "ask", ls: "allow" });
    evidence.recordAssertionEvidence(
      "A workspace's own opencode.json ask and deny rules survive run everything",
      `rm=${rm}, edit=${edit}, webfetch=${fetchDecision}, ls=${ls} with project rules {bash:{"rm *":deny}, edit:deny, webfetch:ask}.`,
      true,
    );
  },
);
