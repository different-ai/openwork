import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { posix, win32 } from "node:path";
import { ApiError } from "./errors.js";

/**
 * Runs the person's own `claude auth login` so Claude Code opens its browser
 * sign-in on the computer this server runs on. OpenWork never reads the
 * command's output (it carries a one-time sign-in link) or Claude Code's
 * tokens; it only learns whether the command finished.
 */
export type ClaudeCodeLoginState =
  | { status: "idle" }
  | { status: "waiting" }
  | { status: "signed_in" }
  | { status: "failed"; message: string };

export const CLAUDE_CODE_LOGIN_TIMEOUT_MS = 10 * 60_000;
export const CLAUDE_CODE_STATUS_TIMEOUT_MS = 15_000;
const NOT_INSTALLED = "Claude Code is not installed. Install it, then sign in.";
const FAILED = "Claude Code could not finish signing in. Sign in again, or run claude auth login in a terminal.";
const TIMED_OUT = "The Claude Code sign-in was not finished in time. Sign in again.";

type LoginProcess = { kill(): void; onExit(listener: (code: number | null) => void): void };
export type ClaudeCodeLoginOptions = {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  timeoutMs?: number;
  statusTimeoutMs?: number;
  isFile?: (path: string) => boolean;
  start?: (file: string, args: string[], env: NodeJS.ProcessEnv) => LoginProcess;
};

const isFile = (path: string) => {
  try { return statSync(path).isFile(); } catch { return false; }
};

const readEnv = (env: NodeJS.ProcessEnv, name: string, platform: NodeJS.Platform) => {
  if (platform !== "win32") return env[name];
  const key = Object.keys(env).find((entry) => entry.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : env[key];
};

/** The `claude` the engine itself uses: OPENCODE_CLAUDE_PATH, else the first one on PATH. */
export function findClaudeExecutable(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  exists: (path: string) => boolean = isFile,
): string | undefined {
  const configured = readEnv(env, "OPENCODE_CLAUDE_PATH", platform)?.trim();
  if (configured) return configured;
  const paths = platform === "win32" ? win32 : posix;
  const extensions = platform === "win32"
    ? (readEnv(env, "PATHEXT", platform) ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
    : [""];
  for (const directory of (readEnv(env, "PATH", platform) ?? "").split(paths.delimiter)) {
    if (!directory) continue;
    for (const extension of extensions) {
      const candidate = paths.join(directory, `claude${extension}`);
      if (exists(candidate)) return candidate;
    }
  }
  return undefined;
}

function startLogin(file: string, args: string[], env: NodeJS.ProcessEnv): LoginProcess {
  // A .cmd shim (npm install on Windows) only runs through the command interpreter. The arguments are fixed.
  const shim = process.platform === "win32" && /\.(?:cmd|bat)$/i.test(file);
  const child = shim
    ? spawn(env.COMSPEC ?? "cmd.exe", ["/d", "/s", "/c", `""${file}" ${args.join(" ")}"`], { env, stdio: "ignore", windowsHide: true, windowsVerbatimArguments: true })
    : spawn(file, args, { env, stdio: "ignore", windowsHide: true });
  let done = false;
  const listeners: Array<(code: number | null) => void> = [];
  const finish = (code: number | null) => {
    if (done) return;
    done = true;
    for (const listener of listeners) listener(code);
  };
  child.once("error", () => finish(null));
  child.once("exit", (code) => finish(code));
  return { kill: () => { child.kill(); }, onExit: (listener) => { listeners.push(listener); } };
}

export function createClaudeCodeLogin(options: ClaudeCodeLoginOptions = {}) {
  let state: ClaudeCodeLoginState = { status: "idle" };
  let running: { process: LoginProcess; timer: ReturnType<typeof setTimeout> } | null = null;

  const stop = () => {
    const current = running;
    running = null;
    if (!current) return;
    clearTimeout(current.timer);
    current.process.kill();
  };

  return {
    state: (): ClaudeCodeLoginState => state,
    /** Whether the engine would find a `claude` to run right now. Asked again whenever the person comes back from installing it. */
    installed(): boolean {
      const file = findClaudeExecutable(options.env ?? process.env, options.platform, options.isFile);
      return file !== undefined && (options.isFile ?? isFile)(file);
    },
    /**
     * Starts the sign-in, or answers for the one already under way. A Claude
     * Code that is already signed in is done without opening the browser,
     * unless `force` asks for a fresh sign-in (its login stopped working).
     */
    start(input: { force?: boolean } = {}): ClaudeCodeLoginState {
      if (running) return state;
      const env = options.env ?? process.env;
      const file = findClaudeExecutable(env, options.platform, options.isFile);
      if (!file) throw new ApiError(409, "claude_code_not_installed", NOT_INSTALLED);
      const launch = options.start ?? startLogin;
      const run = (args: string[], timeoutMs: number, done: (code: number | null, timedOut: boolean) => void) => {
        const child = launch(file, args, env);
        const timer = setTimeout(() => {
          if (running?.process !== child) return;
          stop();
          done(null, true);
        }, timeoutMs);
        timer.unref?.();
        running = { process: child, timer };
        child.onExit((code) => {
          if (running?.process !== child) return;
          clearTimeout(timer);
          running = null;
          done(code, false);
        });
      };
      const signIn = () => run(["auth", "login", "--claudeai"], options.timeoutMs ?? CLAUDE_CODE_LOGIN_TIMEOUT_MS, (code, timedOut) => {
        state = code === 0 ? { status: "signed_in" } : { status: "failed", message: timedOut ? TIMED_OUT : FAILED };
      });
      state = { status: "waiting" };
      // `claude auth status` exits 0 only when Claude Code is signed in; its output (account details) is never read.
      if (input.force) signIn();
      else run(["auth", "status"], options.statusTimeoutMs ?? CLAUDE_CODE_STATUS_TIMEOUT_MS, (code) => {
        if (code === 0) state = { status: "signed_in" };
        else signIn();
      });
      return state;
    },
    /** Stops a sign-in the person gave up on. Claude Code's existing login is untouched. */
    cancel(): ClaudeCodeLoginState {
      stop();
      state = { status: "idle" };
      return state;
    },
  };
}

export type ClaudeCodeLogin = ReturnType<typeof createClaudeCodeLogin>;
