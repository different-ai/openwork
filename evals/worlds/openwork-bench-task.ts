import { execFile, spawn, spawnSync } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { allocateFreePort } from "@openwork/cdp";
import { resolveEvalEngine, SkipError } from "@openwork/env";
import type { Place, Seed } from "@openwork/env";
import type { MockAgentToolStep } from "@openwork/labs";
import { configureProvider } from "./chat.ts";
import { OPENWORK_BENCH_REPO, OPENWORK_BENCH_REVISION } from "./openwork-bench-source.ts";

/** The sample task: a public-dev task that needs mail and drive and has a stale-document trap. */
const TASK = { id: "expense-policy-answer", path: "tasks/research/expense-policy-answer/task.yaml" };
/** The MCP server name openwork-bench's openwork-desktop harness gives the task world. */
const SERVER = "owb-world";
const JORDAN = "jordan.blake@larkspur.example";
const REPLY = "I replied to Jordan: $56 of the $68 dinner can be reimbursed under the 2025 policy.";
const START_MS = 240_000;

export interface BenchGrade {
  score: number;
  success: boolean;
  checks: { id: string; passed: boolean }[];
}

function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number): string {
  const result = spawnSync(command, args, { cwd, env, encoding: "utf8", timeout: timeoutMs });
  if (result.status !== 0) throw new Error(`${command} ${args.slice(0, 3).join(" ")} failed: ${(result.stderr || result.stdout || String(result.error)).slice(-1_000)}`);
  return result.stdout;
}

/** uvx or pipx runs `owb` from the checkout; the task world never needs a model key, so none is passed. */
function benchRunner(checkout: string): { command: string; prefix: string[]; env: NodeJS.ProcessEnv } {
  const spec = `openwork-bench[mcp] @ file://${checkout}`;
  const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? checkout, TMPDIR: process.env.TMPDIR ?? "/tmp", OWB_TASKS_DIR: join(checkout, "tasks") };
  if (spawnSync("uvx", ["--version"], { stdio: "ignore" }).status === 0) return { command: "uvx", prefix: ["--from", spec, "owb"], env };
  if (spawnSync("pipx", ["--version"], { stdio: "ignore" }).status === 0) return { command: "pipx", prefix: ["run", "--spec", spec, "owb"], env };
  throw new SkipError("uvx or pipx on PATH, to run the OpenWork Bench task world");
}

/** The task's brief: its `brief: |` block. */
export function taskBrief(taskYaml: string): string {
  const lines = taskYaml.split("\n");
  const start = lines.findIndex((line) => /^brief:\s*\|\s*$/.test(line));
  if (start < 0) throw new Error("The OpenWork Bench task has no brief.");
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("  ")) body.push(line.slice(2));
    else if (line.trim() === "") body.push("");
    else break;
  }
  return body.join("\n").trim();
}

/** `owb grade-state` prints the score as JSON, then one `[pass]`/`[FAIL]` line per check. */
export function parseGrade(stdout: string): BenchGrade {
  const split = stdout.indexOf("\n  [");
  const summary: unknown = JSON.parse(split < 0 ? stdout : stdout.slice(0, split));
  if (typeof summary !== "object" || summary === null || !("score" in summary) || !("success" in summary)
    || typeof summary.score !== "number" || typeof summary.success !== "boolean") {
    throw new Error("owb grade-state did not print a score.");
  }
  const checks = [...stdout.matchAll(/^\s+\[(pass|FAIL)\] (\S+)/gm)].map((match) => ({ id: match[2] ?? "", passed: match[1] === "pass" }));
  return { score: summary.score, success: summary.success, checks };
}

async function startTaskWorld(runner: ReturnType<typeof benchRunner>, checkout: string, statePath: string) {
  const port = await allocateFreePort();
  const child = spawn(runner.command, [...runner.prefix, "world", "serve", TASK.id, "--http", "--port", String(port), "--state-out", statePath], {
    cwd: checkout, env: runner.env, stdio: ["ignore", "pipe", "pipe"],
  });
  const mcpUrl = await new Promise<string>((resolve, reject) => {
    let log = "";
    let started = false;
    const timer = setTimeout(() => reject(new Error(`The OpenWork Bench task world did not start within ${START_MS / 1000}s: ${log.slice(-1_000)}`)), START_MS);
    const read = (chunk: Buffer) => {
      if (started) return;
      log += chunk.toString("utf8");
      const url = /OpenWork Bench world for \S+ at (http:\/\/127\.0\.0\.1:\d+\/mcp)/.exec(log)?.[1];
      if (url) {
        started = true;
        clearTimeout(timer);
        resolve(url);
      }
    };
    child.stdout.on("data", read);
    child.stderr.on("data", read);
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`The OpenWork Bench task world exited (code ${code}): ${log.slice(-1_000)}`));
    });
  });
  return { mcpUrl, stop: () => { child.kill("SIGTERM"); } };
}

