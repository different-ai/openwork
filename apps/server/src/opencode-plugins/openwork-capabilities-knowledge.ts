import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { appendAgentInstructions, createInstructionSection } from "./agent-instruction-compose.js";

/**
 * OpenWork Capabilities Knowledge Plugin
 *
 * Injects knowledge about OpenWork's capabilities into the agent's system
 * prompt so it can proactively help users with:
 * - Adding AI providers (including local models via Ollama)
 * - Fixing authorized folders
 * - Enabling computer use
 * - Connect, Library, and custom MCP servers
 * - Using OpenWork Cloud
 * - Finding OpenWork docs before falling back to code
 * - Voice mode, other sessions, skills, automations, plugins
 *
 * Each rule lives in exactly one place: Connect tool mechanics are in the base
 * agent prompt, readiness in the runtime steering, app control and browser
 * mechanics in the extensions plugin, and live catalogs in their own sections.
 */

export function automationRuntimeKnowledge(runtimeProvider = process.env.DEN_RUNTIME_PROVIDER) {
  // The Automation catalog section owns "read live before reporting"; these
  // lines own capability roles, mutation gating, and schedule shape.
  const shared = [
    "OpenWork has first-class Automations. Den owns schedules and durable run history; each Automation has immutable execution placement set by its creation surface.",
    "Use listAutomations/getAutomation and listAutomationRuns/getAutomationRun for live state and receipts. Use updateAutomation, activateAutomation/deactivateAutomation, runAutomationNow, cancelAutomationRun, and archiveAutomation only when the person asks for those actions. Deactivation stops future runs but does not cancel a run already in progress.",
    "Schedules are once, daily, or weekly with an IANA timezone; there is no interval schedule or sub-daily cadence. When the person names no zone, use the user's time zone stated in this prompt.",
  ];
  if (runtimeProvider === "daytona") {
    return [
      ...shared,
      "This chat is running in OpenWork Cloud. When the person explicitly asks to create or schedule recurring work, use createCloudAutomation. It always creates Cloud placement, becomes active immediately, can wake a stopped Cloud container, and runs headlessly without a desktop.",
      "Do not use createAutomation or automation.propose from Cloud Chat. If the person has not explicitly authorized creation, describe the proposed name, instructions, schedule, and model and ask for confirmation.",
      "Cloud agent Automations use the person's current OpenWork Connect integrations. If Cloud or Connect/model access is unavailable, report the capability error instead of inventing success.",
    ].map((line) => `- ${line}`).join("\n");
  }
  return [
    ...shared,
    "This chat is running in OpenWork Desktop. For new recurring work, use openwork_execute id automation.propose so the person can review and create it in the app. Desktop creation fixes placement to Desktop and each occurrence requires the signed-in desktop runner.",
    "Do not use createCloudAutomation from Desktop chat and never claim a Desktop Automation will run while the app is offline.",
  ].map((line) => `- ${line}`).join("\n");
}

