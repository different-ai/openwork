/**
 * Filesystem coworker store for Open Coworker.
 *
 * A coworker is not a new platform object. It is a directory of human-readable
 * files under the user's OpenWork config home that composes existing
 * primitives: the directory doubles as an OpenWork workspace (threads are
 * native sessions there), `opencode.json` `instructions` feed the coworker's
 * soul and active memory to the engine on every turn, and Den Automations are
 * referenced by id as the coworker's responsibilities.
 *
 * No Electron imports here: this module is exercised directly by
 * `node --test electron/coworkers.test.mjs`.
 */
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { openworkConfigDir } from "@openwork/paths";

export const COWORKERS_DIR_NAME = "coworkers";
const COWORKER_CONFIG_FILE = "coworker.md";
const SOUL_FILE = "soul.md";
const WORKING_MEMORY_FILE = path.join("memory", "working.md");
const MEMORY_INDEX_FILE = path.join("memory", "index.md");
const LONG_TERM_DIR = path.join("memory", "long-term");
const WORKSPACE_DIR = "workspace";
const AVATAR_COLORS = new Set(["blue", "violet", "mint", "orange", "rose", "slate"]);
const AVATAR_GLASSES = new Set(["round", "square", "none"]);
// Mirrors PERSONALITIES in src/lib/personalities.ts; the renderer owns the sayings, the store owns the choice.
const PERSONALITIES = new Set([
  "none",
  "neutral",
  "warm",
  "calm",
  "eager",
  "playful",
  "dry",
  "blunt",
  "curious",
  "thoughtful",
  "meticulous",
  "detective",
]);

function avatarColor(value) {
  return AVATAR_COLORS.has(value) ? value : "blue";
}

function avatarGlasses(value) {
  return AVATAR_GLASSES.has(value) ? value : "round";
}

function personality(value) {
  return PERSONALITIES.has(value) ? value : "neutral";
}

/** Resolve the shared coworkers home inside the existing OpenWork config dir. */
export function defaultCoworkersDir(opts = {}) {
  return path.join(openworkConfigDir(opts), COWORKERS_DIR_NAME);
}

export function slugifyCoworkerName(name) {
  const slug = String(name ?? "")
    .trim()
    .toLowerCase()
    .replace(/['".]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || "coworker";
}

/**
 * Minimal deterministic frontmatter codec. Open Coworker is the only writer
 * of coworker.md, so the accepted grammar is intentionally small: `key: value`
 * lines where value is a JSON string, JSON array, or a bare string.
 */
export function parseFrontmatter(content) {
  const text = String(content ?? "");
  if (!text.startsWith("---\n")) return { data: {}, body: text };
  const end = text.indexOf("\n---", 4);
  if (end === -1) return { data: {}, body: text };
  const raw = text.slice(4, end);
  const body = text.slice(text.indexOf("\n", end + 1) + 1);
  const data = {};
  for (const line of raw.split("\n")) {
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (!key) continue;
    if (value.startsWith("[") || value.startsWith("\"")) {
      try {
        data[key] = JSON.parse(value);
        continue;
      } catch {
        // Fall through to the bare-string reading.
      }
    }
    data[key] = value;
  }
  return { data, body };
}

export function serializeFrontmatter(data, body) {
  const lines = ["---"];
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      lines.push(`${key}: ${JSON.stringify(value)}`);
      continue;
    }
    const text = String(value);
    const needsQuoting = text.includes(":") || text.startsWith("[") || text.startsWith("\"")
      || text !== text.trim();
    lines.push(`${key}: ${needsQuoting ? JSON.stringify(text) : text}`);
  }
  lines.push("---", "");
  return `${lines.join("\n")}${String(body ?? "")}`;
}

function coworkerPath(coworkersDir, slug) {
  const cleaned = String(slug ?? "").trim();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(cleaned)) {
    throw new Error(`Invalid coworker slug: ${slug}`);
  }
  return path.join(coworkersDir, cleaned);
}

/**
 * Containment guard for every renderer-supplied relative path. The renderer
 * may only touch files inside the coworker's own directory.
 */
