import { readdir, readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type { RoutineItem } from "./types.js";
import { parseFrontmatter, buildFrontmatter } from "./frontmatter.js";
import { exists } from "./utils.js";
import { projectRoutinesDir } from "./workspace-files.js";
import { validateRoutineName, sanitizeRoutineName } from "./validators.js";
import { ApiError } from "./errors.js";
import { CronExpressionParser } from "cron-parser";

function normalizeRoutineFrontmatter(data: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(data).filter(([, value]) => value !== null && value !== undefined),
  );
}

async function listRoutinesInDir(dir: string, scope: "workspace" | "global"): Promise<RoutineItem[]> {
  if (!(await exists(dir))) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  const items: RoutineItem[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".md")) continue;
    const filePath = join(dir, entry.name);
    try {
      const content = await readFile(filePath, "utf8");
      const { data, body } = parseFrontmatter(content);
      
      const name = typeof data.name === "string" ? data.name : entry.name.replace(/\.md$/, "");
      try {
        validateRoutineName(name);
      } catch {
        continue;
      }

      const schedule = typeof data.schedule === "string" ? data.schedule : "";
      try {
        // Validate cron expression
        if (schedule) {
          CronExpressionParser.parse(schedule);
        }
      } catch {
        // Skip invalid crons
        continue;
      }

      items.push({
        name,
        description: typeof data.description === "string" ? data.description : undefined,
        schedule,
        enabled: typeof data.enabled === "boolean" ? data.enabled : true,
        command: body.trim(),
        scope,
      });
    } catch (err) {
      console.warn(`Failed to read/parse routine file ${filePath}`, err);
    }
  }
  return items;
}

export async function listRoutines(workspaceRoot: string, scope: "workspace" | "global"): Promise<RoutineItem[]> {
  if (scope === "global") {
    const dir = join(homedir(), ".config", "opencode", "routines");
    return listRoutinesInDir(dir, "global");
  }
  return listRoutinesInDir(projectRoutinesDir(workspaceRoot), "workspace");
}

export type UpsertRoutinePayload = {
  name: string;
  description?: string;
  schedule: string;
  command: string;
  enabled: boolean;
};

export function buildRoutineContent(payload: UpsertRoutinePayload): { name: string; content: string } {
  if (!payload.command || payload.command.trim().length === 0) {
    throw new ApiError(400, "invalid_routine_command", "Routine command is required");
  }
  if (!payload.schedule || payload.schedule.trim().length === 0) {
    throw new ApiError(400, "invalid_routine_schedule", "Routine schedule is required");
  }
  try {
    CronExpressionParser.parse(payload.schedule);
  } catch (err) {
    throw new ApiError(400, "invalid_routine_schedule", "Invalid cron expression");
  }

  const sanitized = sanitizeRoutineName(payload.name);
  validateRoutineName(sanitized);

  const frontmatter = buildFrontmatter(normalizeRoutineFrontmatter({
    name: sanitized,
    description: payload.description,
    schedule: payload.schedule,
    enabled: payload.enabled,
  }));
  const content = frontmatter + "\n" + payload.command.trim() + "\n";
  return { name: sanitized, content };
}

export async function upsertRoutine(
  workspaceRoot: string,
  payload: UpsertRoutinePayload,
): Promise<string> {
  const routine = buildRoutineContent(payload);
  const dir = projectRoutinesDir(workspaceRoot);
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${routine.name}.md`);
  await writeFile(path, routine.content, "utf8");
  return path;
}

export async function deleteRoutine(workspaceRoot: string, name: string): Promise<void> {
  const sanitized = sanitizeRoutineName(name);
  validateRoutineName(sanitized);
  const path = join(projectRoutinesDir(workspaceRoot), `${sanitized}.md`);
  await rm(path, { force: true });
}
