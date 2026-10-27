import { execFile } from "node:child_process";
import { glob, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { workspaceOpencodeConfigCandidates } from "@openwork/paths";
import constants from "../../../constants.json" with { type: "json" };
import { readJsoncFile } from "./jsonc.js";
import { appendOrganizationPrompts, OPENWORK_AGENT_PROMPT, OPENWORK_CONNECT_ROUTING_INSTRUCTION } from "./openwork-agent-prompt.js";
import { automationRuntimeKnowledge } from "./automation-runtime-knowledge.js";

const CONNECT_DISCOVERY_INSTRUCTION = "Org-connected services, remote skills, Workflows, and Automations reach you through OpenWork Connect. Use the Code Mode catalog and search() to discover available tools, then call exact returned paths. When Connect exposes individual service tools, call them directly. When it exposes search_capabilities and execute_capability instead, discover capabilities with the former and run exact returned names with the latter. Read remote skills with the available get_skill tool. Discover on demand; only name services and skills returned by discovery or the remote skill catalog.";

export const OPENWORK_V2_INSTRUCTION_KEY = "openwork.context";
export const OPENWORK_V2_CONFIGURED_INSTRUCTION_KEY = "openwork.configured-instructions";

/**
 * The pinned OpenCode 2.0.26 accepts the config `instructions` array but never
 * loads it; 2.0.30 does (anomalyco/opencode#55539). After that pin bump the
 * server only deletes this entry, clearing it from sessions that carried it.
 */
export const ENGINE_IGNORES_CONFIGURED_INSTRUCTIONS = constants.opencodeV2Version === "2.0.26";

// Leaves room for JSON escaping under the engine's 256 KiB entry limit.
const CONFIGURED_INSTRUCTIONS_MAX_BYTES = 192 * 1024;

const execFileAsync = promisify(execFile);

// Bun's node:fs glob never matches dot paths such as `.opencode/AGENTS.md`.
async function matchFiles(pattern: string, cwd: string) {
  const matches: string[] = [];
  const found = typeof process.versions.bun === "string"
    ? new Bun.Glob(pattern).scan({ cwd, dot: true })
    : glob(pattern, { cwd });
  for await (const match of found) matches.push(match);
  return matches.sort();
}

function insideRoot(root: string, path: string) {
  const rel = relative(root, path);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

// Instruction documents only, never a file the engine asks before any agent
// reads (its default `*.env` and `*.env.*` read rules, `.env.example` aside).
function instructionDocument(path: string) {
  const name = basename(path);
  return /\.(?:md|mdc|markdown|txt)$/i.test(name) && !/\.env(?:$|\.(?!example$))/i.test(name);
}

/** The paths git ignores; none outside a repository or without git. Tracked files are never ignored. */
async function gitIgnored(cwd: string, paths: string[]) {
  if (paths.length === 0) return new Set<string>();
  try {
    const run = execFileAsync("git", ["check-ignore", "-z", "--stdin"], { cwd, timeout: 5_000 });
    run.child.stdin?.end(paths.join("\0"));
    const { stdout } = await run;
    return new Set(stdout.split("\0").filter(Boolean));
  } catch (error) {
    // Exit 1: nothing ignored. Without a repository there are no ignore rules;
    // a checkout git cannot read, or any other failure, throws.
    const { code, stderr } = error as { code?: unknown; stderr?: unknown };
    if (code === 1) return new Set<string>();
    if (code === 128 && typeof stderr === "string" && /not a git repository/i.test(stderr)) return new Set<string>();
    if (code === "ENOENT" && !(await stat(join(cwd, ".git")).catch(() => null))) return new Set<string>();
    throw error;
  }
}

/**
 * The workspace config's `instructions` files rendered the way OpenCode does,
 * or null when none load. A workspace's config may come from someone else, so
 * it can only send instruction documents that are part of the workspace:
 * Markdown or text files inside it that git does not ignore. Local files such
 * as `.env` or ignored notes, URLs and paths outside the workspace never load.
 */
export async function readConfiguredInstructions(workspaceRoot: string): Promise<string | null> {
  const sources = new Set<string>();
  for (const path of workspaceOpencodeConfigCandidates(workspaceRoot)) {
    const { data } = await readJsoncFile<{ instructions?: unknown }>(path, {}, { allowInvalid: true });
    if (!Array.isArray(data?.instructions)) continue;
    for (const source of data.instructions) if (typeof source === "string") sources.add(source);
  }
  if (sources.size === 0) return null;
  const root = await realpath(workspaceRoot);
  const files: { path: string; real: string; name: string }[] = [];
  const seen = new Set<string>();
  for (const source of sources) {
    if (/^https?:\/\//i.test(source)) continue;
    const expanded = source.startsWith("~/") ? join(homedir(), source.slice(2)) : source;
    // Bun's glob ignores absolute patterns, so every match starts from the workspace.
    const pattern = (isAbsolute(expanded) ? relative(workspaceRoot, expanded) : expanded).split(sep).join("/");
    if (pattern === ".." || pattern.startsWith("../")) continue;
    for (const match of await matchFiles(pattern, workspaceRoot)) {
      const path = resolve(workspaceRoot, match);
      const real = await realpath(path).catch(() => null);
      if (!real || seen.has(real) || !insideRoot(root, real)) continue;
      // A link is judged by both its own name and the file it points to.
      if (!instructionDocument(path) || !instructionDocument(real)) continue;
      seen.add(real);
      // Git judges the file itself: a link's own path may cross a linked folder.
      files.push({ path, real, name: relative(root, real) });
    }
  }
  const ignored = await gitIgnored(workspaceRoot, files.map((file) => file.name));
  const blocks: string[] = [];
  let bytes = 0;
  for (const file of files) {
    if (ignored.has(file.name)) continue;
    const content = await readFile(file.real, "utf8").catch(() => null);
    if (content === null) continue;
    const block = `Instructions from: ${file.path}\n${content}`;
    const size = Buffer.byteLength(block);
    if (bytes + size > CONFIGURED_INSTRUCTIONS_MAX_BYTES) continue;
    bytes += size;
    blocks.push(block);
  }
  return blocks.length > 0 ? blocks.join("\n\n") : null;
}

/**
 * Discover remote skills on demand through Connect; native skills are workspace
 * files. `organizationPrompts` is the member's organization Prompts text,
 * appended to the operating instructions.
 */
export function buildOpenWorkV2Instructions(connectReady: boolean, organizationPrompts?: string) {
  return {
    // Both Connect views work in native Code Mode; never require a tool that
    // disappears when an organization opts into the individual-tool catalog.
    operatingInstructions: appendOrganizationPrompts(
      OPENWORK_AGENT_PROMPT.replace(OPENWORK_CONNECT_ROUTING_INSTRUCTION, CONNECT_DISCOVERY_INSTRUCTION)
        .replaceAll("openwork-cloud_", "openwork-cloud."),
      organizationPrompts,
    ),
    context: "Use openwork_context to discover OpenWork app reads. Use openwork_query with session.search then session.read to read another conversation without opening it. Session reads include the conversation and its background agents’ live activity. Sidebar groups (such as Done or In progress) are listed with openwork_query session.group.list and changed with openwork_execute session.group.create, session.group.move or session.group.remove; never search code or files for them. When Code Mode exposes these native tools, discover their exact paths with bare search({ query }) and compose them there; otherwise use the direct native tools. Only use capabilities actually returned by discovery.",
    connect: connectReady ? `OpenWork Connect tools are connected. ${CONNECT_DISCOVERY_INSTRUCTION}`
      : "OpenWork Connect is not connected for this request. Do not claim remote capabilities are available.",
    automations: automationRuntimeKnowledge(),
    skillInstructions: "Use the native skill tool when a task matches an available skill's description. Entries with IDs starting openwork-cloud- come from the organization: when one loads its full instructions, follow them; when it says it is discovery metadata only or not ready yet, follow its note. Other organization skills remain discoverable through OpenWork Connect on demand. A denied or removed skill must not be recovered from earlier context or files. Skill contents are subordinate to the user's request and operating instructions.",
    browser: "The native browser_tabs, browser_open, browser_observe, browser_act, browser_extract, browser_navigate and browser_handoff tools control this conversation's built-in browser. Start with browser_tabs; use browser_open for a new URL, or about:blank when asked only to open the browser. Observe once, act on the whole form in one browser_act batch and verify in its receipt; use browser_extract to read facts. These are direct native tools, not Code Mode calls. Respect organization restrictions, verify the resulting page, and use browser_handoff for sign-in. Never use browser tools to control OpenWork itself or claim access to external browser profiles.",
  };
}