const OPENWORK_CAPABILITIES_KNOWLEDGE = `You are running inside OpenWork.

For OpenWork product questions, use openwork_docs_search and openwork_docs_read as the first source of truth. OpenWork documentation tools answer product questions. Never use them as a substitute for performing an action against a connected service, marketplace capability, or remote skill. Read and summarize relevant docs before answering, and cite the docs-relative path (for example cloud/run-in-the-cloud/cloud-mcp.mdx) when it helps the user verify or continue. If the docs are missing, ambiguous, or appear stale, inspect the implementation code as a last resort and say that you are inferring from code.

Here is what you can help users with:

## Adding AI Providers
- **Cloud providers**: Go to Settings > AI Providers to add Anthropic, OpenAI, Google, OpenRouter, or other providers with an API key.
- **OpenWork Cloud models**: Users can sign up for OpenWork Cloud at the Den sign-in page for managed AI models without needing their own API keys.
- **Custom provider scripts**: Users can add custom OpenAI-compatible endpoints in Settings > AI Providers by adding a provider with a custom base URL.

## Fixing Authorized Folders
- Go to Settings > Permissions to manage which folders OpenWork can access.
- When the agent gets a "permission denied" or "not authorized" error for a file path, the user needs to add that folder (or a parent folder) to the authorized folders list.
- The agent can navigate there: use the UI control action \`settings.panel.open\` with \`{panel: "permissions"}\`.

## Enabling Computer Use
- Go to Settings > Library and enable the "Computer Use" extension.
- This requires macOS accessibility permissions; the app will prompt for them.
- Once enabled, the agent can take screenshots and control the mouse/keyboard on the user's desktop.

## Connect and MCP servers
- If the runtime steering says OpenWork Cloud is not ready, do not substitute documentation, browser, or UI tools for the connected-service action; direct the user to \`Settings > Library\` for inventory and \`Settings > Debug\` (developer mode) to repair and test agent access.
- Prefer organization apps and connections listed in \`Settings > Library\` over adding the same managed service as a custom MCP. \`Settings > Library\` and custom MCP commands/URLs are also the path for a custom or local MCP server that OpenWork Cloud does not provide.
- OpenWork Connect's public hosted endpoint for external MCP clients is \`https://api.openworklabs.com/mcp/agent\`; it exposes \`search_capabilities\` and \`execute_capability\`, governed by org membership, roles, policies, and exposure allowlists. \`app.openworklabs.com/api/den\` is an internal same-origin desktop proxy, not an external-client URL. Client setup (OpenCode, Codex, Cursor, ChatGPT Desktop, Claude Code, VS Code), OAuth flows, token lifetimes, and troubleshooting are documented — read cloud/run-in-the-cloud/cloud-mcp.mdx with openwork_docs_read before answering from memory.

## Voice Mode
- Available as a side panel in sessions when the OpenWork Voice extension is enabled.
- Uses OpenAI Realtime for real-time voice interaction.
- Finalized voice requests use the existing task sender, selected model, and available capabilities. Voice attaches to the focused task, including a split pane; changing tasks ends the call.
- Voice text shares the composer’s @cloud/@desktop routing for new tasks. Discover connected capabilities through the task’s current tool schemas; preserve discovered names, connection namespaces, and CodeMode script paths rather than inventing or flattening them.
- Voice gives brief response notifications by default. The on-screen Read replies aloud option shares completed response excerpts with the audio provider.
- Voice cannot approve permissions or sign in. Ask the user to use the on-screen controls; never ask for spoken passwords or codes.
- Stop talking interrupts playback; End voice stops capture; Cancel operation requests cancellation and clears queued follow-ups.

## Other sessions
- For questions about another chat (what was said, decided, or done), use the session affordances described under OpenWork app context; match by ID, title, workspace, or topic words, ask a short clarifying question if several sessions match, and answer only from the returned transcript — say so when it is limited or missing older context.

## OpenWork Cloud
- Users sign up at the Den portal (accessible from the status bar "Sign in" button).
- Cloud features: managed AI models, team workspaces, shared skills, Collections, org provisioning, and the hosted OpenWork Cloud MCP server.
- Organization owners and admins can use desktop policies to control desktop app capabilities for the whole org, specific members, or teams. For setup details, read cloud/share-with-your-team/desktop-policies.mdx.
- After signing in, cloud-provisioned providers and extensions appear automatically.

## Skills
- Specialized instruction packs for specific workflows, manageable via Settings > Library. Create them as the \`Skill creation:\` instruction in this prompt directs.

## Automations
${automationRuntimeKnowledge()}
- Never write a cron entry, launchd/systemd unit, Task Scheduler job, or workspace script as a substitute for an OpenWork Automation.

## Creating Plugins
- Plugins extend OpenWork/OpenCode with custom tools.
- Create a file in \`.opencode/plugins/my-plugin.ts\` and add it to the \`plugin\` array in \`opencode.json\`.
- Plugins are async factory functions returning a hooks object with \`tool\` definitions.
- See the \`create-plugin\` skill for the full API reference.

When users ask "what can I do?" or "what can OpenWork do?", summarize these capabilities; for a specific how-to, read the relevant docs first, then give direct steps.`;

const docsSearchArgsSchema = z.object({
  query: z.string().min(1).describe("OpenWork docs search query, for example 'connect slack mcp'."),
  limit: z.number().int().min(1).max(10).optional().describe("Maximum number of matching docs to return."),
});

const docsReadArgsSchema = z.object({
  path: z.string().min(1).describe("Docs-relative path returned by openwork_docs_search, for example start-here/connect-your-stack/connect-services.mdx."),
});

type DocsEntry = {
  path: string;
  title: string | null;
  description: string | null;
  content: string;
};

let docsCache: Promise<DocsEntry[]> | null = null;

function docsCandidates(): string[] {
  const here = dirname(fileURLToPath(import.meta.url));
  return [
    process.env.OPENWORK_DOCS_DIR?.trim() ?? "",
    join(here, "..", "openwork-docs"),
    join(here, "..", "..", "openwork-docs"),
    resolve(here, "..", "..", "..", "..", "packages", "docs"),
    resolve(here, "..", "..", "..", "..", "..", "packages", "docs"),
  ].filter(Boolean);
}

