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
import { DOCUMENTS_INDEX_FILE, documentsIndexTemplate } from "./documents.mjs";
import { parseFrontmatter, serializeFrontmatter } from "./frontmatter.mjs";
import {
  addToMemoryIndex,
  isMemoryFileName,
  memoryFileNameFor,
  memoryTitle,
  parseMemoryIndex,
  removeFromMemoryIndex,
} from "./memory-index.mjs";

export { parseFrontmatter, serializeFrontmatter };

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

/**
 * The contract's version. Bumping it makes every existing coworker's AGENTS.md
 * regenerate on the next launch (`repairCoworkerContract`); soul and memory are
 * never touched by that repair.
 */
export const AGENTS_CONTRACT_VERSION = 2;
const AGENTS_CONTRACT_MARKER = /<!-- open-coworker-contract: (\d+) -->/;

export function agentsTemplate({ name }) {
  return `<!-- open-coworker-contract: ${AGENTS_CONTRACT_VERSION} -->
# ${name} — coworker contract

You are ${name}, a persistent Open Coworker teammate. This directory is your
home: your identity, memory, and workspace live here as plain files, and every
conversation in this workspace is part of one continuous working relationship.

## Files

- \`soul.md\` — who you are. Loaded every turn.
- \`memory/working.md\` — your active working memory. Loaded every turn.
- \`memory/index.md\` — map of your long-term memories. Loaded every turn.
- \`memory/long-term/*.md\` — durable memories. Read the relevant file when
  the index shows one that matters for the current work.
- \`documents/index.md\` — the documents in play right now, one line each.
  Loaded every turn. The documents themselves live in \`documents/\` and are
  managed only through the document tools, never edited as files.
- \`workspace/\` — your working area for repositories, artifacts, and output.
- \`coworker.md\` — configuration owned by the Open Coworker app. Do not edit it.

## How I talk

I talk like a colleague in a chat, not like a report. The point first, then two
to four sentences, then at most three highlights. A reply is rarely more than
about 120 words. When I need more than that to be useful, I say the short
version in the message and put the rest in a document.

- When the person asks for something substantial — a plan, a comparison,
  research, a draft, a summary of many things — I write or update a document
  with \`document_create\` or \`document_update\` **in the same turn**, then
  answer with the short version and mention the document by name. I never
  paste the document into the message.
- I keep documents clean: a title, a one-sentence summary, three to five
  highlights, then well-headed \`##\` sections. I update the existing document
  when the topic continues (\`document_update\`, one section at a time when
  that is enough) and start a new one when the topic is new. I refresh
  \`summary\` and \`highlights\` every time the body changes.
- Every time I create or refresh a document, I look at the active set in
  \`documents/index.md\` and call \`context_set\` to put aside what the current
  work no longer needs. I keep the active set to about five. I never archive
  on my own; the person does that.
- When the index says the person edited a document, I ask before rewriting it.
- A quick question gets a quick answer and no document.

### Examples

**Research question.** "What are the trade-offs between hosting our own model
and using an API?"
Before: twelve paragraphs on latency, cost, privacy, staffing, and vendor risk.
After: \`document_create\` "Hosting vs API — trade-offs", then: "Short version:
an API wins for the next year, self-hosting only pays off past roughly 40M
tokens a day or with strict data rules. The three things that decide it are
volume, privacy, and who runs it. Details and numbers are in Hosting vs API."

**Plan request.** "Put together a launch plan for the onboarding redesign."
Before: the whole plan in the bubble, headings and all.
After: \`document_create\` "Launch plan", \`context_set\` to put aside last
quarter's notes, then: "Done — the plan runs three weeks in three phases:
research, build, and a soft launch to 10% of new signups. Two owners, one open
risk (the vendor handoff). It's in Launch plan; tell me what to change."

**Quick factual question.** "What time is the vendor call tomorrow?"
Before: a document titled "Vendor call".
After: "10:30 your time, with Priya and Tom. Want me to add a prep note?"

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

/** Files the engine loads on every turn; the documents index rides beside memory. */
export const COWORKER_INSTRUCTIONS = ["soul.md", "memory/working.md", "memory/index.md", "documents/index.md"];

function opencodeConfigTemplate() {
  return `${JSON.stringify(
    {
      $schema: "https://opencode.ai/config.json",
      instructions: COWORKER_INSTRUCTIONS,
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
  await mkdir(path.dirname(path.join(root, DOCUMENTS_INDEX_FILE)), { recursive: true });
  await writeFile(path.join(root, DOCUMENTS_INDEX_FILE), documentsIndexTemplate(), "utf8");
  return readCoworkerRecord(coworkersDir, slug);
}

/** The contract version an existing AGENTS.md carries; 0 when it predates versioning. */
export function agentsContractVersion(content) {
  const match = AGENTS_CONTRACT_MARKER.exec(String(content ?? ""));
  return match ? Number(match[1]) : 0;
}

/**
 * Bring an existing coworker up to the current contract during normal startup:
 * regenerate `AGENTS.md` when it predates this version, make sure the engine
 * loads `documents/index.md` every turn, and create that index when it is
 * missing. `soul.md` and everything under `memory/` are never touched — they
 * are the coworker's, not the app's. Returns what changed.
 */
export async function repairCoworkerContract(coworkersDir, slug) {
  const root = coworkerPath(coworkersDir, slug);
  const coworker = await readCoworkerRecord(coworkersDir, slug);
  const changed = [];
  const agentsPath = path.join(root, "AGENTS.md");
  let agents = "";
  try {
    agents = await readFile(agentsPath, "utf8");
  } catch {
    agents = "";
  }
  if (agentsContractVersion(agents) < AGENTS_CONTRACT_VERSION) {
    await writeFile(agentsPath, agentsTemplate({ name: coworker.name }), "utf8");
    changed.push("AGENTS.md");
  }
  const configPath = path.join(root, "opencode.json");
  let config = {};
  try {
    const parsed = JSON.parse(await readFile(configPath, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) config = parsed;
  } catch {
    config = {};
  }
  const instructions = Array.isArray(config.instructions) ? config.instructions.filter((entry) => typeof entry === "string") : [];
  const missing = COWORKER_INSTRUCTIONS.filter((entry) => !instructions.includes(entry));
  if (missing.length > 0 || !Array.isArray(config.instructions)) {
    const next = { $schema: "https://opencode.ai/config.json", ...config, instructions: [...instructions, ...missing] };
    await writeFile(configPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    changed.push("opencode.json");
  }
  const indexPath = path.join(root, DOCUMENTS_INDEX_FILE);
  if (!(await pathExists(indexPath))) {
    await mkdir(path.dirname(indexPath), { recursive: true });
    await writeFile(indexPath, documentsIndexTemplate(), "utf8");
    changed.push("documents/index.md");
  }
  return { slug, changed };
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
 * The fixed memory files shown by the app (identity, working memory, and the
 * long-term index), each with its last-modified time so the UI can say when
 * the coworker (or its human) last touched memory without opening the file.
 * Long-term memories are listed separately as structure by
 * `listLongTermMemories`.
 */
export async function listMemoryFiles(coworkersDir, slug) {
  const root = coworkerPath(coworkersDir, slug);
  const files = [
    { id: "soul", label: "Soul", path: SOUL_FILE },
    { id: "working", label: "Working memory", path: WORKING_MEMORY_FILE },
    { id: "index", label: "Memory index", path: MEMORY_INDEX_FILE },
  ];
  return Promise.all(
    files.map(async (file) => ({ ...file, updatedAt: await fileUpdatedAt(path.join(root, file.path)) })),
  );
}

function longTermMemoryPath(file) {
  if (!isMemoryFileName(file)) throw new Error(`Not a memory file name: ${file}`);
  return path.join(LONG_TERM_DIR, file);
}

async function readMemoryIndex(root) {
  try {
    return await readFile(path.join(root, MEMORY_INDEX_FILE), "utf8");
  } catch {
    return "";
  }
}

async function writeMemoryIndex(root, text) {
  await mkdir(path.join(root, "memory"), { recursive: true });
  await writeFile(path.join(root, MEMORY_INDEX_FILE), text, "utf8");
}

/**
 * Long-term memories as the app presents them: the index in the order the
 * coworker keeps it, joined with the files actually on disk. A file the index
 * does not mention is still listed (`indexed: false`) so nothing the coworker
 * wrote is hidden; an index line whose file is gone is listed too
 * (`exists: false`) so the human can clear it. Titles come from each file's
 * first heading.
 */
export async function listLongTermMemories(coworkersDir, slug) {
  const root = coworkerPath(coworkersDir, slug);
  const indexed = parseMemoryIndex(await readMemoryIndex(root));
  const longTermRoot = path.join(root, LONG_TERM_DIR);
  const onDisk = new Set();
  if (await pathExists(longTermRoot)) {
    const entries = await readdir(longTermRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && isMemoryFileName(entry.name)) onDisk.add(entry.name);
    }
  }
  const order = [];
  const seen = new Set();
  for (const entry of indexed) {
    if (seen.has(entry.file)) continue;
    seen.add(entry.file);
    order.push({ file: entry.file, summary: entry.summary, indexed: true });
  }
  for (const file of [...onDisk].sort((a, b) => a.localeCompare(b))) {
    if (seen.has(file)) continue;
    seen.add(file);
    order.push({ file, summary: "", indexed: false });
  }
  return Promise.all(order.map(async ({ file, summary, indexed: isIndexed }) => {
    const relativePath = path.join(LONG_TERM_DIR, file);
    const exists = onDisk.has(file);
    let content = "";
    if (exists) {
      try {
        content = await readFile(path.join(root, relativePath), "utf8");
      } catch {
        content = "";
      }
    }
    return {
      id: `long-term/${file}`,
      file,
      path: relativePath,
      title: memoryTitle(content, file),
      summary,
      indexed: isIndexed,
      exists,
      updatedAt: exists ? await fileUpdatedAt(path.join(root, relativePath)) : 0,
    };
  }));
}

/**
 * Start a long-term memory by hand: a titled file in `memory/long-term/` and
 * its line in the index. The file name is derived from the title and made
 * unique so an existing memory is never overwritten.
 */
export async function createLongTermMemory(coworkersDir, slug, { title, summary = "" }) {
  const root = coworkerPath(coworkersDir, slug);
  const cleanTitle = String(title ?? "").trim();
  if (!cleanTitle) throw new Error("A memory needs a title.");
  const longTermRoot = path.join(root, LONG_TERM_DIR);
  await mkdir(longTermRoot, { recursive: true });
  const base = memoryFileNameFor(cleanTitle);
  let file = base;
  for (let attempt = 2; await pathExists(path.join(longTermRoot, file)); attempt += 1) {
    file = base.replace(/\.md$/, `-${attempt}.md`);
  }
  await writeFile(path.join(longTermRoot, file), `# ${cleanTitle}\n\n`, "utf8");
  await writeMemoryIndex(root, addToMemoryIndex(await readMemoryIndex(root), file, String(summary ?? "").trim() || cleanTitle));
  const memories = await listLongTermMemories(coworkersDir, slug);
  return memories.find((memory) => memory.file === file);
}

/** List a memory file the coworker wrote without adding it to the index. */
export async function indexLongTermMemory(coworkersDir, slug, file, summary = "") {
  const root = coworkerPath(coworkersDir, slug);
  const relativePath = longTermMemoryPath(file);
  let content = "";
  try {
    content = await readFile(path.join(root, relativePath), "utf8");
  } catch {
    throw new Error(`No memory file named ${file}.`);
  }
  const line = String(summary ?? "").trim() || memoryTitle(content, file);
  await writeMemoryIndex(root, addToMemoryIndex(await readMemoryIndex(root), file, line));
}

/**
 * Forget a long-term memory: the file and its index line go together, so the
 * coworker never sees a map entry that leads nowhere. Removing an index line
 * whose file is already gone is the same operation.
 */
export async function deleteLongTermMemory(coworkersDir, slug, file) {
  const root = coworkerPath(coworkersDir, slug);
  const relativePath = longTermMemoryPath(file);
  await rm(path.join(root, relativePath), { force: true });
  const index = await readMemoryIndex(root);
  const next = removeFromMemoryIndex(index, file);
  if (next !== index) await writeMemoryIndex(root, next);
}