/**
 * One OpenWork Bench task in the app (headless Chrome, real server and engine):
 * the task's simulated workplace runs from the pinned openwork-bench checkout
 * and is attached as the remote MCP server `owb-world` with local edit, shell
 * and web tools denied, exactly as the openwork-desktop harness configures a
 * workspace. A scripted model works the task through those tools, so the
 * footage shows a real run of the app and the task world without spending on
 * a model. The task's own checks grade the world's final state.
 */
export async function openworkBenchTaskWorld(seed: Seed, { place }: { place: Place }) {
  if (place.kind !== "local") throw new SkipError("local placement (--local): the task world runs next to the app on loopback");
  const engine = resolveEvalEngine();
  const root = seed.tmpPath("openwork-bench");
  const checkout = join(root, "openwork-bench");
  await mkdir(checkout, { recursive: true });
  const git = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? root };
  run("git", ["init", "-q", "."], checkout, git, 30_000);
  run("git", ["fetch", "-q", "--depth", "1", OPENWORK_BENCH_REPO, OPENWORK_BENCH_REVISION], checkout, git, 120_000);
  run("git", ["checkout", "-q", "--detach", "FETCH_HEAD"], checkout, git, 30_000);
  const runner = benchRunner(checkout);
  const brief = taskBrief(await readFile(join(checkout, TASK.path), "utf8"));
  const statePath = join(root, "state.json");

  await using setup = new AsyncDisposableStack();
  const taskWorld = await startTaskWorld(runner, checkout, statePath);
  setup.defer(taskWorld.stop);

  const tool = (name: string, args: Record<string, unknown>): MockAgentToolStep => ({ tool: `${SERVER}_${name}`, arguments: args });
  const mock = seed.mock({
    isolatedProcessEnv: true,
    agentWorkloads: [{
      promptMarker: brief.split("\n")[0] ?? brief, latestUserTurn: true, finalReply: REPLY, steps: [
        tool("mail_search", { query: "Jordan dinner" }),
        tool("mail_read", { message_id: "m1" }),
        tool("drive_search", { query: "travel expense policy" }),
        tool("drive_read", { path: "/policies/travel-and-expense-policy-2025.md" }),
        tool("mail_send", {
          to: [JORDAN], subject: "Re: Can I expense this dinner?", reply_to_id: "m1",
          body: "Hi Jordan,\n\nYes. The 2025 travel and expense policy covers dinner up to $60, and alcohol is never reimbursable, so you can claim $56 of the $68 (the $12 glass of wine is excluded). Keep the itemized receipt and submit it through the expense tool within 30 days.\n\nSam",
        }),
        tool("submit", { answer: "Replied to Jordan: $56 is reimbursable; the wine is excluded; an itemized receipt is needed." }),
      ],
    }],
  });
  const workspacePath = join(root, "workspace");
  const app = await seed.appWeb({ name: "openwork-bench", workspacePath, engine, mocks: { agent: mock } });
  const witness = app.mocks.agent;
  if (!witness) throw new Error("The scripted model did not start.");
  const workspace = await seed.workspace(app, workspacePath);
  await configureProvider(seed, app, workspace.workspaceId, "openwork-bench-scripted", "scripted-agent", {
    mcp: { [SERVER]: { type: "remote", url: taskWorld.mcpUrl, enabled: true, oauth: false } },
    permission: { edit: "deny", bash: "deny", webfetch: "deny", external_directory: "deny", [`${SERVER}_*`]: "allow" },
    provider: { "openwork-bench-scripted": {
      npm: "@ai-sdk/openai-compatible", name: "Scripted agent",
      options: { baseURL: `${witness.url}/v1`, apiKey: "sk-openwork-bench-scripted" },
      models: { "scripted-agent": { name: "Scripted agent" } },
    } },
  }, engine);
  const session = await seed.session(app, { title: `OpenWork Bench · ${TASK.id}` });
  const resources = setup.move();
  return {
    app, engine, workspace, session, brief, reply: REPLY, task: TASK.id, revision: OPENWORK_BENCH_REVISION,
    /** The task's own checks over the task world's current state. */
    grade: async () => {
      const { stdout } = await promisify(execFile)(runner.command, [...runner.prefix, "grade-state", TASK.id, statePath], { cwd: checkout, env: runner.env, timeout: 120_000 });
      return parseGrade(stdout);
    },
    [Symbol.asyncDispose]: () => resources.disposeAsync(),
  };
}
