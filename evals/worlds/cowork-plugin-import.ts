import { mkdir, readdir, realpath, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { SkipError } from "@openwork/env";
import type { Seed } from "@openwork/env";
import { bootManagedOpenworkServer, close, engineBinary, listen, sendJson } from "./openwork-server-cli.ts";

// People move to OpenWork with the plugins they used in Claude Cowork. Those
// plugins come from marketplace repositories shaped like Anthropic's
// knowledge-work-plugins: one repo, a .claude-plugin/marketplace.json, one
// folder per plugin (some nested under partner-built/), each with a
// .claude-plugin/plugin.json, an .mcp.json of suggested connectors, skills,
// and sometimes commands and agents.
//
// This world serves such a repository from a loopback GitHub stand-in (the
// server's OPENWORK_GITHUB_API_BASE / OPENWORK_GITHUB_RAW_BASE seams) and boots
// the real openwork-server CLI with its managed engine against an empty
// workspace, so a spec can import, inspect and remove plugins exactly as the
// desktop app or an outside agent does over HTTP. No real GitHub or MCP
// provider is contacted; connector URLs point at an unused loopback port.

export const COWORK_REPO = { owner: "acme-labs", repo: "cowork-plugins", ref: "main" } as const;

const CONNECTOR = "http://127.0.0.1:9/mcp";

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function skill(name: string, description: string, body: string): string {
  return `---\nname: ${name}\ndescription: ${description}\nargument-hint: "[topic]"\nallowed-tools: Read, Grep\n---\n\n${body}\n`;
}

/** The repository, path → file content. Mirrors real Cowork plugin shapes. */
export const COWORK_REPO_FILES: Record<string, string> = {
  "README.md": "# Cowork plugins\n",
  ".claude-plugin/marketplace.json": json({
    name: "cowork-plugins",
    owner: { name: "Acme Labs" },
    plugins: [
      { name: "productivity", displayName: "Productivity", source: "./productivity", description: "Plan your day and track tasks." },
      { name: "sales", displayName: "Sales", source: "./sales", description: "Prep calls and review pipeline." },
      { name: "brand-voice", displayName: "Brand Voice", source: "./partner-built/brand-voice", description: "Keep writing on brand." },
      { name: "remote-partner", source: { source: "git-subdir", url: "https://github.com/acme-partner/plugin.git", path: "src", ref: "main" }, description: "Lives in another repository." },
    ],
  }),

  "productivity/.claude-plugin/plugin.json": json({ name: "productivity", version: "1.2.0", description: "Plan your day and track tasks." }),
  "productivity/.mcp.json": json({
    mcpServers: {
      slack: { type: "http", url: `${CONNECTOR}/slack`, oauth: { clientId: "cowork-registered-client", callbackPort: 3118 } },
      notion: { type: "http", url: `${CONNECTOR}/notion` },
      // Cowork leaves these blank for the person to pick a provider.
      gmail: { type: "http", url: "" },
      "google calendar": { type: "http", url: "" },
    },
  }),
  "productivity/skills/start/SKILL.md": skill(
    "start",
    "Set up the task dashboard for this folder.",
    "If `dashboard.html` is missing, copy it from `${CLAUDE_PLUGIN_ROOT}/skills/dashboard.html` to the current folder.",
  ),
  "productivity/skills/task-management/SKILL.md": skill("task-management", "Track tasks in TASKS.md.", "Keep TASKS.md up to date."),
  "productivity/skills/dashboard.html": "<!doctype html><title>Tasks</title>\n",

  "sales/.claude-plugin/plugin.json": json({ name: "sales", version: "2.0.1", description: "Prep calls and review pipeline." }),
  "sales/.mcp.json": json({
    mcpServers: {
      slack: { type: "http", url: `${CONNECTOR}/slack`, oauth: { clientId: "cowork-registered-client", callbackPort: 3118 } },
      notion: { type: "http", url: `${CONNECTOR}/notion` },
      hubspot: { type: "http", url: `${CONNECTOR}/hubspot` },
      salesforce: { type: "http", url: `${CONNECTOR}/salesforce` },
      close: { type: "http", url: `${CONNECTOR}/close` },
      gong: { type: "http", url: `${CONNECTOR}/gong` },
      zoominfo: { type: "http", url: `${CONNECTOR}/zoominfo` },
    },
  }),
  "sales/CONNECTORS.md": "# Connectors\nConnect one CRM: ~~CRM.\n",
  "sales/skills/call-prep/SKILL.md": skill("call-prep", "Brief me before a customer call.", "Pull account history from ~~CRM."),
  "sales/skills/forecast/SKILL.md": skill("forecast", "Write the weekly forecast.", "Use the template in references/forecast-template.md."),
  "sales/skills/forecast/references/forecast-template.md": "# Forecast\n| Deal | Stage |\n",
  "sales/skills/deal-review/SKILL.md": skill("deal-review", "Review one deal.", "Summarize risks."),

  "partner-built/brand-voice/.claude-plugin/plugin.json": json({ name: "brand-voice", version: "1.0.0", description: "Keep writing on brand." }),
  "partner-built/brand-voice/.mcp.json": json({ mcpServers: { notion: { type: "http", url: `${CONNECTOR}/notion` } } }),
  "partner-built/brand-voice/skills/brand-voice-enforcement/SKILL.md": skill("brand-voice-enforcement", "Rewrite text in the brand voice.", "Apply the guidelines."),
  "partner-built/brand-voice/commands/enforce-voice.md": "---\nname: enforce-voice\ndescription: Rewrite the selection in the brand voice\n---\n\nRewrite $ARGUMENTS in the brand voice.\n",
  "partner-built/brand-voice/agents/content-generation.md": "---\nname: content-generation\ndescription: Generates long-form on-brand content when a skill delegates to it.\nmodel: inherit\ntools: Read, Write\n---\n\nYou write long-form content that follows the brand guidelines.\n",
};

function gitSha(path: string): string {
  let hash = 0;
  for (const char of path) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash.toString(16).padStart(40, "0");
}

function githubStandIn(requests: string[]): Server {
  const repoPath = `/api/repos/${COWORK_REPO.owner}/${COWORK_REPO.repo}`;
  const rawPrefix = `/raw/${COWORK_REPO.owner}/${COWORK_REPO.repo}/${COWORK_REPO.ref}/`;
  return createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    requests.push(url.pathname);
    if (url.pathname === repoPath) return sendJson(response, 200, { default_branch: COWORK_REPO.ref });
    if (url.pathname === `${repoPath}/git/trees/${COWORK_REPO.ref}`) {
      return sendJson(response, 200, {
        tree: Object.keys(COWORK_REPO_FILES).map((path) => ({ path, type: "blob", sha: gitSha(path) })),
        truncated: false,
      });
    }
    if (url.pathname.startsWith(rawPrefix)) {
      const path = decodeURIComponent(url.pathname.slice(rawPrefix.length));
      const content = COWORK_REPO_FILES[path];
      if (content !== undefined) {
        response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        response.end(content);
        return;
      }
    }
    sendJson(response, 404, { message: "Not Found" });
  });
}

