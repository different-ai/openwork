import { readdir, readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type { CommandItem } from "./types.js";
import { parseFrontmatter, buildFrontmatter } from "./frontmatter.js";
import { exists } from "./utils.js";
import { projectCommandsDir } from "./workspace-files.js";
import { validateCommandName, sanitizeCommandName } from "./validators.js";
import { ApiError } from "./errors.js";

async function listCommandsInDir(dir: string, scope: "workspace" | "global"): Promise<CommandItem[]> {
  if (!(await exists(dir))) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  const items: CommandItem[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".md")) continue;
    const filePath = join(dir, entry.name);
    const content = await readFile(filePath, "utf8");
    const { data, body } = parseFrontmatter(content);
    const name = typeof data.name === "string" ? data.name : entry.name.replace(/\.md$/, "");
    try {
      validateCommandName(name);
    } catch {
      continue;
    }
    items.push({
      name,
      description: typeof data.description === "string" ? data.description : undefined,
      template: body.trim(),
      agent: typeof data.agent === "string" ? data.agent : undefined,
      model: typeof data.model === "string" ? data.model : null,
      subtask: typeof data.subtask === "boolean" ? data.subtask : undefined,
      scope,
    });
  }
  return items;
}

export async function listCommands(workspaceRoot: string, scope: "workspace" | "global"): Promise<CommandItem[]> {
  if (scope === "global") {
    const dir = join(homedir(), ".config", "opencode", "commands");
    return listCommandsInDir(dir, "global");
  }
  return listCommandsInDir(projectCommandsDir(workspaceRoot), "workspace");
}

export async function upsertCommand(
  workspaceRoot: string,
  payload: { name: string; description?: string; template: string; agent?: string; model?: string | null; subtask?: boolean },
): Promise<string> {
  if (!payload.template || payload.template.trim().length === 0) {
    throw new ApiError(400, "invalid_command_template", "Command template is required");
  }
  const sanitized = sanitizeCommandName(payload.name);
  validateCommandName(sanitized);
  const frontmatter = buildFrontmatter({
    name: sanitized,
    description: payload.description,
    agent: payload.agent,
    model: payload.model ?? null,
    subtask: payload.subtask ?? false,
  });
  const content = frontmatter + "\n" + payload.template.trim() + "\n";
  const dir = projectCommandsDir(workspaceRoot);
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${sanitized}.md`);
  await writeFile(path, content, "utf8");
  return path;
}

export async function deleteCommand(workspaceRoot: string, name: string): Promise<void> {
  const sanitized = sanitizeCommandName(name);
  validateCommandName(sanitized);
  const path = join(projectCommandsDir(workspaceRoot), `${sanitized}.md`);
  await rm(path, { force: true });
}
