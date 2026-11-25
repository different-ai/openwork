import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { expect, test } from "vitest";
import { writeClaudeAgentExecutable } from "../worlds/claude-agent-executable.ts";

test.each<{ tokenSource: "none" | "oauth" }>([{ tokenSource: "none" }, { tokenSource: "oauth" }])("synthetic Claude initializes with $tokenSource and refuses inference", async ({ tokenSource }) => {
  const directory = await mkdtemp(join(tmpdir(), "claude-agent-protocol-"));
  const executable = join(directory, "claude.mjs");
  const audit = join(directory, "audit.jsonl");
  // Keep cleanup unconditional even if an expectation or malformed protocol fails.
  let fixture: ReturnType<typeof spawn> | undefined;
  try {
    await writeClaudeAgentExecutable(executable, audit, tokenSource);
    const running = spawn(executable, ["--input-format", "stream-json", "--output-format", "stream-json"], { stdio: ["pipe", "pipe", "pipe"], timeout: 10_000 });
    fixture = running;
    const exit = new Promise<number | null>((resolve, reject) => { running.once("error", reject); running.once("exit", resolve); });
    const lines = createInterface({ input: running.stdout });
    running.stdin.write(JSON.stringify({ type: "control_request", request_id: "fixture-init", request: { subtype: "initialize" } }) + "\n");
    const iterator = lines[Symbol.asyncIterator]();
    const line = await iterator.next();
    expect(JSON.parse(line.value ?? "null")).toMatchObject({ type: "control_response", response: {
      subtype: "success", request_id: "fixture-init", response: { claude_code_version: "2.1.248", account: { tokenSource }, models: [{ value: "claude-sonnet-4-6" }] },
    } });
    running.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: "Never send this to a model" } }) + "\n");
    expect(await exit).toBe(42);
    expect(await readFile(audit, "utf8")).toContain("forbidden-inference");
    lines.close();
  } finally {
    fixture?.kill();
    await rm(directory, { recursive: true, force: true });
  }
});

test.each(["login", "logout"])("synthetic Claude refuses %s without touching account state", async (command) => {
  const directory = await mkdtemp(join(tmpdir(), "claude-agent-auth-"));
  try {
    const executable = join(directory, "claude.mjs");
    const audit = join(directory, "audit.jsonl");
    await writeClaudeAgentExecutable(executable, audit, "oauth");
    const child = spawn(executable, ["auth", command], { stdio: "ignore", timeout: 10_000 });
    const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
    expect(code).toBe(41);
    expect(await readFile(audit, "utf8")).toContain("forbidden-auth");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
