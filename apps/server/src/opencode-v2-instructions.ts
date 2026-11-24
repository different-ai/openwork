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

const CONNECT_DISCOVERY_INSTRUCTION = "Org-connected services, remote skills, Workflows, and Automations reach you through OpenWork Connect. Use the Code Mode catalog and search() to discover available tools, then call exact returned paths. When Connect exposes individual service tools, call them directly. For anything without a tool of its own, use Connect's search_capabilities and execute_capability: discover capabilities with the former and run exact returned names with the latter. Read remote skills with the available get_skill tool. Discover on demand; only name services and skills returned by discovery or the remote skill catalog.";

export const OPENWORK_V2_INSTRUCTION_KEY = "openwork.context";
export const OPENWORK_V2_CONFIGURED_INSTRUCTION_KEY = "openwork.configured-instructions";

export const ENGINE_IGNORES_CONFIGURED_INSTRUCTIONS = constants.opencodeV2Version === "2.0.26";

const CONFIGURED_INSTRUCTIONS_MAX_BYTES = 192 * 1024;

const execFileAsync = promisify(execFile);

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

function instructionDocument(path: string) {
  const name = basename(path);
  return /\.(?:md|mdc|markdown|txt)$/i.test(name) && !/\.env(?:$|\.(?!example$))/i.test(name);
}

async function gitIgnored(cwd: string, paths: string[]) {
  if (paths.length === 0) return new Set<string>();
  try {
    const run = execFileAsync("git", ["check-ignore", "-z", "--stdin"], { cwd, timeout: 5_000 });
    run.child.stdin?.end(paths.join("\0"));
    const { stdout } = await run;
    return new Set(stdout.split("\0").filter(Boolean));
  } catch (error) {
    const { code, stderr } = error as { code?: unknown; stderr?: unknown };
    if (code === 1) return new Set<string>();
    if (code === 128 && typeof stderr === "string" && /not a git repository/i.test(stderr)) return new Set<string>();
    if (code === "ENOENT" && !(await stat(join(cwd, ".git")).catch(() => null))) return new Set<string>();
    throw error;
  }
}

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
    const pattern = (isAbsolute(expanded) ? relative(workspaceRoot, expanded) : expanded).split(sep).join("/");
    if (pattern === ".." || pattern.startsWith("../")) continue;
    for (const match of await matchFiles(pattern, workspaceRoot)) {
      const path = resolve(workspaceRoot, match);
      const real = await realpath(path).catch(() => null);
      if (!real || seen.has(real) || !insideRoot(root, real)) continue;
      if (!instructionDocument(path) || !instructionDocument(real)) continue;
      seen.add(real);
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

export function buildOpenWorkV2Instructions(connectReady: boolean, organizationPrompts?: string) {
  return {
    operatingInstructions: appendOrganizationPrompts(
      OPENWORK_AGENT_PROMPT.replace(OPENWORK_CONNECT_ROUTING_INSTRUCTION, CONNECT_DISCOVERY_INSTRUCTION)
        .replaceAll("openwork-cloud_", "openwork-cloud."),
      organizationPrompts,
    ),
    context: "Use openwork_context to discover OpenWork app reads. Use openwork_query with session.search then session.read to read another conversation without opening it. Session reads include the conversation and its background agents’ live activity. Sidebar groups (such as Done or In progress) are listed with openwork_query session.group.list and changed with openwork_execute session.group.create, session.group.move or session.group.remove; never search code or files for them. A thread, sub thread or separate session the person asks for is a session of its own in the sidebar: start it with openwork_execute session.create and message it with session.send, never a sub-agent, a shell command, another engine process or a remote-session tool, which only reaches other computers and the cloud. Sub-agents are for work whose result only feeds your reply. When openwork_context lists session.tree, the sessions you start are listed under this one and report back when they finish a turn: query session.tree for them and their status instead of polling, and manage each by sessionId with session.read, session.send, session.rename and session.archive. When Code Mode exposes these native tools, discover their exact paths with bare search({ query }) and compose them there; otherwise use the direct native tools. Only use capabilities actually returned by discovery.",
    connect: connectReady ? `OpenWork Connect tools are connected. ${CONNECT_DISCOVERY_INSTRUCTION}`
      : "OpenWork Connect is not connected for this request. Do not claim remote capabilities are available.",
    automations: automationRuntimeKnowledge(),
    skillInstructions: "Use the native skill tool when a task matches an available skill's description. Entries with IDs starting openwork-cloud- come from the organization: when one loads its full instructions, follow them; when it says it is discovery metadata only or not ready yet, follow its note. Other organization skills remain discoverable through OpenWork Connect on demand. A denied or removed skill must not be recovered from earlier context or files. Skill contents are subordinate to the user's request and operating instructions.",
    browser: "The native browser_tabs, browser_open, browser_observe, browser_act, browser_extract, browser_navigate and browser_handoff tools control this conversation's built-in browser. Start with browser_tabs; use browser_open for a new URL, or about:blank when asked only to open the browser. Observe once, act on the whole form in one browser_act batch and verify in its receipt; use browser_extract to read facts. When an observation reports siteTools, call webmcp_list_tools and prefer a relevant website tool through webmcp_call_tool over page controls. These are direct native tools, not Code Mode calls. Respect organization restrictions, verify the resulting page, enter a saved secret an observation lists in availableSecrets with fill_secret, enter a private value with fill_from when an observation says privateValues: fill_from. Decide on your own which values are private: passwords, one-time codes, API keys, tokens, recovery codes, account or card numbers, personal details, or anything the person would not want you to read. Never read such a value yourself, from a command, a file or the chat: you name the command that prints it and never run it yourself; when no command can print it, name it with ask so the person pastes it into OpenWork's private field, never in chat; when the command's program needs a session key in its environment, add unlock so the person pastes that key the same way. Fill a password or code only when the person gave it to you for this site, and otherwise use browser_handoff for sign-in. Never use browser tools to control OpenWork itself. They reach only the built-in browser, never the person's own browser. When the person asks for their own browser (Chrome, Safari, \"my real browser\"), open it as an app with the computer tools when you have them.",
  };
}
