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
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
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

function avatarColor(value) {
  return AVATAR_COLORS.has(value) ? value : "blue";
}

function avatarGlasses(value) {
  return AVATAR_GLASSES.has(value) ? value : "round";
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

function coworkerConfigTemplate({ name, role, mission, avatarColor: color, avatarGlasses: glasses, createdAt }) {
  return serializeFrontmatter(
    {
      name,
      role: role || "",
      mission: mission || "",
      avatarColor: avatarColor(color),
      avatarGlasses: avatarGlasses(glasses),
      workspaceId: "",
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
    workspaceId: typeof data.workspaceId === "string" ? data.workspaceId.trim() : "",
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
    coworkerConfigTemplate({ name, role, mission, avatarColor: color, avatarGlasses: glasses, createdAt }),
    "utf8",
  );
  await writeFile(path.join(root, SOUL_FILE), soulTemplate({ name, role, mission }), "utf8");
  await writeFile(path.join(root, "AGENTS.md"), agentsTemplate({ name }), "utf8");
  await writeFile(path.join(root, "opencode.json"), opencodeConfigTemplate(), "utf8");
  await writeFile(path.join(root, WORKING_MEMORY_FILE), workingMemoryTemplate(name), "utf8");
  await writeFile(path.join(root, MEMORY_INDEX_FILE), memoryIndexTemplate(), "utf8");
  return readCoworkerRecord(coworkersDir, slug);
}

/** Patch platform references (workspaceId, automations, model) inside coworker.md. */
export async function updateCoworker(coworkersDir, slug, patch) {
  const root = coworkerPath(coworkersDir, slug);
  const configPath = path.join(root, COWORKER_CONFIG_FILE);
  const { data, body } = parseFrontmatter(await readFile(configPath, "utf8"));
  if (typeof patch?.workspaceId === "string") data.workspaceId = patch.workspaceId.trim();
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
  await writeFile(configPath, serializeFrontmatter(data, body), "utf8");
  return readCoworkerRecord(coworkersDir, slug);
}

export async function deleteCoworker(coworkersDir, slug) {
  const root = coworkerPath(coworkersDir, slug);
  await rm(root, { recursive: true, force: true });
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
  return files;
}
