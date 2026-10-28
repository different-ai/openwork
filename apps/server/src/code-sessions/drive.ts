import { homedir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

import { CodeSessionsError } from "./types.js";

/**
 * Driven mode for the Code tab: run a coding agent headlessly against one of
 * its own stored sessions and let the mirror show the turn as it happens.
 *
 * The agent writes its transcript where it always does, so driving needs no
 * extra plumbing: spawn the CLI, feed the prompt through stdin (never through
 * argv, so a prompt cannot turn into a shell command), and the mirror's next
 * poll picks the new messages up. One run per session at a time.
 *
 * v1 drives Claude Code only (`claude -p --output-format stream-json
 * --verbose --resume <id>`); the registry and routes are client-agnostic so
 * Codex (app-server) and OpenCode (native API) join through the same seams.
 */

export type DriveStatus = "running" | "completed" | "failed" | "aborted";

export type DriveRun = {
  id: string;
  client: string;
  sessionId: string;
  status: DriveStatus;
  startedAt: number;
  endedAt: number | null;
  /** Exit code when the process ended on its own. */
  exitCode: number | null;
  /** Last stderr lines when a run fails; never the transcript itself. */
  error: string | null;
};

type InternalRun = DriveRun & { child: ChildProcess | null; stderrTail: string[] };

const MAX_RUNS_KEPT = 50;
const MAX_STDERR_TAIL = 12;

/**
 * Engine-pinned variables from the server environment (the dev world points
 * OPENCODE_DB at the isolated mirror database; production configs may pin
 * more). A driven agent must write where the mirror reads — the user's real
 * store — so these are stripped from the child environment.
 */
const STRIPPED_CHILD_ENV = ["OPENCODE_DB", "OPENCODE_CONFIG_DIR"] as const;

function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of STRIPPED_CHILD_ENV) delete env[key];
  return env;
}

export type DriveSpawnSpec = { file: string; args: string[] };

export type StartDriveInput = {
  client: string;
  sessionId: string;
  /** The project directory the agent runs in; the session's own. */
  cwd: string;
  prompt: string;
  uuid?: string;
  /**
   * Environment corrections for the child: the OpenWork server may run with
   * isolated-home or engine-pinned variables (HOME, USERPROFILE, XDG_*,
   * OPENCODE_DB) that would point the agent at a different data directory
   * than the one the mirror read the session from. The route supplies the
   * user-real values per client.
   */
  envOverrides?: Record<string, string>;
};

export type DriveRegistry = {
  start(input: StartDriveInput, spawnSpec?: DriveSpawnSpec): DriveRun;
  list(): DriveRun[];
  get(runId: string): DriveRun | undefined;
  abort(runId: string): DriveRun;
  isRunning(client: string, sessionId: string): boolean;
};

/** Claude Code: one headless turn appended to the resumed session. */
export function claudeRunSpec(input: StartDriveInput): DriveSpawnSpec {
  const resume = input.uuid ? ["--resume", input.uuid] : [];
  return {
    file: "cmd.exe",
    args: ["/d", "/s", "/c", "claude", "-p", "--output-format", "stream-json", "--verbose", ...resume],
  };
}

/** OpenCode: one headless turn continued on the given session (prompt via stdin). */
export function opencodeRunSpec(input: StartDriveInput): DriveSpawnSpec {
  return {
    file: "cmd.exe",
    args: ["/d", "/s", "/c", "opencode", "run", "--session", input.sessionId],
  };
}

