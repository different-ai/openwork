/**
 * The coordinator: an app-owned, hidden workspace where the silent facilitator
 * of every group chat runs. It lives under the coworkers home as
 * `.coordinator/` — no `coworker.md`, so it never appears in the rail,
 * discussions, or Activity — with every tool switched off, no MCP servers, and
 * no memory files. It only ever reads what it is told and answers with JSON.
 *
 * No Electron imports here: this module is exercised directly by
 * `node --test electron/coordinator.test.mjs`.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export const COORDINATOR_DIR = ".coordinator";
export const COORDINATOR_SCHEMA_VERSION = 1;
const RECORD_FILE = "coordinator.json";

/** Every built-in tool the engine could offer, switched off by name as well as by wildcard. */
const BUILT_IN_TOOLS = ["bash", "edit", "write", "read", "glob", "grep", "list", "patch", "multiedit", "todowrite", "todoread", "webfetch", "websearch", "task", "skill", "question", "lsp"];

export function coordinatorPath(coworkersDir) {
  return path.join(coworkersDir, COORDINATOR_DIR);
}

export function coordinatorConfig() {
  const tools = { "*": false };
  for (const tool of BUILT_IN_TOOLS) tools[tool] = false;
  return {
    $schema: "https://opencode.ai/config.json",
    instructions: [],
    permission: "deny",
    tools,
    mcp: {},
  };
}

export function coordinatorContract() {
  return `# Coordinator

You decide who in a group chat should answer the person's message, and in what
order. You never answer the person yourself, never speak in the group, and have
no tools. Every reply is one JSON object and nothing else: no prose, no code
fences, no explanation.
`;
}

async function readRecord(coworkersDir) {
  try {
    const raw = JSON.parse(await readFile(path.join(coordinatorPath(coworkersDir), RECORD_FILE), "utf8"));
    return { schemaVersion: COORDINATOR_SCHEMA_VERSION, workspaceId: typeof raw?.workspaceId === "string" ? raw.workspaceId : "" };
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function writeRecord(coworkersDir, record) {
  const target = path.join(coordinatorPath(coworkersDir), RECORD_FILE);
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, `${JSON.stringify({ schemaVersion: COORDINATOR_SCHEMA_VERSION, ...record }, null, 2)}\n`, "utf8");
  await rename(temp, target);
  return record;
}

/**
 * Make sure the coordinator home exists with its locked-down configuration.
 * The configuration files are rewritten every time so a hand edit can never
 * quietly hand the facilitator a tool; the record (its workspace id) is kept.
 */
export async function ensureCoordinatorHome(coworkersDir) {
  const root = coordinatorPath(coworkersDir);
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, "opencode.json"), `${JSON.stringify(coordinatorConfig(), null, 2)}\n`, "utf8");
  await writeFile(path.join(root, "AGENTS.md"), coordinatorContract(), "utf8");
  const existing = await readRecord(coworkersDir);
  const record = existing ?? (await writeRecord(coworkersDir, { workspaceId: "" }));
  return { path: root, name: "Coordinator", workspaceId: record.workspaceId };
}

export async function readCoordinator(coworkersDir) {
  const record = await readRecord(coworkersDir);
  return record ? { path: coordinatorPath(coworkersDir), name: "Coordinator", workspaceId: record.workspaceId } : null;
}

export async function updateCoordinator(coworkersDir, { workspaceId }) {
  await mkdir(coordinatorPath(coworkersDir), { recursive: true });
  const record = await writeRecord(coworkersDir, { workspaceId: typeof workspaceId === "string" ? workspaceId : "" });
  return { path: coordinatorPath(coworkersDir), name: "Coordinator", workspaceId: record.workspaceId };
}
