import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import type { SkillItem } from "./types.js";
import { parseFrontmatter, buildFrontmatter } from "./frontmatter.js";
import { exists } from "./utils.js";
import { validateDescription, validateSkillName } from "./validators.js";
import { ApiError } from "./errors.js";
import { projectSkillsDir } from "./workspace-files.js";

async function findWorkspaceRoots(workspaceRoot: string): Promise<string[]> {
  const roots: string[] = [];
  let current = resolve(workspaceRoot);
  while (true) {
    roots.push(current);
    const gitPath = join(current, ".git");
    if (await exists(gitPath)) break;
    const parent = resolve(current, "..");
    if (parent === current) break;
    current = parent;
  }
  return roots;
}

async function listSkillsInDir(dir: string, scope: "project" | "global"): Promise<SkillItem[]> {
  if (!(await exists(dir))) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  const items: SkillItem[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillPath = join(dir, entry.name, "SKILL.md");
    if (!(await exists(skillPath))) continue;
    const content = await readFile(skillPath, "utf8");
    const { data } = parseFrontmatter(content);
    const name = typeof data.name === "string" ? data.name : entry.name;
    const description = typeof data.description === "string" ? data.description : "";
    try {
      validateSkillName(name);
      validateDescription(description);
    } catch {
      continue;
    }
    if (name !== entry.name) continue;
    items.push({
      name,
      description,
      path: skillPath,
      scope,
    });
  }
  return items;
}

export async function listSkills(workspaceRoot: string, includeGlobal: boolean): Promise<SkillItem[]> {
  const roots = await findWorkspaceRoots(workspaceRoot);
  const items: SkillItem[] = [];
  for (const root of roots) {
    const opencodeDir = join(root, ".opencode", "skills");
    const legacyDir = join(root, ".opencode", "skill");
    const claudeDir = join(root, ".claude", "skills");
    items.push(...(await listSkillsInDir(opencodeDir, "project")));
    items.push(...(await listSkillsInDir(legacyDir, "project")));
    items.push(...(await listSkillsInDir(claudeDir, "project")));
  }

  if (includeGlobal) {
    const globalOpenWork = join(homedir(), ".config", "opencode", "skills");
    const globalClaude = join(homedir(), ".claude", "skills");
    items.push(...(await listSkillsInDir(globalOpenWork, "global")));
    items.push(...(await listSkillsInDir(globalClaude, "global")));
  }

  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.name)) return false;
    seen.add(item.name);
    return true;
  });
}

export async function upsertSkill(
  workspaceRoot: string,
  payload: { name: string; content: string; description?: string },
): Promise<string> {
  const name = payload.name.trim();
  validateSkillName(name);
  if (!payload.content) {
    throw new ApiError(400, "invalid_skill_content", "Skill content is required");
  }

  let content = payload.content;
  const { data, body } = parseFrontmatter(payload.content);
  if (Object.keys(data).length > 0) {
    const frontmatterName = typeof data.name === "string" ? data.name : "";
    const frontmatterDescription = typeof data.description === "string" ? data.description : "";
    if (frontmatterName && frontmatterName !== name) {
      throw new ApiError(400, "invalid_skill_name", "Skill frontmatter name must match payload name");
    }
    validateDescription(frontmatterDescription || payload.description);
    const nextDescription = frontmatterDescription || payload.description || "";
    const frontmatter = buildFrontmatter({
      ...data,
      name,
      description: nextDescription,
    });
    content = frontmatter + body.replace(/^\n/, "");
  } else {
    validateDescription(payload.description);
    const frontmatter = buildFrontmatter({ name, description: payload.description });
    content = frontmatter + payload.content.replace(/^\n/, "");
  }

  const baseDir = projectSkillsDir(workspaceRoot);
  const skillDir = join(baseDir, name);
  await mkdir(skillDir, { recursive: true });
  const skillPath = join(skillDir, "SKILL.md");
  await writeFile(skillPath, content.endsWith("\n") ? content : content + "\n", "utf8");
  return skillPath;
}