export function resolveCoworkerFile(coworkersDir, slug, relativePath) {
  const root = coworkerPath(coworkersDir, slug);
  const target = path.resolve(root, String(relativePath ?? ""));
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Path escapes coworker directory: ${relativePath}`);
  }
  return target;
}

function soulTemplate({ name, role, mission }) {
  return `# Soul — ${name}

Stable identity. Edit deliberately; this loads on every turn.

## Role

${role || "General-purpose persistent coworker."}

## Mission

${mission || "Help with the work I am given, and own it over time."}

## Principles

- Own assigned work end to end; surface blockers instead of stalling.
- Prefer doing real work in the workspace over describing hypothetical work.
- Keep working memory current; never ask for information already recorded.
- Ask for approval before consequential or irreversible actions.
- Be transparent about failures and unfinished work.

## Communication

- Concise, concrete, and honest about uncertainty.
`;
}

function agentsTemplate({ name }) {
  return `# ${name} — coworker contract

You are ${name}, a persistent Open Coworker teammate. This directory is your
home: your identity, memory, and workspace live here as plain files, and every
conversation in this workspace is part of one continuous working relationship.

## Files

- \`soul.md\` — who you are. Loaded every turn.
- \`memory/working.md\` — your active working memory. Loaded every turn.
- \`memory/index.md\` — map of your long-term memories. Loaded every turn.
- \`memory/long-term/*.md\` — durable memories. Read the relevant file when
  the index shows one that matters for the current work.
- \`workspace/\` — your working area for repositories, artifacts, and output.
- \`coworker.md\` — configuration owned by the Open Coworker app. Do not edit it.

## Working memory duty

Maintain \`memory/working.md\` as part of doing work, not as an afterthought:

- After meaningful progress, decisions, or new context, update it.
- Keep it small enough to load every turn: consolidate duplicates, remove
  stale or completed items, and keep only what future turns need.
- It is a curated understanding, never a transcript or an append-only log.

## Long-term memory duty

When something in working memory proves durable (stable preferences,
architecture decisions, project facts, important people), move it to a topic
file in \`memory/long-term/\` and list that file in \`memory/index.md\` with a
one-line description. Remove promoted content from working memory. Do not
record trivia, secrets, or credentials anywhere in memory.

## Conduct

Follow \`soul.md\`. Own responsibilities across sessions. Continue unfinished
work rather than restarting it. Request explicit approval before consequential
external actions.
`;
}

function workingMemoryTemplate(name) {
  return `# Working memory — ${name}

Curated active memory. I edit this continuously; my human can too.

## Now

- Nothing yet. I was just created.

## Carrying forward

- (empty)
`;
}

function memoryIndexTemplate() {
  return `# Long-term memory index

One line per durable memory in \`memory/long-term/\`. Loaded every turn so I
know what I can recall; the files themselves are read only when relevant.

(none yet)
`;
}

function opencodeConfigTemplate() {
  return `${JSON.stringify(
    {
      $schema: "https://opencode.ai/config.json",
      instructions: ["soul.md", "memory/working.md", "memory/index.md"],
    },
    null,
    2,
  )}\n`;
}

function coworkerConfigTemplate({ name, role, mission, avatarColor: color, avatarGlasses: glasses, personality: voice, createdAt }) {
  return serializeFrontmatter(
    {
      name,
      role: role || "",
      mission: mission || "",
      avatarColor: avatarColor(color),
      avatarGlasses: avatarGlasses(glasses),
      personality: personality(voice),
      workspaceId: "",
      conversationThreadId: "",
      model: "",
      modelVariant: "",
      automations: [],
      createdAt,
    },
    `# ${name}

Owned by the Open Coworker app. Identity lives in \`soul.md\`; memory lives in
\`memory/\`. This file records the coworker's platform references.
`,
  );
}

