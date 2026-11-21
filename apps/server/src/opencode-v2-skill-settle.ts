import { readdir, readFile, realpath } from "node:fs/promises";
import { basename, dirname, join, sep } from "node:path";
import { parseFrontmatter } from "./frontmatter.js";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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

export async function waitForEngineSkillChanges(
  directory: string,
  readNative: () => Promise<unknown>,
  timeoutMs = 5_000,
): Promise<boolean> {
  const root = await realpath(directory).catch(() => directory);
  const skillRoot = join(root, ".opencode", "skills");
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
      .filter((skill) => typeof skill.path === "string" && typeof skill.content === "string")
      .map(async (skill) => ({
        path: await canonical(String(skill.path)),
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
