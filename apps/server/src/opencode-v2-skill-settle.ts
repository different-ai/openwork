import { readdir, readFile, realpath } from "node:fs/promises";
import { basename, dirname, join, sep } from "node:path";
import { parseFrontmatter } from "./frontmatter.js";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Native scan pattern relative to a skill root: `{*.md,**\/SKILL.md}`. */
async function scanSkillFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  const visit = async (current: string, top: boolean): Promise<void> => {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await visit(path, false);
      else if (entry.name === "SKILL.md" || (top && entry.name.endsWith(".md"))) files.push(path);
    }
  };
  await visit(directory, true);
  return files;
}

/** Name and body the engine publishes for a skill file, or null when it would skip the file. */
function nativeSkill(path: string, content: string): { name: string; body: string } | null {
  let parsed: { data: Record<string, unknown>; body: string };
  try {
    parsed = parseFrontmatter(content);
  } catch {
    return null;
  }
  const { name, description, slash } = parsed.data;
  if (name !== undefined && typeof name !== "string") return null;
  if (description !== undefined && typeof description !== "string") return null;
  if (slash !== undefined && typeof slash !== "boolean") return null;
  const fallback = basename(path) === "SKILL.md" ? basename(dirname(path)) : basename(path, ".md");
  return { name: name ?? fallback, body: parsed.body.trim() };
}

/**
 * After OpenWork itself installs, edits or removes workspace skills, give the
 * engine's own file watcher a moment to reflect them, so the next turn sees
 * the change. The watcher normally takes about 200 ms.
 *
 * This runs on OpenWork's skill write routes only, never before a prompt: the
 * engine alone decides which skills a turn sees, exactly as when `opencode2`
 * runs directly. Only `.opencode/skills` is compared, the one folder OpenWork
 * writes and the one the engine ranks first. A skill the engine serves under
 * the same name from another file counts as reflected. Never throws; returns
 * whether the engine caught up before the deadline.
 */
export async function waitForEngineSkillChanges(
  directory: string,
  readNative: () => Promise<unknown>,
  timeoutMs = 5_000,
): Promise<boolean> {
  const root = await realpath(directory).catch(() => directory);
  const skillRoot = join(root, ".opencode", "skills");
  // Deleted files cannot be resolved; map the configured spelling onto the real root.
  const canonical = async (path: string) => realpath(path).catch(() =>
    path.startsWith(directory + sep) ? join(root, path.slice(directory.length + 1)) : path);
  const onDisk = new Set<string>();
  const expected: Array<{ path: string; name: string; body: string }> = [];
  for (const file of await scanSkillFiles(skillRoot)) {
    const path = await canonical(file);
    onDisk.add(path);
    const text = await readFile(file, "utf8").catch(() => null);
    const skill = text === null ? null : nativeSkill(file, text);
    if (skill) expected.push({ path, ...skill });
  }
  const deadline = Date.now() + timeoutMs;
  do {
    let payload: unknown;
    try {
      payload = await readNative();
    } catch {
      return false;
    }
    if (!record(payload) || !Array.isArray(payload.data)) return false;
    const native = await Promise.all(payload.data.filter(record)
      .filter((skill) => typeof skill.location === "string" && typeof skill.content === "string")
      .map(async (skill) => ({
        path: await canonical(String(skill.location)),
        name: typeof skill.name === "string" ? skill.name : undefined,
        content: String(skill.content).trim(),
      })));
    const reflected = expected.every((skill) => native.some((entry) => entry.path === skill.path && entry.content === skill.body)
      || (!native.some((entry) => entry.path === skill.path) && native.some((entry) => entry.name === skill.name)));
    const stale = native.some((entry) => entry.path.startsWith(skillRoot + sep) && !onDisk.has(entry.path));
    if (reflected && !stale) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  return false;
}
