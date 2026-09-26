#!/usr/bin/env node
// Real-agent eval: can a coding agent discover, install, and connect OpenWork
// using only llms.txt and the pages it links?
//
//   pnpm build && pnpm exec next start -p 3005 &
//   node scripts/agent-discovery-eval.mjs --base-url http://localhost:3005 --out /tmp/agent-test \
//     [--agents codex,gemini,claude] [--codex-bin codex] [--gemini-model <model>]
//
// Runs each installed, signed-in agent CLI headless against the local build,
// saves transcripts to --out, and greps the final answers for the exact
// commands. It also lets one agent run `claude mcp add` inside a throwaway
// HOME and checks `claude mcp list`. Nothing is installed and no account is
// created. Agents that are missing or not signed in are reported as skipped.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};
const baseUrl = option("--base-url", "http://localhost:3005").replace(/\/$/, "");
const outDir = option("--out", join(tmpdir(), "openwork-agent-test"));
const codexBin = option("--codex-bin", "codex");
const geminiModel = option("--gemini-model", "");
const agents = option("--agents", "codex,gemini,claude").split(",").map((agent) => agent.trim()).filter(Boolean);
mkdirSync(outDir, { recursive: true });

const MCP_URL = "https://api.openworklabs.com/mcp/agent";
const CLAUDE_ADD = new RegExp(`claude mcp add --transport http openwork ${MCP_URL.replaceAll(".", "\\.")}`);

// llms.txt links use production URLs; point the agent at the local build.
const preamble = `You are helping a user. Only use ${baseUrl}/llms.txt and pages it links to (fetch each one with \`curl -sL <url>\`). This is a pre-release build: any https://openworklabs.com/... URL except /docs is served at ${baseUrl}/... - fetch it from there. Do not install anything and do not create accounts. Answer with exact commands and URLs.`;

const prompts = [
  {
    id: "solo-mac",
    prompt: `${preamble}\n\nUser: I want an open-source Claude Cowork alternative on my Mac. Tell me the exact commands to install it and connect it to Claude Code.`,
    checks: [
      ["install command or mac download URL", (text) => /brew install --cask openwork/.test(text) || /openworklabs\.com\/download\/mac-(arm64|x64)/.test(text)],
      ["exact `claude mcp add ... /mcp/agent`", (text) => CLAUDE_ADD.test(text)],
    ],
  },
  {
    id: "team-20",
    prompt: `${preamble}\n\nUser: My team of 20 wants OpenWork with shared skills. What do we do, step by step?`,
    checks: [
      ["signup URL", (text) => /app\.openworklabs\.com\/?\?mode=sign-up/.test(text)],
      ["shared skill path (Plugin Directory / Collection / skill)", (text) => /Plugin Directory|Collection/i.test(text)],
      ["desktop install for members", (text) => /brew install --cask openwork|openworklabs\.com\/download/.test(text)],
    ],
  },
];

const noNpx = ["does not recommend `npx openwork`", (text) => text.split("\n").every((line) => !/npx openwork|npm (i|install)( -g)? openwork\b/.test(line) || /not|don't|never|avoid|different|unrelated|wrong/i.test(line))];

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, { encoding: "utf8", timeout: 15 * 60 * 1000, maxBuffer: 64 * 1024 * 1024, ...options });
  return { code: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "", error: result.error?.message };
}

function workdir() {
  return mkdtempSync(join(tmpdir(), "openwork-agent-eval-"));
}

function geminiArgs() {
  return geminiModel ? ["-m", geminiModel] : [];
}

const runners = {
  codex: {
    probe: () => {
      const status = run(codexBin, ["login", "status"]);
      return `${status.stdout}${status.stderr}`.includes("Logged in");
    },
    ask(prompt, cwd, env) {
      const last = join(cwd, "last-message.txt");
      const result = run(codexBin, ["exec", "--skip-git-repo-check", "-C", cwd, "-s", "workspace-write", "-c", "sandbox_workspace_write.network_access=true", "-o", last, prompt], { cwd, env });
      let answer = "";
      try { answer = readFileSync(last, "utf8"); } catch { answer = ""; }
      return { transcript: `${result.stdout}\n--- stderr ---\n${result.stderr}`, answer, code: result.code };
    },
  },
  gemini: {
    probe: () => run("gemini", [...geminiArgs(), "say ok"], { timeout: 120000 }).stdout.toLowerCase().includes("ok"),
    ask(prompt, cwd, env) {
      const result = run("gemini", [...geminiArgs(), "--allowed-tools", "run_shell_command(curl)", "--output-format", "json", prompt], { cwd, env });
      let answer = result.stdout;
      try { answer = JSON.parse(result.stdout).response ?? result.stdout; } catch { answer = result.stdout; }
      return { transcript: `${result.stdout}\n--- stderr ---\n${result.stderr}`, answer, code: result.code };
    },
  },
  claude: {
    probe: () => {
      const result = run("claude", ["-p", "say ok", "--output-format", "json"], { timeout: 120000 });
      try { return JSON.parse(result.stdout).is_error === false; } catch { return false; }
    },
    ask(prompt, cwd, env) {
      const result = run("claude", ["-p", prompt, "--allowedTools", "WebFetch", "Bash(curl:*)", "--output-format", "stream-json", "--verbose"], { cwd, env });
      const events = result.stdout.split("\n").filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
      const final = events.findLast((event) => event.type === "result");
      return { transcript: `${result.stdout}\n--- stderr ---\n${result.stderr}`, answer: final?.result ?? "", code: result.code };
    },
  },
};

