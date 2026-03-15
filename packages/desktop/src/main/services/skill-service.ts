import { ipcMain } from "electron";
import { existsSync, readdirSync, type Dirent } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ExecResult, LocalSkillCard, LocalSkillContent } from "../../../../app/src/app/lib/desktop-contract";
import { IPC_CHANNELS } from "../ipc/channels";

function homeDir() {
  return process.env.HOME?.trim() || process.env.USERPROFILE?.trim() || null;
}

function candidateXdgConfigDirs() {
  const home = homeDir();
  if (!home) {
    return [] as string[];
  }

  const candidates = [path.join(home, ".config")];
  if (process.platform === "darwin") {
    candidates.push(path.join(home, "Library", "Application Support"));
  }
  return candidates;
}

async function ensureProjectSkillRoot(projectDir: string) {
  const base = path.join(projectDir, ".opencode");
  const legacy = path.join(base, "skill");
  const modern = path.join(base, "skills");

  if (existsSync(legacy) && !existsSync(modern)) {
    await rename(legacy, modern);
  }

  await mkdir(modern, { recursive: true });
  return modern;
}

function collectProjectSkillRoots(projectDir: string) {
  const roots: string[] = [];
  let current = projectDir;

  while (current) {
    const opencodeRoot = path.join(current, ".opencode", "skills");
    if (existsSync(opencodeRoot)) {
      roots.push(opencodeRoot);
    } else {
      const legacyRoot = path.join(current, ".opencode", "skill");
      if (existsSync(legacyRoot)) {
        roots.push(legacyRoot);
      }
    }

    const claudeRoot = path.join(current, ".claude", "skills");
    if (existsSync(claudeRoot)) {
      roots.push(claudeRoot);
    }

    if (existsSync(path.join(current, ".git"))) {
      break;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  return roots;
}

function collectGlobalSkillRoots() {
  const roots: string[] = [];
  for (const dir of candidateXdgConfigDirs()) {
    const opencodeRoot = path.join(dir, "opencode", "skills");
    if (existsSync(opencodeRoot)) {
      roots.push(opencodeRoot);
    }
  }

  const home = homeDir();
  if (home) {
    for (const candidate of [
      path.join(home, ".claude", "skills"),
      path.join(home, ".agents", "skills"),
      path.join(home, ".agent", "skills"),
    ]) {
      if (existsSync(candidate)) {
        roots.push(candidate);
      }
    }
  }

  return roots;
}

function collectSkillRoots(projectDir: string) {
  const trimmed = projectDir.trim();
  if (!trimmed) {
    throw new Error("projectDir is required");
  }

  return [...new Set([...collectProjectSkillRoots(trimmed), ...collectGlobalSkillRoots()])];
}

function validateSkillName(name: string) {
  const trimmed = name.trim();
  if (!trimmed) {
    throw new Error("skill name is required");
  }

  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(trimmed)) {
    throw new Error("skill name must be kebab-case");
  }

  return trimmed;
}

async function gatherSkills(root: string, seen: Set<string>, out: string[]) {
  if (!existsSync(root)) {
    return;
  }

  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const skillDir = path.join(root, entry.name);
    if (existsSync(path.join(skillDir, "SKILL.md"))) {
      if (seen.add(entry.name)) {
        out.push(skillDir);
      }
      continue;
    }

    const subEntries = await readdir(skillDir, { withFileTypes: true }).catch(() => []);
    for (const subEntry of subEntries) {
      if (!subEntry.isDirectory()) {
        continue;
      }

      const subPath = path.join(skillDir, subEntry.name);
      if (!existsSync(path.join(subPath, "SKILL.md"))) {
        continue;
      }

      if (seen.add(subEntry.name)) {
        out.push(subPath);
      }
    }
  }
}

function extractFrontmatterValue(raw: string, keys: string[]) {
  const lines = raw.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") {
    return null;
  }

  for (const line of lines.slice(1)) {
    const trimmed = line.trim();
    if (trimmed === "---") {
      break;
    }
    if (!trimmed) {
      continue;
    }

    const separator = trimmed.indexOf(":");
    if (separator === -1) {
      continue;
    }

    const key = trimmed.slice(0, separator).trim();
    if (!keys.some((candidate) => candidate.toLowerCase() === key.toLowerCase())) {
      continue;
    }

    let value = trimmed.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1).trim();
    }

    return value || null;
  }

  return null;
}

function extractTrigger(raw: string) {
  const frontmatter = extractFrontmatterValue(raw, ["trigger", "when"]);
  if (frontmatter) {
    return frontmatter;
  }

  let inFrontmatter = false;
  let inWhenSection = false;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    if (trimmed === "---") {
      inFrontmatter = !inFrontmatter;
      continue;
    }
    if (inFrontmatter) {
      continue;
    }
    if (trimmed.startsWith("#")) {
      inWhenSection = trimmed.replace(/^#+/, "").trim().toLowerCase() === "when to use";
      continue;
    }
    if (!inWhenSection) {
      continue;
    }

    const cleaned = trimmed
      .replace(/^[-*+]\s*/, "")
      .replace(/^\d+[.)]\s*/, "")
      .trim();
    if (cleaned) {
      return cleaned;
    }
  }

  return null;
}

