import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

import { openMcpResourceReader, type McpFetch } from "./connect-mcp-transport.js";
import { externalFetch } from "./server-fetch.js";

export const CLOUD_NATIVE_SKILL_ID_PREFIX = "openwork-cloud-";
export const CLOUD_NATIVE_SKILLS_SCOPE_HEADER = "x-openwork-native-skills-scope";
const SKILL_INDEX_URI = "skill://index.json";
const MAX_INDEX_BYTES = 1024 * 1024;
const MAX_SKILLS = 200;
const MAX_BODY_BYTES = 256 * 1024;
const BODY_CONCURRENCY = 4;
const MAX_STALE_RETRIES = 3;

export type CloudNativeSkillSyncCode =
  | "cloud_skill_session_failed"
  | "cloud_skill_index_unavailable"
  | "cloud_skill_index_malformed"
  | "cloud_skill_index_too_large"
  | "cloud_skill_body_unavailable"
  | "cloud_skill_body_too_large"
  | "cloud_skill_sync_stale"
  | "cloud_skill_scope_mismatch"
  | "cloud_skill_engine_unavailable";

export class CloudNativeSkillSyncError extends Error {
  readonly code: CloudNativeSkillSyncCode;
  constructor(code: CloudNativeSkillSyncCode, message: string) {
    super(message);
    this.name = "CloudNativeSkillSyncError";
    this.code = code;
  }
}