const summary = [];
const available = [];
for (const agent of agents) {
  const runner = runners[agent];
  if (!runner) { summary.push({ agent, test: "-", verdict: "skip", note: "unknown agent" }); continue; }
  if (!runner.probe()) { summary.push({ agent, test: "-", verdict: "skip", note: "CLI missing or not signed in" }); continue; }
  available.push(agent);
  for (const { id, prompt, checks } of prompts) {
    const cwd = workdir();
    const { transcript, answer } = runner.ask(prompt, cwd, process.env);
    writeFileSync(join(outDir, `${agent}-${id}.transcript.txt`), `PROMPT:\n${prompt}\n\n${transcript}`);
    writeFileSync(join(outDir, `${agent}-${id}.answer.md`), answer);
    const results = [...checks, noNpx].map(([name, check]) => ({ name, ok: check(answer) }));
    const failed = results.filter((result) => !result.ok).map((result) => result.name);
    summary.push({ agent, test: id, verdict: failed.length === 0 && answer.trim() ? "pass" : "fail", note: failed.length ? `missing: ${failed.join("; ")}` : `${results.length} checks` });
    rmSync(cwd, { recursive: true, force: true });
  }
}

// Execution run: the agent runs `claude mcp add` itself in a throwaway HOME.
// `claude mcp add` only writes local config and needs no Claude sign-in.
// Codex is the executor because CODEX_HOME keeps its sign-in while HOME is swapped.
const executor = available.includes("codex") ? "codex" : undefined;
if (executor && run("claude", ["--version"]).code === 0) {
  const home = workdir();
  const env = { ...process.env, HOME: home, CODEX_HOME: process.env.CODEX_HOME ?? join(homedir(), ".codex") };
  const prompt = `${preamble}\n\nUser: Connect OpenWork to my Claude Code. Find the exact command in llms.txt and run it yourself now (it only writes local Claude Code config). Then run \`claude mcp list\` and show me the output. Do not try to sign in.`;
  const { transcript, answer } = runners[executor].ask(prompt, home, env);
  writeFileSync(join(outDir, `${executor}-execute-claude-mcp-add.transcript.txt`), `PROMPT:\n${prompt}\nHOME=${home}\n\n${transcript}`);
  writeFileSync(join(outDir, `${executor}-execute-claude-mcp-add.answer.md`), answer);
  const list = run("claude", ["mcp", "list"], { cwd: home, env: { ...process.env, HOME: home }, timeout: 120000 });
  const get = run("claude", ["mcp", "get", "openwork"], { cwd: home, env: { ...process.env, HOME: home }, timeout: 120000 });
  writeFileSync(join(outDir, "claude-mcp-list.txt"), `$ claude mcp list\n${list.stdout}${list.stderr}\n$ claude mcp get openwork\n${get.stdout}${get.stderr}`);
  const ok = /openwork/.test(list.stdout) && get.stdout.includes(MCP_URL);
  summary.push({ agent: executor, test: "execute-claude-mcp-add", verdict: ok ? "pass" : "fail", note: ok ? "`claude mcp list` shows openwork -> /mcp/agent" : "openwork not registered" });
  rmSync(home, { recursive: true, force: true });
} else {
  summary.push({ agent: executor ?? "-", test: "execute-claude-mcp-add", verdict: "skip", note: "needs a signed-in codex and the claude CLI" });
}

const lines = summary.map((row) => `${row.verdict.padEnd(5)} ${row.agent.padEnd(7)} ${row.test.padEnd(24)} ${row.note}`);
writeFileSync(join(outDir, "summary.txt"), `${lines.join("\n")}\n`);
console.log(lines.join("\n"));
console.log(`\nTranscripts: ${outDir}`);
process.exit(summary.some((row) => row.verdict === "fail") ? 1 : 0);