function extractDescription(raw: string) {
  let inFrontmatter = false;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    if (trimmed === "---") {
      inFrontmatter = !inFrontmatter;
      continue;
    }
    if (inFrontmatter || trimmed.startsWith("#")) {
      continue;
    }

    const cleaned = trimmed.replace(/`/g, "");
    if (!cleaned) {
      continue;
    }

    const chars = Array.from(cleaned);
    if (chars.length > 180) {
      return `${chars.slice(0, 180).join("")}...`;
    }
    return cleaned;
  }

  return null;
}

function findSkillFileInRoot(root: string, name: string) {
  const direct = path.join(root, name, "SKILL.md");
  if (existsSync(direct)) {
    return direct;
  }

  if (!existsSync(root)) {
    return null;
  }

  const entries = readdirSync(root, { withFileTypes: true }) as Dirent[];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const candidate = path.join(root, entry.name, name, "SKILL.md");
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

async function collectSkillDirsByName(root: string, name: string) {
  const out: string[] = [];
  const direct = path.join(root, name);
  if (existsSync(path.join(direct, "SKILL.md"))) {
    out.push(direct);
  }

  if (!existsSync(root)) {
    return out;
  }

  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const candidate = path.join(root, entry.name, name);
    if (existsSync(path.join(candidate, "SKILL.md"))) {
      out.push(candidate);
    }
  }

  return out;
}

export function createSkillService() {
  return {
    async listLocal(input: { projectDir: string }): Promise<LocalSkillCard[]> {
      const roots = collectSkillRoots(input.projectDir);
      const found: string[] = [];
      const seen = new Set<string>();
      for (const root of roots) {
        await gatherSkills(root, seen, found);
      }

      const out: LocalSkillCard[] = [];
      for (const skillDir of found) {
        const name = path.basename(skillDir);
        let description: string | null = null;
        let trigger: string | null = null;
        try {
          const raw = await readFile(path.join(skillDir, "SKILL.md"), "utf8");
          description = extractDescription(raw);
          trigger = extractTrigger(raw);
        } catch {
          // ignore read failures for cards
        }

        out.push({
          name,
          path: skillDir,
          description: description ?? undefined,
          trigger: trigger ?? undefined,
        });
      }

      return out.sort((a, b) => a.name.localeCompare(b.name));
    },

    async readLocal(input: { projectDir: string; name: string }): Promise<LocalSkillContent> {
      const name = validateSkillName(input.name);
      const roots = collectSkillRoots(input.projectDir);
      for (const root of roots) {
        const skillPath = findSkillFileInRoot(root, name);
        if (!skillPath) {
          continue;
        }

        return {
          path: skillPath,
          content: await readFile(skillPath, "utf8"),
        };
      }

      throw new Error("Skill not found");
    },

    async writeLocal(input: { projectDir: string; name: string; content: string }): Promise<ExecResult> {
      const name = validateSkillName(input.name);
      const roots = collectSkillRoots(input.projectDir);
      let targetPath: string | null = null;
      for (const root of roots) {
        const skillPath = findSkillFileInRoot(root, name);
        if (skillPath) {
          targetPath = skillPath;
          break;
        }
      }

      if (!targetPath) {
        return { ok: false, status: 1, stdout: "", stderr: "Skill not found" };
      }

      const nextContent = input.content.endsWith("\n") ? input.content : `${input.content}\n`;
      await writeFile(targetPath, nextContent, "utf8");
      return { ok: true, status: 0, stdout: `Saved skill ${name}`, stderr: "" };
    },

    async installTemplate(input: {
      projectDir: string;
      name: string;
      content: string;
      overwrite?: boolean;
    }): Promise<ExecResult> {
      const name = validateSkillName(input.name);
      const skillRoot = await ensureProjectSkillRoot(input.projectDir.trim());
      const dest = path.join(skillRoot, name);
      if (existsSync(dest)) {
        if (input.overwrite) {
          await rm(dest, { recursive: true, force: true });
        } else {
          return { ok: false, status: 1, stdout: "", stderr: `Skill already exists at ${dest}` };
        }
      }

      await mkdir(dest, { recursive: true });
      await writeFile(path.join(dest, "SKILL.md"), input.content, "utf8");
      return { ok: true, status: 0, stdout: `Installed skill to ${dest}`, stderr: "" };
    },

    async uninstall(input: { projectDir: string; name: string }): Promise<ExecResult> {
      const name = validateSkillName(input.name);
      const roots = collectSkillRoots(input.projectDir);
      let removed = false;
      for (const root of roots) {
        const matches = await collectSkillDirsByName(root, name);
        for (const skillDir of matches) {
          await rm(skillDir, { recursive: true, force: true });
          removed = true;
        }
      }

      if (!removed) {
        return {
          ok: false,
          status: 1,
          stdout: "",
          stderr: "Skill not found in .opencode/skills or .claude/skills",
        };
      }

      return { ok: true, status: 0, stdout: `Removed skill ${name}`, stderr: "" };
    },
  };
}

export type SkillService = ReturnType<typeof createSkillService>;

export function registerSkillIpc(service: SkillService) {
  ipcMain.handle(IPC_CHANNELS.skills("listLocal"), (_event, input: { projectDir: string }) => service.listLocal(input));
  ipcMain.handle(
    IPC_CHANNELS.skills("readLocal"),
    (_event, input: { projectDir: string; name: string }) => service.readLocal(input),
  );
  ipcMain.handle(
    IPC_CHANNELS.skills("writeLocal"),
    (_event, input: { projectDir: string; name: string; content: string }) => service.writeLocal(input),
  );
  ipcMain.handle(
    IPC_CHANNELS.skills("installTemplate"),
    (_event, input: { projectDir: string; name: string; content: string; overwrite?: boolean }) =>
      service.installTemplate(input),
  );
  ipcMain.handle(
    IPC_CHANNELS.skills("uninstall"),
    (_event, input: { projectDir: string; name: string }) => service.uninstall(input),
  );
}
