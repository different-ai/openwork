import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { SkillItem } from "./types.js";
import { exists } from "./utils.js";
import { validateDescription, validateSkillName } from "./validators.js";

const PROTECTED_SKILLS_MANIFEST = join(".openwork", "protected-skills", "manifest.json");

type ProtectedSkillManifest = {
  schemaVersion?: number;
  skills?: ProtectedSkillEntry[];
};

type ProtectedSkillEntry = {
  name?: string;
  description?: string;
  trigger?: string;
  bundlePath?: string;
  version?: string;
  publishedAt?: string;
  checksum?: string;
};

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

async function readProtectedManifest(root: string): Promise<ProtectedSkillManifest | null> {
  const manifestPath = join(root, PROTECTED_SKILLS_MANIFEST);
  if (!(await exists(manifestPath))) return null;
  const raw = await readFile(manifestPath, "utf8");
  const parsed = JSON.parse(raw) as ProtectedSkillManifest;
  if (!parsed || typeof parsed !== "object") return null;
  return parsed;
}

function toSkillItem(root: string, entry: ProtectedSkillEntry): SkillItem | null {
  const name = typeof entry.name === "string" ? entry.name.trim() : "";
  const description = typeof entry.description === "string" ? entry.description : "";
  const trigger = typeof entry.trigger === "string" ? entry.trigger.trim() : "";
  const bundlePath = typeof entry.bundlePath === "string" ? entry.bundlePath.trim() : "";
  if (!name || !bundlePath) return null;

  try {
    validateSkillName(name);
    validateDescription(description);
  } catch {
    return null;
  }

  return {
    name,
    description,
    path: resolve(root, bundlePath),
    scope: "project",
    trigger: trigger || undefined,
    protected: true,
    version: typeof entry.version === "string" && entry.version.trim() ? entry.version.trim() : undefined,
    publishedAt:
      typeof entry.publishedAt === "string" && entry.publishedAt.trim() ? entry.publishedAt.trim() : undefined,
    checksum: typeof entry.checksum === "string" && entry.checksum.trim() ? entry.checksum.trim() : undefined,
  };
}

export async function listProtectedSkills(workspaceRoot: string): Promise<SkillItem[]> {
  const roots = await findWorkspaceRoots(workspaceRoot);
  const items: SkillItem[] = [];
  const seen = new Set<string>();

  for (const root of roots) {
    const manifest = await readProtectedManifest(root);
    if (!manifest?.skills?.length) continue;

    for (const entry of manifest.skills) {
      const item = toSkillItem(root, entry);
      if (!item || seen.has(item.name)) continue;
      seen.add(item.name);
      items.push(item);
    }
  }

  return items;
}