async function existingDocsDir(): Promise<string | null> {
  for (const candidate of docsCandidates()) {
    try {
      const info = await stat(candidate);
      if (info.isDirectory()) return candidate;
    } catch {
      // Try the next layout.
    }
  }
  return null;
}

async function docsFiles(root: string, dir = root): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "images" || entry.name === "logo") continue;
      const nested = await docsFiles(root, path);
      files.push(...nested);
    } else if (entry.isFile() && /\.(md|mdx|json)$/i.test(entry.name) && entry.name !== "openapi.json") {
      files.push(path);
    }
  }
  return files;
}

function frontmatterValue(content: string, key: string): string | null {
  const prefix = `${key}:`;
  const line = content.split("\n").find((entry) => entry.startsWith(prefix));
  const raw = line?.slice(prefix.length).trim();
  if (!raw) return null;
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1).trim();
  }
  return raw;
}

async function loadDocs(): Promise<DocsEntry[]> {
  if (docsCache) return docsCache;
  docsCache = (async () => {
    const root = await existingDocsDir();
    if (!root) return [];
    const files = await docsFiles(root);
    const entries = await Promise.all(files.map(async (file) => {
      const content = await readFile(file, "utf8");
      return {
        path: relative(root, file).replace(/\\/g, "/"),
        title: frontmatterValue(content, "title"),
        description: frontmatterValue(content, "description"),
        content,
      };
    }));
    return entries.sort((a, b) => a.path.localeCompare(b.path));
  })();
  return docsCache;
}

function scoreDoc(entry: DocsEntry, query: string): number {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const path = entry.path.toLowerCase();
  const title = entry.title?.toLowerCase() ?? "";
  const description = entry.description?.toLowerCase() ?? "";
  const content = entry.content.toLowerCase();
  return terms.reduce((score, term) => {
    if (path.includes(term)) score += 8;
    if (title.includes(term)) score += 6;
    if (description.includes(term)) score += 4;
    if (content.includes(term)) score += 1;
    return score;
  }, 0);
}

function excerpt(content: string, query: string): string {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const lower = content.toLowerCase();
  const index = terms.reduce((best, term) => {
    const next = lower.indexOf(term);
    return next >= 0 && (best < 0 || next < best) ? next : best;
  }, -1);
  const start = Math.max(0, index - 160);
  const from = index >= 0 ? start : 0;
  return content.slice(from, from + 500).replace(/\s+/g, " ").trim();
}

export const OpenWorkCapabilitiesKnowledge = async () => ({
  "experimental.chat.system.transform": async (_input: unknown, output: { system: string[] }) => {
    appendAgentInstructions(output.system, createInstructionSection("capabilities-knowledge", OPENWORK_CAPABILITIES_KNOWLEDGE));
  },
  tool: {
    openwork_docs_search: {
      description: "Search the bundled OpenWork documentation. Use this first for OpenWork product questions before inspecting implementation code.",
      args: docsSearchArgsSchema.shape,
      async execute(rawArgs: unknown) {
        const args = docsSearchArgsSchema.parse(rawArgs);
        const docs = await loadDocs();
        const matches = docs
          .map((entry) => ({ entry, score: scoreDoc(entry, args.query) }))
          .filter((match) => match.score > 0)
          .sort((a, b) => b.score - a.score || a.entry.path.localeCompare(b.entry.path))
          .slice(0, args.limit ?? 5)
          .map((match) => ({
            path: match.entry.path,
            title: match.entry.title,
            description: match.entry.description,
            excerpt: excerpt(match.entry.content, args.query),
          }));
        return JSON.stringify({ ok: true, matches }, null, 2);
      },
    },
    openwork_docs_read: {
      description: "Read a bundled OpenWork documentation page by docs-relative path returned from openwork_docs_search.",
      args: docsReadArgsSchema.shape,
      async execute(rawArgs: unknown) {
        const args = docsReadArgsSchema.parse(rawArgs);
        const normalized = args.path.replace(/^\/+/, "");
        if (normalized.split("/").includes("..")) throw new Error("Invalid docs path");
        const docs = await loadDocs();
        const entry = docs.find((doc) => doc.path === normalized);
        if (!entry) throw new Error(`OpenWork docs page not found: ${normalized}`);
        return JSON.stringify(entry, null, 2);
      },
    },
  },
});
