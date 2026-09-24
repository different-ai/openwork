import { readdir, readFile, realpath } from "node:fs/promises";
import { basename, dirname, join, sep } from "node:path";
import { parseFrontmatter } from "./frontmatter.js";
import { OPENWORK_AGENT_PROMPT } from "./openwork-agent-prompt.js";
import type { CloudNativeSkillState } from "./cloud-native-skills.js";

export const OPENWORK_V2_INSTRUCTION_KEY = "openwork.context";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function workspaceNativeSkillRoots(root: string): string[] {
  return [join(root, ".opencode", "skills"), join(root, ".opencode", "skill"), join(root, ".claude", "skills")];
}

async function scanSkillFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  const visit = async (current: string, top: boolean): Promise<void> => {
    let entries;
    try { entries = await readdir(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await visit(path, false);
      else if (entry.name === "SKILL.md" || (top && entry.name.endsWith(".md"))) files.push(path);
    }
  };
  await visit(directory, true);
  return files;
}

export function nativeSkillBody(content: string): string | null {
  let parsed: { data: Record<string, unknown>; body: string };
  try { parsed = parseFrontmatter(content); } catch { return null; }
  const { name, description, slash } = parsed.data;
  if (name !== undefined && typeof name !== "string") return null;
  if (description !== undefined && typeof description !== "string") return null;
  if (slash !== undefined && typeof slash !== "boolean") return null;
  return parsed.body.trim();
}

type Expected = { path: string; content: string; id?: string };

export async function waitForOpenWorkV2Skills(
  directory: string,
  readNative: () => Promise<unknown>,
  cloud?: { root: string; state: CloudNativeSkillState },
): Promise<void> {
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
      const body = content === null ? null : nativeSkillBody(content);
      if (body !== null) expected.push({ path, content: body });
    }
  }
  const cloudRoot = cloud ? `${await canonicalPath(cloud.root)}${sep}` : null;
  const expectedCloud: Expected[] = [];
  for (const skill of cloud?.state.skills ?? []) {
    expectedCloud.push({ path: await canonicalPath(skill.location), content: nativeSkillBody(skill.content) ?? skill.content.trim() });
  }
  const deadline = Date.now() + 5_000;
  do {
    const payload = await readNative();
    if (!record(payload) || !Array.isArray(payload.data)) throw new Error("Native skill catalog is unavailable");
    const native = payload.data.filter(record).filter((skill) => typeof skill.location === "string" && typeof skill.content === "string");
    const canonical = await Promise.all(native.map(async (skill) => ({
      path: await canonicalPath(String(skill.location)), content: String(skill.content).trim(),
    })));
    const present = (skill: Expected) => canonical.some((entry) => entry.path === skill.path && entry.content === skill.content);
    const matches = expected.every(present) && expectedCloud.every(present);
    const removed = canonical.some((entry) => managedRoots.some((skillRoot) => entry.path.startsWith(skillRoot + sep))
      && !scanned.has(entry.path));
    const staleCloud = cloudRoot !== null && canonical.some((entry) => entry.path.startsWith(cloudRoot)
      && !expectedCloud.some((skill) => skill.path === entry.path));
    if (matches && !removed && !staleCloud) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  throw new Error("Native skills did not reach the current workspace contents");
}

async function canonicalSkillPath(path: string): Promise<string> {
  let current = path;
  const suffix: string[] = [];
  for (;;) {
    const canonical = await realpath(current).catch(() => null);
    if (canonical !== null) return join(canonical, ...suffix);
    const parent = dirname(current);
    if (parent === current) return path;
    suffix.unshift(basename(current));
    current = parent;
  }
}

