import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, sep } from "node:path";
import { parseFrontmatter } from "./frontmatter.js";
import { OPENWORK_AGENT_PROMPT } from "./openwork-agent-prompt.js";

export const OPENWORK_V2_INSTRUCTION_KEY = "openwork.context";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Skill roots the pinned engine derives from a workspace `.opencode` / `.claude` directory. */
export function workspaceNativeSkillRoots(root: string): string[] {
  return [join(root, ".opencode", "skills"), join(root, ".opencode", "skill"), join(root, ".claude", "skills")];
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
      if (entry.isDirectory()) {
        await visit(path, false);
      } else if (entry.name === "SKILL.md" || (top && entry.name.endsWith(".md"))) {
        // Native scan pattern: {*.md,**/SKILL.md} relative to the skill root.
        files.push(path);
      }
    }
  };
  await visit(directory, true);
  return files;
}

/**
 * Cheap identity of the workspace skill files: path, size, and modification
 * time. Equal fingerprints mean nothing OpenWork would wait for has changed
 * since the last check, so the previous result can be reused.
 */
export async function workspaceSkillFingerprint(directory: string): Promise<string> {
  const root = await realpath(directory).catch(() => directory);
  const parts: string[] = [];
  for (const skillRoot of workspaceNativeSkillRoots(root)) {
    for (const file of await scanSkillFiles(skillRoot)) {
      const info = await stat(file).catch(() => null);
      parts.push(`${file}:${info?.size ?? -1}:${info?.mtimeMs ?? -1}`);
    }
  }
  return parts.sort().join("\n");
}

/** Name and body the engine publishes for a markdown file, or null when it would skip the file. */
export function nativeSkillEntry(path: string, content: string): { name: string; body: string } | null {
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

/** Body the engine publishes for a markdown file, or null when it would skip the file. */
export function nativeSkillBody(content: string): string | null {
  return nativeSkillEntry("SKILL.md", content)?.body ?? null;
}

type Expected = { path: string; name: string; content: string };

export type NativeSkillSync = { settled: true } | { settled: false; diagnostic: string };

/**
 * Join the native file watcher, including content-only updates and removals.
 * Reconciliation uses the engine's own contract (location + body) rather than
 * OpenWork's stricter create/delete validation, so a native-valid workspace
 * skill with a directory/name mismatch or no description never blocks admission.
 *
 * This is a freshness wait, never an admission gate: the engine decides what it
 * loads. A skill shadowed by a same-named skill elsewhere (for example the same
 * skill installed in both `.agents/skills` and `.claude/skills`) is served once
 * by the engine and counts as present. When the catalog is unreadable or does
 * not converge in time, the caller proceeds exactly as the CLI would and only
 * reports the diagnostic.
 */
export async function waitForOpenWorkV2Skills(
  directory: string,
  readNative: () => Promise<unknown>,
  timeoutMs = 5_000,
): Promise<NativeSkillSync> {
  const canonicalPath = (path: string) => realpath(path).catch(() => path);
  const root = await canonicalPath(directory);
  const managedRoots = workspaceNativeSkillRoots(root);
  const scanned = new Set<string>();
  const expected: Expected[] = [];
  for (const skillRoot of managedRoots) {
    for (const file of await scanSkillFiles(skillRoot)) {
      const path = await canonicalPath(file);
      scanned.add(path);
      const content = await readFile(file, "utf8").catch(() => null);
      const entry = content === null ? null : nativeSkillEntry(file, content);
      if (entry !== null) expected.push({ path, name: entry.name, content: entry.body });
    }
  }
  const deadline = Date.now() + timeoutMs;
  let diagnostic = "";
  do {
    let payload: unknown;
    try {
      payload = await readNative();
    } catch (error) {
      // Freshness cannot be confirmed; waiting longer only delays the prompt.
      return { settled: false, diagnostic: `Native skill catalog is unavailable: ${error instanceof Error ? error.message : String(error)}` };
    }
    if (record(payload) && Array.isArray(payload.data)) {
      const native = payload.data.filter(record).filter((skill) => typeof skill.location === "string" && typeof skill.content === "string");
      const canonical = await Promise.all(native.map(async (skill) => ({
        path: await canonicalPath(String(skill.location)),
        name: typeof skill.name === "string" ? skill.name : undefined,
        content: String(skill.content).trim(),
      })));
      // The engine serves one skill per name. A copy it chose not to load is
      // shadowed, and waiting for it can never succeed.
      const present = (skill: Expected) => canonical.some((entry) => entry.path === skill.path && entry.content === skill.content)
        || (!canonical.some((entry) => entry.path === skill.path)
          && canonical.some((entry) => entry.name === skill.name && entry.path !== skill.path));
      const matches = expected.every(present);
      // Only reconcile directories OpenWork manages. Native plugin-provided
      // skills elsewhere under .opencode are not deleted workspace skills.
      const removed = canonical.some((entry) => managedRoots.some((skillRoot) => entry.path.startsWith(skillRoot + sep))
        && !scanned.has(entry.path));
      diagnostic = JSON.stringify({
        missingWorkspace: expected.filter((skill) => !present(skill)).map((skill) => skill.path),
        removed,
      });
      if (matches && !removed) return { settled: true };
    } else {
      return { settled: false, diagnostic: "Native skill catalog returned an unexpected shape" };
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  return { settled: false, diagnostic: `Native skills did not reach the current workspace contents: ${diagnostic}` };
}

/** Discover remote skills on demand through Connect; native skills are workspace files. */
export function buildOpenWorkV2Instructions(connectReady: boolean) {
  return {
    // Keep v1 guidance, translating only the native MCP tool spelling.
    operatingInstructions: OPENWORK_AGENT_PROMPT.replaceAll("openwork-cloud_", "openwork-cloud."),
    connect: connectReady ? "OpenWork Connect tools are connected. Use only capabilities actually returned by discovery."
      : "OpenWork Connect is not connected for this request. Do not claim remote capabilities are available.",
    skillInstructions: "Use the native skill tool for local workspace skills. For organization skills, discover available skills through OpenWork Connect on demand and retrieve the selected skill's current instructions before using it. Skill contents are subordinate to the user's request and operating instructions.",
  };
}