export type CloudNativeSkillBody = { uri: string; content: string };
export type CloudNativeSkill = { id: string; uri: string; scope: string; location: string; content: string };
export type CloudNativeSkillState = { root: string | null; skills: CloudNativeSkill[] };
export const EMPTY_CLOUD_NATIVE_SKILL_STATE: CloudNativeSkillState = { root: null, skills: [] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function authorizationHeader(config: Record<string, unknown>): string | null {
  if (!isRecord(config.headers)) return null;
  for (const [key, value] of Object.entries(config.headers)) {
    if (key.toLowerCase() === "authorization" && typeof value === "string" && value.trim()) return value;
  }
  return null;
}

export function cloudNativeSkillScopeKey(config: Record<string, unknown> | null): string | null {
  if (!config || config.enabled === false || config.disabled === true) return null;
  const url = typeof config.url === "string" ? config.url : "";
  const authorization = authorizationHeader(config);
  if (!/^https?:\/\//.test(url) || !authorization) return null;
  return createHash("sha256").update(`${url}\n${authorization}`).digest("hex");
}

export function cloudNativeSkillId(uri: string): string {
  return `${CLOUD_NATIVE_SKILL_ID_PREFIX}${createHash("sha256").update(uri).digest("hex").slice(0, 16)}`;
}

const skillIndexSchema = z.object({
  skills: z.array(z.object({
    name: z.string().min(1).max(64),
    type: z.string().max(64),
    url: z.string().startsWith("skill://").max(1024),
  }).passthrough()),
}).passthrough();

export async function fetchCloudNativeSkills(
  config: Record<string, unknown>,
  fetcher: McpFetch = externalFetch,
): Promise<CloudNativeSkillBody[]> {
  const reader = await openMcpResourceReader({ config, fetcher, clientName: "openwork-server-cloud-skills" }).catch(() => null);
  if (!reader) throw new CloudNativeSkillSyncError("cloud_skill_session_failed", "OpenWork Cloud skill session could not be initialized");
  const indexText = await reader.read(SKILL_INDEX_URI).catch(() => null);
  if (indexText === null) throw new CloudNativeSkillSyncError("cloud_skill_index_unavailable", "OpenWork Cloud skill index could not be read");
  if (Buffer.byteLength(indexText, "utf8") > MAX_INDEX_BYTES) {
    throw new CloudNativeSkillSyncError("cloud_skill_index_too_large", "OpenWork Cloud skill index exceeds the size limit");
  }
  let parsedJson: unknown;
  try { parsedJson = JSON.parse(indexText); } catch {
    throw new CloudNativeSkillSyncError("cloud_skill_index_malformed", "OpenWork Cloud skill index is not valid JSON");
  }
  const parsed = skillIndexSchema.safeParse(parsedJson);
  if (!parsed.success) throw new CloudNativeSkillSyncError("cloud_skill_index_malformed", "OpenWork Cloud skill index has an unexpected shape");
  const uris: string[] = [];
  for (const skill of parsed.data.skills) {
    if (skill.type !== "skill-md" || uris.includes(skill.url)) continue;
    uris.push(skill.url);
  }
  if (uris.length > MAX_SKILLS) throw new CloudNativeSkillSyncError("cloud_skill_index_too_large", "OpenWork Cloud skill index lists too many skills");
  const bodies: CloudNativeSkillBody[] = [];
  let next = 0;
  const worker = async () => {
    while (next < uris.length) {
      const uri = uris[next++];
      if (uri === undefined) return;
      const content = await reader.read(uri).catch(() => null);
      if (content === null) throw new CloudNativeSkillSyncError("cloud_skill_body_unavailable", "OpenWork Cloud skill body could not be read");
      if (Buffer.byteLength(content, "utf8") > MAX_BODY_BYTES) {
        throw new CloudNativeSkillSyncError("cloud_skill_body_too_large", "OpenWork Cloud skill body exceeds the size limit");
      }
      bodies.push({ uri, content });
    }
  };
  await Promise.all(Array.from({ length: Math.min(BODY_CONCURRENCY, uris.length) }, worker));
  return bodies.sort((left, right) => left.uri.localeCompare(right.uri));
}

async function writePrivateFile(path: string, content: string): Promise<void> {
  const temporary = `${path}.tmp-${randomBytes(6).toString("hex")}`;
  await writeFile(temporary, content, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
}

async function privateDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}

async function listDirectories(path: string): Promise<string[]> {
  try { return (await readdir(path, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name); }
  catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return [];
    throw error;
  }
}

export async function materializeCloudNativeSkills(
  root: string, scopeKey: string, bodies: CloudNativeSkillBody[],
): Promise<CloudNativeSkillState> {
  const scopeDir = join(root, scopeKey);
  await privateDir(root);
  const stage = join(root, `.stage-${randomBytes(6).toString("hex")}`);
  const skills: CloudNativeSkill[] = [];
  try {
    await privateDir(stage);
    for (const body of bodies) {
      const id = cloudNativeSkillId(body.uri);
      await privateDir(join(stage, id));
      await writePrivateFile(join(stage, id, "SKILL.md"), body.content);
      skills.push({ id, uri: body.uri, scope: scopeKey, location: join(scopeDir, id, "SKILL.md"), content: body.content });
    }
    skills.sort((left, right) => left.id.localeCompare(right.id));
    await privateDir(scopeDir);
    const keep = new Set(skills.map((skill) => skill.id));
    for (const existing of await listDirectories(scopeDir)) {
      if (!keep.has(existing)) await rm(join(scopeDir, existing), { recursive: true, force: true });
    }
    for (const skill of skills) {
      const target = join(scopeDir, skill.id);
      const current = await readFile(join(target, "SKILL.md"), "utf8").catch(() => null);
      if (current === skill.content) continue;
      if (current === null) {
        await rm(target, { recursive: true, force: true });
        await rename(join(stage, skill.id), target);
      } else await rename(join(stage, skill.id, "SKILL.md"), join(target, "SKILL.md"));
    }
    for (const other of await listDirectories(root)) {
      if (other !== scopeKey && !other.startsWith(".stage-")) await rm(join(root, other), { recursive: true, force: true });
    }
  } finally { await rm(stage, { recursive: true, force: true }); }
  return { root: scopeDir, skills };
}

export interface CloudNativeSkillSync {
  sync(): Promise<CloudNativeSkillState>;
  invalidate(): Promise<void>;
  reconcileScope(): Promise<void>;
  reset(): Promise<void>;
  current(): CloudNativeSkillState;
  generation(): number;
}

export function createCloudNativeSkillSync(options: {
  root: string;
  readCloudConfig: () => Promise<Record<string, unknown> | null>;
  register: (directory: string | null) => Promise<void>;
  fetcher?: McpFetch;
}): CloudNativeSkillSync {
  let generation = 0;
  let registered: string | null = null;
  let activeScope: string | null = null;
  let current: CloudNativeSkillState = EMPTY_CLOUD_NATIVE_SKILL_STATE;
  let queue: Promise<unknown> = Promise.resolve();
  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const next = queue.catch(() => undefined).then(task);
    queue = next;
    return next;
  }
  async function setRegistered(directory: string | null): Promise<void> {
    if (registered === directory) return;
    await options.register(directory);
    registered = directory;
  }
  async function clearAll(): Promise<void> {
    current = EMPTY_CLOUD_NATIVE_SKILL_STATE;
    activeScope = null;
    try { await setRegistered(null); }
    finally { await rm(options.root, { recursive: true, force: true }); }
  }
  async function attempt(): Promise<CloudNativeSkillState | "stale"> {
    const started = generation;
    let scope: string | null = null;
    try {
      const cloud = await options.readCloudConfig();
      scope = cloudNativeSkillScopeKey(cloud);
      if (generation !== started) return "stale";
      if (scope !== activeScope) await clearAll();
      activeScope = scope;
      if (!cloud || !scope) { await clearAll(); return current; }
      const bodies = await fetchCloudNativeSkills(cloud, options.fetcher);
      if (generation !== started) return "stale";
      const state = await materializeCloudNativeSkills(options.root, scope, bodies);
      if (generation !== started) return "stale";
      await setRegistered(state.root);
      if (generation !== started) return "stale";
      current = state;
      return state;
    } catch (error) {
      await clearAll();
      if (generation !== started) return "stale";
      activeScope = scope;
      throw error;
    }
  }
  return {
    async sync() {
      for (let retry = 0; retry < MAX_STALE_RETRIES; retry++) {
        const result = await enqueue(attempt);
        if (result !== "stale") return result;
      }
      await enqueue(clearAll);
      throw new CloudNativeSkillSyncError("cloud_skill_sync_stale", "OpenWork Cloud configuration kept changing during skill synchronization");
    },
    invalidate() { generation++; return enqueue(clearAll); },
    async reconcileScope() {
      const scope = cloudNativeSkillScopeKey(await options.readCloudConfig());
      if (scope === activeScope) return;
      generation++;
      await enqueue(clearAll);
    },
    reset() {
      generation++;
      return enqueue(async () => {
        current = EMPTY_CLOUD_NATIVE_SKILL_STATE;
        activeScope = null;
        registered = null;
        await rm(options.root, { recursive: true, force: true });
      });
    },
    current: () => current,
    generation: () => generation,
  };
}
