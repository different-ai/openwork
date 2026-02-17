import { appendFile, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import SchedulerPlugin from "opencode-scheduler";

import { deleteCommand, upsertCommand } from "./commands.js";
import { ApiError } from "./errors.js";
import type { ScheduledJob } from "./scheduler.js";
import { deleteScheduledJob, listScheduledJobs, resolveScheduledJob } from "./scheduler.js";
import { exists } from "./utils.js";

type SchedulerToolResult<T = unknown> = {
  success: boolean;
  output: string;
  shouldContinue?: boolean;
  data?: T;
};

const SOUL_FILE_TEMPLATE = `# Soul

Persistent memory for this workspace.

Last heartbeat: never

## Identity
-

## Preferences
-

## Long-term Context
-

## Current Focus
-

## Loose Ends
-
`;

const SOUL_STATE_TEMPLATE = {
  schemaVersion: 1,
  lastHeartbeatAt: null,
  recentSessionIds: [] as string[],
  recentLooseEnds: [] as string[],
  nextAction: null as string | null,
};

const HEARTBEAT_COMMAND_TEMPLATE = `Run a Soul heartbeat for this workspace.

Non-negotiable behavior:
- Non-interactive and safe. No destructive actions.
- Keep output concise and session-aware.

Steps:
1) Read .opencode/soul.md.
2) Read .opencode/soul/state.json if present.
3) Determine current workspace path with pwd.
4) Attempt to inspect recent OpenCode sessions and unfinished todos from sqlite:
   - Probe common DB paths:
     - $XDG_DATA_HOME/opencode/opencode.db
     - $HOME/.local/share/opencode/opencode.db
     - $HOME/Library/Application Support/opencode/opencode.db
     - $HOME/.opencode/opencode.db
   - Query recent sessions for this workspace.
   - Query unfinished todos joined to recent sessions for this workspace.
   - If DB lookup fails, continue using available context.
5) Produce a compact check-in:
   - One-sentence summary.
   - 1-3 loose ends.
   - One recommended next action.
   - 2-3 curiosity paths.
6) Append exactly one JSON line to .opencode/soul/heartbeat.jsonl with keys:
   - ts, workspace, summary, loose_ends, next_action, session_ids, unfinished_count.
7) Update .opencode/soul/state.json with durable state:
   - lastHeartbeatAt, recentSessionIds, recentLooseEnds, nextAction.
8) Optionally do one tiny, reversible housekeeping follow-up only if confidence is high.
`;

const TAKE_SOUL_BACK_TEMPLATE = `Take my soul back.

Disable Soul Mode in this workspace right now.

Execution rules:
- Use scheduler tool \`delete_job\` for removing \`soul-heartbeat\`.
- Use file tools for file deletion/editing. Do not use shell redirection.

Steps:
1) Delete scheduled job \`soul-heartbeat\` using \`delete_job\` (ignore if it does not exist).
2) Delete \`.opencode/soul.md\`.
3) Delete \`.opencode/soul/state.json\`.
4) Delete \`.opencode/soul/heartbeat.jsonl\`.
5) Delete \`.opencode/commands/soul-heartbeat.md\`.
6) If \`.opencode/soul/\` is empty afterward, remove that folder.

Reply with exactly two bullets:
- \`Soul Mode disabled.\`
- \`Re-enable with /give-me-a-soul\`.
`;

let schedulerToolsPromise: Promise<Record<string, { execute: (args: Record<string, unknown>) => unknown | Promise<unknown> }>> | null = null;

async function getSchedulerTools() {
  if (!schedulerToolsPromise) {
    schedulerToolsPromise = (async () => {
      const loadSchedulerPlugin = SchedulerPlugin as unknown as () => Promise<{
        tool?: Record<string, { execute: (args: Record<string, unknown>) => unknown | Promise<unknown> }>;
      }>;
      const plugin = await loadSchedulerPlugin();
      const tools = (plugin as { tool?: Record<string, { execute: (args: Record<string, unknown>) => unknown | Promise<unknown> }> }).tool;
      if (!tools) {
        throw new ApiError(500, "scheduler_tools_missing", "Scheduler plugin did not expose tools");
      }
      return tools;
    })();
  }
  return schedulerToolsPromise;
}

async function runSchedulerTool<T>(name: string, args: Record<string, unknown>): Promise<SchedulerToolResult<T>> {
  const tools = await getSchedulerTools();
  const tool = tools[name];
  if (!tool || typeof tool.execute !== "function") {
    throw new ApiError(500, "scheduler_tool_missing", `Scheduler tool "${name}" is unavailable`);
  }
  const raw = await tool.execute({ ...args, format: "json" });
  const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (!parsed || typeof parsed !== "object") {
    throw new ApiError(500, "scheduler_tool_invalid", `Scheduler tool "${name}" returned invalid output`);
  }
  const result = parsed as SchedulerToolResult<T>;
  if (!result.success) {
    throw new ApiError(500, "scheduler_tool_failed", result.output || `Scheduler tool "${name}" failed`);
  }
  return result;
}

function isJobAlreadyExistsError(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  return error.code === "scheduler_tool_failed" && /already exists/i.test(error.message);
}

async function scheduleHeartbeatJob(workspacePath: string): Promise<string> {
  try {
    const scheduled = await runSchedulerTool("schedule_job", {
      name: "soul-heartbeat",
      schedule: "0 */12 * * *",
      command: "soul-heartbeat",
      title: "Soul heartbeat",
      workdir: workspacePath,
      timeoutSeconds: 180,
    });
    return scheduled.output;
  } catch (error) {
    if (!isJobAlreadyExistsError(error)) throw error;
    const updated = await runSchedulerTool("update_job", {
      name: "soul-heartbeat",
      schedule: "0 */12 * * *",
      command: "soul-heartbeat",
      title: "Soul heartbeat",
      workdir: workspacePath,
      timeoutSeconds: 180,
    });
    return updated.output;
  }
}

export type SoulModeEnableResult = {
  soulFile: string;
  stateFile: string;
  heartbeatLog: string;
  heartbeatCommandPath: string;
  revertCommandPath: string;
  job: ScheduledJob | null;
  scheduleOutput: string;
  runOutput: string;
};

async function appendInitialHeartbeat(logPath: string, workspacePath: string) {
  const now = new Date().toISOString();
  const entry = {
    ts: now,
    workspace: workspacePath,
    summary: "Soul Mode enabled and heartbeat automation initialized.",
    loose_ends: ["Confirm Soul memory fields", "Run first session-aware follow-up"],
    next_action: "Review the latest heartbeat and pick one loose end to close.",
    source: "openwork-server.bootstrap",
  };
  await appendFile(logPath, `${JSON.stringify(entry)}\n`, "utf8");
}

export async function enableSoulMode(workspacePath: string): Promise<SoulModeEnableResult> {
  const soulFile = join(workspacePath, ".opencode", "soul.md");
  const soulDir = join(workspacePath, ".opencode", "soul");
  const stateFile = join(soulDir, "state.json");
  const heartbeatLog = join(soulDir, "heartbeat.jsonl");
  const heartbeatCommandPath = join(workspacePath, ".opencode", "commands", "soul-heartbeat.md");
  const revertCommandPath = join(workspacePath, ".opencode", "commands", "take-my-soul-back.md");

  await mkdir(soulDir, { recursive: true });
  if (!(await exists(soulFile))) {
    await writeFile(soulFile, SOUL_FILE_TEMPLATE, "utf8");
  }
  if (!(await exists(stateFile))) {
    await writeFile(stateFile, `${JSON.stringify(SOUL_STATE_TEMPLATE, null, 2)}\n`, "utf8");
  }
  if (!(await exists(heartbeatLog))) {
    await writeFile(heartbeatLog, "", "utf8");
  }

  await upsertCommand(workspacePath, {
    name: "soul-heartbeat",
    description: "Soul heartbeat (session-aware loose-end follow-up)",
    template: HEARTBEAT_COMMAND_TEMPLATE,
  });

  await upsertCommand(workspacePath, {
    name: "take-my-soul-back",
    description: "Disable Soul Mode and remove soul files + scheduler job",
    template: TAKE_SOUL_BACK_TEMPLATE,
  });

  const scheduleOutput = await scheduleHeartbeatJob(workspacePath);

  const jobs = await listScheduledJobs(workspacePath);
  const job = jobs.find((entry) => entry.name === "soul-heartbeat" || entry.slug === "soul-heartbeat") ?? null;
  if (!job) {
    throw new ApiError(500, "scheduler_job_missing", "Soul scheduler job was not found after scheduling");
  }

  await appendInitialHeartbeat(heartbeatLog, workspacePath);
  const runResult = await runSchedulerTool("run_job", { name: "soul-heartbeat" });

  return {
    soulFile,
    stateFile,
    heartbeatLog,
    heartbeatCommandPath,
    revertCommandPath,
    job,
    scheduleOutput,
    runOutput: runResult.output,
  };
}

export type SoulModeDisableResult = {
  jobDeleted: boolean;
  removedSoulFile: boolean;
  removedStateFile: boolean;
  removedHeartbeatLog: boolean;
  removedSoulDir: boolean;
  removedHeartbeatCommand: boolean;
  removedRevertCommand: boolean;
};

export async function disableSoulMode(workspacePath: string): Promise<SoulModeDisableResult> {
  const soulFile = join(workspacePath, ".opencode", "soul.md");
  const soulDir = join(workspacePath, ".opencode", "soul");
  const stateFile = join(soulDir, "state.json");
  const heartbeatLog = join(soulDir, "heartbeat.jsonl");
  const heartbeatCommandPath = join(workspacePath, ".opencode", "commands", "soul-heartbeat.md");
  const revertCommandPath = join(workspacePath, ".opencode", "commands", "take-my-soul-back.md");

  let jobDeleted = false;
  try {
    const { job, jobFile } = await resolveScheduledJob("soul-heartbeat", workspacePath);
    await deleteScheduledJob(job, jobFile);
    jobDeleted = true;
  } catch (error) {
    if (!(error instanceof ApiError) || error.code !== "job_not_found") {
      throw error;
    }
  }

  const removedSoulFile = await exists(soulFile);
  const removedStateFile = await exists(stateFile);
  const removedHeartbeatLog = await exists(heartbeatLog);
  const removedHeartbeatCommand = await exists(heartbeatCommandPath);
  const removedRevertCommand = await exists(revertCommandPath);

  await rm(soulFile, { force: true });
  await rm(stateFile, { force: true });
  await rm(heartbeatLog, { force: true });
  await deleteCommand(workspacePath, "soul-heartbeat");
  await deleteCommand(workspacePath, "take-my-soul-back");

  let removedSoulDir = false;
  try {
    await rm(soulDir);
    removedSoulDir = true;
  } catch {
    removedSoulDir = false;
  }

  return {
    jobDeleted,
    removedSoulFile,
    removedStateFile,
    removedHeartbeatLog,
    removedSoulDir,
    removedHeartbeatCommand,
    removedRevertCommand,
  };
}