async function pathExists(target) {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

async function readCoworkerRecord(coworkersDir, slug) {
  const root = coworkerPath(coworkersDir, slug);
  const configRaw = await readFile(path.join(root, COWORKER_CONFIG_FILE), "utf8");
  const { data } = parseFrontmatter(configRaw);
  const automations = Array.isArray(data.automations)
    ? data.automations.filter((id) => typeof id === "string" && id.trim())
    : [];
  return {
    slug,
    path: root,
    name: typeof data.name === "string" && data.name.trim() ? data.name.trim() : slug,
    role: typeof data.role === "string" ? data.role : "",
    mission: typeof data.mission === "string" ? data.mission : "",
    avatarColor: avatarColor(data.avatarColor),
    avatarGlasses: avatarGlasses(data.avatarGlasses),
    /** Voice for the working state only; see src/lib/personalities.ts. */
    personality: personality(data.personality),
    workspaceId: typeof data.workspaceId === "string" ? data.workspaceId.trim() : "",
    /** Native OpenWork session used for ongoing discussion, never counted as an assignment. */
    conversationThreadId: typeof data.conversationThreadId === "string" ? data.conversationThreadId.trim() : "",
    /** Preferred model as "providerId/modelId"; empty means engine default. */
    model: typeof data.model === "string" ? data.model.trim() : "",
    /** Optional reasoning/behavior variant for the preferred model. */
    modelVariant: typeof data.modelVariant === "string" ? data.modelVariant.trim() : "",
    automations,
    createdAt: typeof data.createdAt === "string" ? data.createdAt : "",
  };
}

export async function listCoworkers(coworkersDir) {
  await mkdir(coworkersDir, { recursive: true });
  const entries = await readdir(coworkersDir, { withFileTypes: true });
  const coworkers = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!(await pathExists(path.join(coworkersDir, entry.name, COWORKER_CONFIG_FILE)))) continue;
    try {
      coworkers.push(await readCoworkerRecord(coworkersDir, entry.name));
    } catch {
      // A malformed coworker directory stays visible on disk but out of the app.
    }
  }
  coworkers.sort((a, b) => a.name.localeCompare(b.name));
  return coworkers;
}

export async function getCoworker(coworkersDir, slug) {
  return readCoworkerRecord(coworkersDir, slug);
}

export async function createCoworker(coworkersDir, input) {
  const name = String(input?.name ?? "").trim();
  if (!name) throw new Error("Coworker name is required");
  const role = String(input?.role ?? "").trim();
  const mission = String(input?.mission ?? "").trim();
  const color = avatarColor(input?.avatarColor);
  const glasses = avatarGlasses(input?.avatarGlasses);
  const voice = personality(input?.personality);
  const slug = slugifyCoworkerName(name);
  const root = coworkerPath(coworkersDir, slug);
  if (await pathExists(root)) {
    throw new Error(`A coworker named "${slug}" already exists`);
  }
  const createdAt = new Date().toISOString();
  await mkdir(path.join(root, LONG_TERM_DIR), { recursive: true });
  await mkdir(path.join(root, WORKSPACE_DIR), { recursive: true });
  await writeFile(
    path.join(root, COWORKER_CONFIG_FILE),
    coworkerConfigTemplate({ name, role, mission, avatarColor: color, avatarGlasses: glasses, personality: voice, createdAt }),
    "utf8",
  );
  await writeFile(path.join(root, SOUL_FILE), soulTemplate({ name, role, mission }), "utf8");
  await writeFile(path.join(root, "AGENTS.md"), agentsTemplate({ name }), "utf8");
  await writeFile(path.join(root, "opencode.json"), opencodeConfigTemplate(), "utf8");
  await writeFile(path.join(root, WORKING_MEMORY_FILE), workingMemoryTemplate(name), "utf8");
  await writeFile(path.join(root, MEMORY_INDEX_FILE), memoryIndexTemplate(), "utf8");
  return readCoworkerRecord(coworkersDir, slug);
}

