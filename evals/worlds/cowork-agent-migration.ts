import { spawn } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SkipError } from "@openwork/env";
import type { Seed } from "@openwork/env";
import { COWORK_FIXTURE, denCoworkMarketplace, writeCoworkHome } from "./den-cowork-marketplace.ts";
import type { DenCoworkMarketplaceWorld } from "./den-cowork-marketplace.ts";

// The migration as people will actually run it: they paste one prompt into
// the coding agent they already use, and that agent follows migrate.md.
//
// This world gives a real Claude Code agent (headless, real model) a computer
// that has Claude Cowork's files (one GitHub marketplace, one folder-based
// marketplace, a skill the person wrote, one of Anthropic's built-ins), the
// openwork-bootstrap CLI from this checkout on its PATH, and a signed-in
// OpenWork account on this world's Den, whose GitHub import reads the fixture
// marketplace. The spec scores what the agent did and what the organization
// ends up with; nothing in the prompt names commands or flags.

const BOOTSTRAP_CLI = fileURLToPath(new URL("../../packages/openwork-bootstrap/bin/openwork.mjs", import.meta.url));
const MIGRATE_GUIDE = fileURLToPath(new URL("../../packages/openwork-bootstrap/migrate.md", import.meta.url));

/** Env var holding the Anthropic key for the agent's model. Never printed. */
export const AGENT_KEY_ENV = "OPENWORK_EVAL_AGENT_ANTHROPIC_API_KEY";

export type AgentRun = {
  code: number;
  /** Every shell command the agent ran, in order. */
  commands: string[];
  /** The agent's final message to the person. */
  finalText: string;
  /** The full stream-json transcript, for leak checks and diagnostics. */
  transcript: string;
  turns: number;
};

export interface CoworkAgentMigrationWorld extends DenCoworkMarketplaceWorld {
  /** Runs Claude Code once with this message from the person, in the prepared computer. */
  runAgent(message: string): Promise<AgentRun>;
  /** The person's OpenWork session token, so a spec can assert it never appears in the transcript. */
  sessionToken: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readTranscript(stdout: string): Pick<AgentRun, "commands" | "finalText" | "turns"> {
  const commands: string[] = [];
  let finalText = "";
  let turns = 0;
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    let event: unknown;
    try { event = JSON.parse(line); } catch { continue; }
    if (!isRecord(event)) continue;
    if (event.type === "result") {
      if (typeof event.result === "string") finalText = event.result;
      if (typeof event.num_turns === "number") turns = event.num_turns;
    }
    if (event.type !== "assistant" || !isRecord(event.message) || !Array.isArray(event.message.content)) continue;
    for (const block of event.message.content) {
      if (isRecord(block) && block.type === "tool_use" && block.name === "Bash" && isRecord(block.input) && typeof block.input.command === "string") {
        commands.push(block.input.command);
      }
    }
  }
  return { commands, finalText, turns };
}

export async function coworkAgentMigration(seed: Seed): Promise<CoworkAgentMigrationWorld> {
  const apiKey = process.env[AGENT_KEY_ENV]?.trim();
  if (!apiKey) throw new SkipError(`set ${AGENT_KEY_ENV} to run a real agent`);
  const base = await denCoworkMarketplace(seed);

  // The person's computer.
  const home = seed.tmpPath("agent-home");
  const bin = join(home, ".local", "bin");
  const workdir = join(home, "work");
  mkdirSync(bin, { recursive: true });
  mkdirSync(workdir, { recursive: true });
  mkdirSync(join(home, ".openwork"), { recursive: true, mode: 0o700 });
  const coworkDir = writeCoworkHome(join(home, "cowork"), COWORK_FIXTURE.repo);
  const claudeCodePlugins = join(home, ".claude", "plugins");
  mkdirSync(claudeCodePlugins, { recursive: true });
  // Already installed and signed in: install.sh and the browser approval are
  // covered elsewhere; this world is about whether the agent can do the move.
  const cli = join(bin, "openwork-bootstrap");
  writeFileSync(cli, `#!/usr/bin/env sh\nexec node "${BOOTSTRAP_CLI}" "$@"\n`);
  chmodSync(cli, 0o755);
  writeFileSync(join(home, ".openwork", "credentials.json"), JSON.stringify({
    baseUrl: base.den.ref.apiUrl,
    accessToken: base.den.admin.token,
    expiresAt: null,
    user: { email: base.den.admin.email },
  }), { mode: 0o600 });
  copyFileSync(MIGRATE_GUIDE, join(workdir, "migrate.md"));

  return {
    ...base,
    sessionToken: base.den.admin.token,
    runAgent(message) {
      return new Promise((resolve) => {
        const child = spawn("claude", [
          "-p", message,
          "--output-format", "stream-json",
          "--verbose",
          "--dangerously-skip-permissions",
          "--max-turns", "40",
        ], {
          cwd: workdir,
          env: {
            PATH: `${bin}:${process.env.PATH ?? ""}`,
            HOME: home,
            ANTHROPIC_API_KEY: apiKey,
            OPENWORK_COWORK_DIR: coworkDir,
            OPENWORK_CLAUDE_CODE_PLUGINS_DIR: claudeCodePlugins,
          },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
        child.stderr.on("data", () => { /* progress noise */ });
        const timer = setTimeout(() => child.kill("SIGTERM"), 900_000);
        child.on("close", (code) => {
          clearTimeout(timer);
          resolve({ code: code ?? 1, transcript: stdout, ...readTranscript(stdout) });
        });
      });
    },
  };
}