export type ApiResult = { status: number; body: unknown };

export interface CoworkPluginImportWorld {
  workspaceId: string;
  workspacePath: string;
  /** GitHub URL of the marketplace repo, optionally pointing at one plugin folder. */
  repoUrl(dir?: string): string;
  /** Calls the workspace-scoped OpenWork server API as the desktop app does. */
  api(method: string, path: string, body?: unknown): Promise<ApiResult>;
  /** Proxied engine call, e.g. /agent or /command. */
  engine(method: string, path: string, body?: unknown): Promise<unknown>;
  /** Paths the GitHub stand-in served, in order. */
  githubRequests: string[];
  /** Workspace-relative files under .opencode/<kind>/, sorted. */
  installedFiles(kind: "skills" | "agents" | "commands"): Promise<string[]>;
  output(): string;
  [Symbol.asyncDispose](): Promise<void>;
}

async function listFiles(root: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      const nested = await listFiles(join(root, entry.name), relative);
      files.push(...(nested.length ? nested : [`${relative}/`]));
    } else files.push(relative);
  }
  return files.sort();
}

export async function coworkPluginImport(seed: Seed): Promise<CoworkPluginImportWorld> {
  const binary = engineBinary();
  if (!binary) throw new SkipError("set OPENWORK_OPENCODE_BIN or install opencode");

  const root = seed.tmpPath("cowork-plugin-import");
  await mkdir(root, { recursive: true });
  const scratch = await realpath(root);
  const workspace = join(scratch, "workspace");
  await mkdir(workspace, { recursive: true });

  const githubRequests: string[] = [];
  const github = githubStandIn(githubRequests);
  const githubUrl = await listen(github);

  const token = "cowork-plugin-import-token";
  let output = "";
  const sink = (chunk: string) => { output += chunk; };
  let managed: Awaited<ReturnType<typeof bootManagedOpenworkServer>> | null = null;
  const dispose = async () => {
    if (managed) await managed.stop();
    await close(github);
    await rm(scratch, { recursive: true, force: true });
  };

  try {
    managed = await bootManagedOpenworkServer({
      scratch,
      workspace,
      token,
      sink,
      binary,
      env: {
        OPENWORK_GITHUB_API_BASE: `${githubUrl}/api`,
        OPENWORK_GITHUB_RAW_BASE: `${githubUrl}/raw`,
      },
    });
    const server = managed;
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const workspaceId = server.workspaceId;
    return {
      workspaceId,
      workspacePath: workspace,
      repoUrl: (dir) => `https://github.com/${COWORK_REPO.owner}/${COWORK_REPO.repo}${dir ? `/tree/${COWORK_REPO.ref}/${dir}` : ""}`,
      async api(method, path, body) {
        const response = await fetch(`${server.base}/workspace/${encodeURIComponent(workspaceId)}${path}`, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(90_000),
        });
        const text = await response.text();
        let parsed: unknown = text;
        try { parsed = text ? JSON.parse(text) : null; } catch { /* keep text */ }
        return { status: response.status, body: parsed };
      },
      engine: server.engine,
      githubRequests,
      installedFiles: (kind) => listFiles(join(workspace, ".opencode", kind)),
      output: () => output,
      [Symbol.asyncDispose]: dispose,
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}