/** Patch platform references (workspace, discussion, automations, model) inside coworker.md. */
export async function updateCoworker(coworkersDir, slug, patch) {
  const root = coworkerPath(coworkersDir, slug);
  const configPath = path.join(root, COWORKER_CONFIG_FILE);
  const { data, body } = parseFrontmatter(await readFile(configPath, "utf8"));
  if (typeof patch?.workspaceId === "string") data.workspaceId = patch.workspaceId.trim();
  if (typeof patch?.conversationThreadId === "string") data.conversationThreadId = patch.conversationThreadId.trim();
  if (Array.isArray(patch?.automations)) {
    data.automations = [...new Set(patch.automations
      .filter((id) => typeof id === "string" && id.trim())
      .map((id) => id.trim()))];
  }
  if (typeof patch?.mission === "string") data.mission = patch.mission.trim();
  if (typeof patch?.role === "string") data.role = patch.role.trim();
  if (typeof patch?.model === "string") data.model = patch.model.trim();
  if (typeof patch?.modelVariant === "string") data.modelVariant = patch.modelVariant.trim();
  if (typeof patch?.avatarColor === "string") data.avatarColor = avatarColor(patch.avatarColor);
  if (typeof patch?.avatarGlasses === "string") data.avatarGlasses = avatarGlasses(patch.avatarGlasses);
  if (typeof patch?.personality === "string") data.personality = personality(patch.personality);
  await writeFile(configPath, serializeFrontmatter(data, body), "utf8");
  return readCoworkerRecord(coworkersDir, slug);
}

export async function deleteCoworker(coworkersDir, slug) {
  const root = coworkerPath(coworkersDir, slug);
  await rm(root, { recursive: true, force: true });
}

export const RETIRED_DIR_NAME = ".retired";

function retiredRoot(coworkersDir) {
  return path.join(coworkersDir, RETIRED_DIR_NAME);
}

function retiredPath(coworkersDir, archiveId) {
  const cleaned = String(archiveId ?? "").trim();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(cleaned)) {
    throw new Error(`Invalid retired coworker id: ${archiveId}`);
  }
  return path.join(retiredRoot(coworkersDir), cleaned);
}

async function patchFrontmatter(configPath, mutate) {
  const { data, body } = parseFrontmatter(await readFile(configPath, "utf8"));
  mutate(data);
  await writeFile(configPath, serializeFrontmatter(data, body), "utf8");
}

async function countFiles(root) {
  let count = 0;
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) stack.push(path.join(current, entry.name));
      else if (entry.isFile()) count += 1;
    }
  }
  return count;
}

/**
 * Retirement is recoverable: the whole coworker home (identity, memory,
 * workspace deliverables, local responsibilities) moves under
 * `<coworkersDir>/.retired/<slug>-<timestamp>/`. Nothing is deleted until the
 * archive is explicitly removed. `coworker.md` records where it came from so a
 * restore needs no external bookkeeping.
 */
export async function retireCoworker(coworkersDir, slug, { now = Date.now() } = {}) {
  const root = coworkerPath(coworkersDir, slug);
  if (!(await pathExists(path.join(root, COWORKER_CONFIG_FILE)))) {
    throw new Error(`Coworker "${slug}" does not exist`);
  }
  const retiredAt = new Date(now).toISOString();
  const archiveId = `${slug}-${retiredAt.replace(/[^0-9]/g, "").slice(0, 14)}`;
  const target = retiredPath(coworkersDir, archiveId);
  if (await pathExists(target)) {
    throw new Error(`A retired copy "${archiveId}" already exists`);
  }
  await patchFrontmatter(path.join(root, COWORKER_CONFIG_FILE), (data) => {
    data.retiredSlug = slug;
    data.retiredAt = retiredAt;
  });
  await mkdir(retiredRoot(coworkersDir), { recursive: true });
  await rename(root, target);
  return { slug, archiveId, path: target, retiredAt };
}