export function createDriveRegistry(options: {
  /** Spawn spec builder; injectable for tests. Defaults to the Claude CLI. */
  spawnSpec?: (input: StartDriveInput) => DriveSpawnSpec;
  /** The CLI command is resolved on PATH at spawn time via cmd /c. */
  command?: string;
} = {}): DriveRegistry {
  const runs = new Map<string, InternalRun>();
  const order: string[] = [];

  const defaultSpec = (input: StartDriveInput): DriveSpawnSpec => {
    const base = options.spawnSpec?.(input) ?? claudeRunSpec(input);
    if (options.command) {
      return { file: base.file, args: [...base.args.slice(0, base.args.indexOf(input.client === "opencode" ? "opencode" : "claude")), options.command, ...base.args.slice(base.args.indexOf(input.client === "opencode" ? "opencode" : "claude") + 1)] };
    }
    return base;
  };

  return {
    start(input: StartDriveInput, spawnSpec?: DriveSpawnSpec): DriveRun {
      const running = order.some((id) => {
        const run = runs.get(id);
        return run?.status === "running" && run.client === input.client && run.sessionId === input.sessionId;
      });
      if (running) {
        throw new CodeSessionsError("code_session_drive_running", "This session is already running a prompt.");
      }

      const spec = spawnSpec ?? defaultSpec(input);
      const id = `drive_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      // The server env pins OpenCode's storage to the world's isolated engine
      // database (OPENCODE_DB / OPENCODE_CONFIG_DIR). The mirror and the user's
      // own sessions live in the global store, so the driven child must read
      // and write THERE: drop the isolation pins from its environment.
      const childEnv: NodeJS.ProcessEnv = { ...process.env };
      delete childEnv.OPENCODE_DB;
      delete childEnv.OPENCODE_CONFIG_DIR;
      const child = spawn(spec.file, spec.args, {
        cwd: input.cwd,
        env: childEnv,
        stdio: ["pipe", "ignore", "pipe"],
        windowsHide: true,
      });

      const run: InternalRun = {
        id,
        client: input.client,
        sessionId: input.sessionId,
        status: "running",
        startedAt: Date.now(),
        endedAt: null,
        exitCode: null,
        error: null,
        child,
        stderrTail: [],
      };
      runs.set(id, run);
      order.push(id);
      if (order.length > MAX_RUNS_KEPT) {
        const dropped = order.shift();
        if (dropped) runs.delete(dropped);
      }

      child.stderr?.on("data", (chunk: Buffer) => {
        run.stderrTail.push(chunk.toString("utf8"));
        if (run.stderrTail.length > MAX_STDERR_TAIL) run.stderrTail.splice(0, run.stderrTail.length - MAX_STDERR_TAIL);
      });
      child.stdin?.end(input.prompt);
      child.on("error", (error) => {
        if (run.status !== "running") return;
        run.status = "failed";
        run.endedAt = Date.now();
        run.error = error.message;
        run.child = null;
      });
      child.on("exit", (code, signal) => {
        if (run.status !== "running") return;
        run.endedAt = Date.now();
        run.exitCode = code;
        run.child = null;
        if (signal) {
          run.status = "aborted";
          return;
        }
        if (code === 0) {
          run.status = "completed";
          return;
        }
        run.status = "failed";
        run.error = run.stderrTail.join("").trim().slice(-2_000) || `The agent exited with code ${code}.`;
      });

      return publicView(run);
    },

    list(): DriveRun[] {
      return order.map((id) => publicView(runs.get(id)!));
    },

    get(runId: string): DriveRun | undefined {
      const run = runs.get(runId);
      return run ? publicView(run) : undefined;
    },

    abort(runId: string): DriveRun {
      const run = runs.get(runId);
      if (!run) throw new CodeSessionsError("code_session_drive_unknown", "This run is not registered anymore.");
      if (run.status === "running") {
        run.child?.kill();
        run.status = "aborted";
        run.endedAt = Date.now();
        run.child = null;
      }
      return publicView(run);
    },

    isRunning(client: string, sessionId: string): boolean {
      return order.some((id) => {
        const run = runs.get(id);
        return run?.status === "running" && run.client === client && run.sessionId === sessionId;
      });
    },
  };
}

function publicView(run: InternalRun): DriveRun {
  return {
    id: run.id,
    client: run.client,
    sessionId: run.sessionId,
    status: run.status,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    exitCode: run.exitCode,
    error: run.error,
  };
}
