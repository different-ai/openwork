import assert from "node:assert/strict";
import { test } from "node:test";
import { createClaudeCodeLogin, findClaudeExecutable } from "../src/claude-code-login.js";
import { ApiError } from "../src/errors.js";

function fakeProcess() {
  const listeners: Array<(code: number | null) => void> = [];
  const handle = {
    killed: false,
    exit(code: number | null) { for (const listener of listeners) listener(code); },
    process: {
      kill() { handle.killed = true; },
      onExit(listener: (code: number | null) => void) { listeners.push(listener); },
    },
  };
  return handle;
}

function login(options: { timeoutMs?: number } = {}) {
  const started: Array<{ file: string; args: string[]; env: NodeJS.ProcessEnv; handle: ReturnType<typeof fakeProcess> }> = [];
  const instance = createClaudeCodeLogin({
    env: { PATH: "/opt/tools:/usr/bin", HOME: "/home/person" },
    platform: "linux",
    timeoutMs: options.timeoutMs,
    isFile: (path) => path === "/usr/bin/claude",
    start: (file, args, env) => {
      const handle = fakeProcess();
      started.push({ file, args, env, handle });
      return handle.process;
    },
  });
  return { instance, started };
}

test("the engine's claude is found: the configured path first, then PATH", () => {
  assert.equal(findClaudeExecutable({ OPENCODE_CLAUDE_PATH: "/custom/claude", PATH: "/usr/bin" }, "linux", () => true), "/custom/claude");
  assert.equal(findClaudeExecutable({ PATH: "/opt/tools:/usr/bin" }, "linux", (path) => path === "/usr/bin/claude"), "/usr/bin/claude");
  assert.equal(findClaudeExecutable({ PATH: "/opt/tools" }, "linux", () => false), undefined);
  assert.equal(
    findClaudeExecutable({ Path: "C:\\Tools;C:\\Users\\p\\.local\\bin", PATHEXT: ".EXE;.CMD" }, "win32", (path) => path.endsWith("claude.EXE") && path.includes(".local")),
    "C:\\Users\\p\\.local\\bin\\claude.EXE",
  );
});

test("a Claude Code that is already signed in is done without opening the browser", () => {
  const { instance, started } = login();
  assert.deepEqual(instance.state(), { status: "idle" });
  assert.deepEqual(instance.start(), { status: "waiting" });
  assert.equal(started[0]?.file, "/usr/bin/claude");
  assert.deepEqual(started[0]?.args, ["auth", "status"]);
  started[0]?.handle.exit(0);
  assert.deepEqual(instance.state(), { status: "signed_in" });
  assert.equal(started.length, 1);
});

test("a signed-out Claude Code gets its own browser sign-in, and finishing it is reported", () => {
  const { instance, started } = login();
  instance.start();
  started[0]?.handle.exit(1);
  assert.deepEqual(instance.state(), { status: "waiting" });
  assert.deepEqual(started[1]?.args, ["auth", "login", "--claudeai"]);
  // A second press while the browser is open answers for the same sign-in.
  assert.deepEqual(instance.start({ force: true }), { status: "waiting" });
  assert.equal(started.length, 2);
  started[1]?.handle.exit(0);
  assert.deepEqual(instance.state(), { status: "signed_in" });
});

test("signing in again skips the check and always opens the browser sign-in", () => {
  const { instance, started } = login();
  instance.start({ force: true });
  assert.equal(started.length, 1);
  assert.deepEqual(started[0]?.args, ["auth", "login", "--claudeai"]);
});

test("a sign-in that Claude Code ends without success says to sign in again", () => {
  const { instance, started } = login();
  instance.start({ force: true });
  started[0]?.handle.exit(1);
  const state = instance.state();
  assert.equal(state.status, "failed");
  assert.match(state.status === "failed" ? state.message : "", /Sign in again/);
  // The next press starts over.
  assert.deepEqual(instance.start({ force: true }), { status: "waiting" });
  assert.equal(started.length, 2);
});

test("cancel stops the login and a late exit does not change the answer", () => {
  const { instance, started } = login();
  instance.start({ force: true });
  assert.deepEqual(instance.cancel(), { status: "idle" });
  assert.equal(started[0]?.handle.killed, true);
  started[0]?.handle.exit(null);
  assert.deepEqual(instance.state(), { status: "idle" });
});

test("a sign-in nobody finishes is stopped", async () => {
  const { instance, started } = login({ timeoutMs: 5 });
  instance.start({ force: true });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(started[0]?.handle.killed, true);
  assert.equal(instance.state().status, "failed");
});

test("a computer without Claude Code is told to install it", () => {
  const instance = createClaudeCodeLogin({ env: { PATH: "/usr/bin" }, platform: "linux", isFile: () => false, start: () => { throw new Error("must not start"); } });
  assert.throws(() => instance.start(), (error) => error instanceof ApiError && error.code === "claude_code_not_installed");
  assert.deepEqual(instance.state(), { status: "idle" });
});

test("installed is asked fresh each time, so a Claude Code installed later is found without a restart", () => {
  let present = false;
  const instance = createClaudeCodeLogin({ env: { PATH: "/home/person/.local/bin" }, platform: "linux", isFile: (path) => present && path === "/home/person/.local/bin/claude" });
  assert.equal(instance.installed(), false);
  present = true;
  assert.equal(instance.installed(), true);
  // A configured path that points at nothing is not an install.
  assert.equal(createClaudeCodeLogin({ env: { OPENCODE_CLAUDE_PATH: "/gone/claude" }, platform: "linux", isFile: () => false }).installed(), false);
});