export async function listRetiredCoworkers(coworkersDir) {
  const root = retiredRoot(coworkersDir);
  if (!(await pathExists(root))) return [];
  const entries = await readdir(root, { withFileTypes: true });
  const retired = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[a-z0-9][a-z0-9-]*$/.test(entry.name)) continue;
    const archivePath = path.join(root, entry.name);
    try {
      const { data } = parseFrontmatter(await readFile(path.join(archivePath, COWORKER_CONFIG_FILE), "utf8"));
      const slug = typeof data.retiredSlug === "string" && /^[a-z0-9][a-z0-9-]*$/.test(data.retiredSlug)
        ? data.retiredSlug
        : entry.name.replace(/-\d{8,14}$/, "");
      retired.push({
        archiveId: entry.name,
        slug,
        name: typeof data.name === "string" && data.name.trim() ? data.name.trim() : slug,
        role: typeof data.role === "string" ? data.role : "",
        avatarColor: avatarColor(data.avatarColor),
        avatarGlasses: avatarGlasses(data.avatarGlasses),
        retiredAt: typeof data.retiredAt === "string" ? data.retiredAt : "",
        fileCount: await countFiles(archivePath),
        canRestore: !(await pathExists(path.join(coworkersDir, slug))),
      });
    } catch {
      // Not a coworker archive; leave it alone.
    }
  }
  retired.sort((a, b) => b.retiredAt.localeCompare(a.retiredAt));
  return retired;
}

/** Move a retired coworker home back into place. The workspace id is re-derived from the path by the server. */
export async function restoreCoworker(coworkersDir, archiveId) {
  const archivePath = retiredPath(coworkersDir, archiveId);
  const configPath = path.join(archivePath, COWORKER_CONFIG_FILE);
  if (!(await pathExists(configPath))) {
    throw new Error(`Retired coworker "${archiveId}" does not exist`);
  }
  const { data } = parseFrontmatter(await readFile(configPath, "utf8"));
  const slug = typeof data.retiredSlug === "string" ? data.retiredSlug : String(archiveId).replace(/-\d{8,14}$/, "");
  const root = coworkerPath(coworkersDir, slug);
  if (await pathExists(root)) {
    throw new Error(`A coworker named "${slug}" already exists. Retire or rename it before restoring this one.`);
  }
  await patchFrontmatter(configPath, (record) => {
    delete record.retiredSlug;
    delete record.retiredAt;
  });
  await rename(archivePath, root);
  return readCoworkerRecord(coworkersDir, slug);
}

/** Permanently remove a retired coworker archive. This is the only destructive step. */
export async function deleteRetiredCoworker(coworkersDir, archiveId) {
  const archivePath = retiredPath(coworkersDir, archiveId);
  await rm(archivePath, { recursive: true, force: true });
}

export async function readCoworkerFile(coworkersDir, slug, relativePath) {
  const target = resolveCoworkerFile(coworkersDir, slug, relativePath);
  return readFile(target, "utf8");
}

export async function writeCoworkerFile(coworkersDir, slug, relativePath, content) {
  const target = resolveCoworkerFile(coworkersDir, slug, relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, String(content ?? ""), "utf8");
}

/** The memory surface shown by the app: fixed files plus long-term entries. */
async function fileUpdatedAt(target) {
  try {
    return Math.floor((await stat(target)).mtimeMs);
  } catch {
    return 0;
  }
}

/**
 * The memory surface shown by the app: fixed files plus long-term entries,
 * each with its last-modified time so the UI can say when the coworker (or
 * its human) last touched memory without opening the file.
 */
export async function listMemoryFiles(coworkersDir, slug) {
  const root = coworkerPath(coworkersDir, slug);
  const files = [
    { id: "soul", label: "Soul", path: SOUL_FILE },
    { id: "working", label: "Working memory", path: WORKING_MEMORY_FILE },
    { id: "index", label: "Memory index", path: MEMORY_INDEX_FILE },
  ];
  const longTermRoot = path.join(root, LONG_TERM_DIR);
  if (await pathExists(longTermRoot)) {
    const entries = await readdir(longTermRoot, { withFileTypes: true });
    for (const entry of entries.filter((item) => item.isFile() && item.name.endsWith(".md")).sort((a, b) => a.name.localeCompare(b.name))) {
      files.push({
        id: `long-term/${entry.name}`,
        label: entry.name.replace(/\.md$/, ""),
        path: path.join(LONG_TERM_DIR, entry.name),
      });
    }
  }
  return Promise.all(
    files.map(async (file) => ({ ...file, updatedAt: await fileUpdatedAt(path.join(root, file.path)) })),
  );
}