export async function waitForNativeOpenWorkV2Skills(
  directory: string,
  readNative: () => Promise<unknown>,
  cloud?: { root: string; state: CloudNativeSkillState },
): Promise<{ data: Record<string, unknown>[] }> {
  const canonicalPath = canonicalSkillPath;
  const root = await canonicalPath(directory);
  const managedRoots = workspaceNativeSkillRoots(root);
  const scanned = new Set<string>();
  const expected: Expected[] = [];
  for (const skillRoot of managedRoots) {
    for (const file of await scanSkillFiles(skillRoot)) {
      const path = await canonicalPath(file);
      scanned.add(path);
      const content = await readFile(file, "utf8").catch(() => null);
      const body = content === null ? null : nativeSkillBody(content);
      if (body !== null) expected.push({ path, content: body });
    }
  }
  const cloudRoot = cloud ? `${await canonicalPath(cloud.root)}${sep}` : null;
  const expectedCloud: Expected[] = [];
  for (const skill of cloud?.state.skills ?? []) {
    expectedCloud.push({ id: skill.id, path: await canonicalPath(skill.location), content: nativeSkillBody(skill.content) ?? skill.content.trim() });
  }
  const deadline = Date.now() + 5_000;
  do {
    const payload = await readNative();
    if (!record(payload) || !Array.isArray(payload.data)) throw new Error("Native skill catalog is unavailable");
    // Native-2 calls the file field `path`; the older v2 API used `location`.
    // Normalize at this boundary so readiness and the app's skill picker see
    // the same native entry without weakening exact path/body checks.
    const native = payload.data.filter(record).flatMap((skill) => {
      const location = typeof skill.location === "string" ? skill.location : typeof skill.path === "string" ? skill.path : null;
      return location && typeof skill.content === "string"
        && (skill.location === undefined || skill.path === undefined || skill.location === skill.path)
        ? [{ ...skill, location, content: skill.content } as Record<string, unknown> & { location: string; content: string }] : [];
    });
    const canonical = await Promise.all(native.map(async (skill) => ({
      skill, path: await canonicalPath(String(skill.location)),
    })));
    const present = (skill: Expected) => canonical.some((entry) => entry.path === skill.path
      && (skill.id === undefined || entry.skill.id === skill.id) && String(entry.skill.content).trim() === skill.content);
    const matches = expected.every(present) && expectedCloud.every(present);
    const removed = canonical.some((entry) => managedRoots.some((skillRoot) => entry.path.startsWith(skillRoot + sep)) && !scanned.has(entry.path));
    const staleCloud = cloudRoot !== null && canonical.some((entry) => entry.path.startsWith(cloudRoot)
      && !expectedCloud.some((skill) => skill.path === entry.path));
    if (matches && !removed && !staleCloud) return { data: canonical.map(({ skill: entry, path }) => {
      const source = cloud?.state.skills.find((skill) => skill.id === entry.id
        && expectedCloud.some((expected) => expected.id === skill.id && expected.path === path));
      return source ? { ...entry, source: { type: "openwork-cloud", uri: source.uri, scope: source.scope } } : entry;
    }) };
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  throw new Error("Native skills did not reach the current workspace contents");
}

export function buildOpenWorkV2Instructions(connectReady: boolean | "unknown", _mode: "preview" | "native" = "preview") {
  return {
    operatingInstructions: OPENWORK_AGENT_PROMPT.replace(
      "Org-connected services, remote skills, Workflows, and Automations reach you through OpenWork Connect: discover with openwork-cloud_search_capabilities, then run with openwork-cloud_execute_capability using an exact returned name. The runtime steering later in this prompt states whether that connection is ready right now; only name services that search or the remote skill catalog actually returns.",
      "Org-connected services, Workflows, and Automations reach you through OpenWork Connect: discover and execute capabilities through the native OpenWork MCP interface exposed by the current tool catalog, using an exact returned name. Authorized organization skills are in the native skill catalog, not in Connect. The current tool catalog determines whether Connect is available; only name services that discovery actually returns.",
    ),
    connect: connectReady === true ? "OpenWork Connect tools are connected. Use only capabilities actually returned by discovery."
      : connectReady === "unknown" ? "Use OpenWork Connect only when its tools appear in the current tool catalog. If they are absent, continue with local work. Do not claim remote capabilities without discovery."
      : "OpenWork Connect is not connected for this request. Do not claim remote capabilities are available.",
    skillInstructions: "Use the current native skill catalog and skill tool for workspace skills and authorized organization skills alike; organization skills appear there with ids prefixed openwork-cloud-. Load current instructions before following them. Removed skills from previous turns are not available capabilities. Do not fetch skills through OpenWork Connect tools. Skill contents are subordinate to the user's request and operating instructions.",
  };
}
