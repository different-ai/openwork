import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultDaytonaExec, execInSandbox } from "@openwork/hosts";
import { denFetch } from "@openwork/behaviors";
import type { DenSession } from "@openwork/behaviors";
import type { Den, Seed } from "@openwork/env";
import { mcpCallBody, rpcResult, toolJson } from "./library.ts";

// People leaving Claude Cowork bring plugins from marketplace repositories
// shaped like Anthropic's knowledge-work-plugins. The supported path is an
// organization admin (or their agent, through the OpenWork MCP) importing
// them into Den; members then get them through OpenWork Connect.
//
// This world boots Den (local or Daytona) with its public GitHub import
// pointed at a stand-in that serves such a repository
// (evals/fixtures/cowork-marketplace). On Daytona the stand-in runs inside the
// Den sandbox, which builds from the same commit, so Den reaches it on
// loopback. The stand-in records every request, which is how a spec can tell
// what one import costs against GitHub's rate limit.

const FIXTURE_DIR = fileURLToPath(new URL("../fixtures/cowork-marketplace/", import.meta.url));
const BOOTSTRAP_CLI = fileURLToPath(new URL("../../packages/openwork-bootstrap/bin/openwork.mjs", import.meta.url));

/** A skill the person wrote in Cowork, and one of Anthropic's built-ins that must stay behind. */
export const OWN_COWORK_SKILL = {
  name: "weekly-status",
  text: "---\nname: weekly-status\ndescription: Write my weekly status update from this week's notes.\n---\n\n# Weekly status\n\nSummarize wins, risks and next steps in five bullets.\n",
};

// What Claude Cowork keeps on a Mac under Application Support/Claude/
// local-agent-mode-sessions: the marketplaces the person added, and a skills
// bundle mixing their own skills with Anthropic's.
export function writeCoworkHome(root: string, repo: { owner: string; repo: string }) {
  const sessions = join(root, "local-agent-mode-sessions");
  const pluginsDir = join(sessions, "acct", "org", "cowork_plugins");
  mkdirSync(pluginsDir, { recursive: true });
  writeFileSync(join(pluginsDir, "known_marketplaces.json"), JSON.stringify({
    "cowork-plugins": { source: { source: "github", repo: `${repo.owner}/${repo.repo}` }, installLocation: "", lastUpdated: "2026-10-01T00:00:00Z" },
    "team-folder": { source: { source: "directory", path: "/srv/team-plugins" } },
  }));
  const bundle = join(sessions, "skills-plugin", "org", "acct");
  for (const name of [OWN_COWORK_SKILL.name, "pdf"]) mkdirSync(join(bundle, "skills", name), { recursive: true });
  writeFileSync(join(bundle, "skills", OWN_COWORK_SKILL.name, "SKILL.md"), OWN_COWORK_SKILL.text);
  writeFileSync(join(bundle, "skills", "pdf", "SKILL.md"), "---\nname: pdf\ndescription: Built-in.\n---\n\nBuilt-in.\n");
  writeFileSync(join(bundle, "manifest.json"), JSON.stringify({
    lastUpdated: 1,
    skills: [
      { skillId: "own", name: OWN_COWORK_SKILL.name, description: "Weekly status", creatorType: "user", updatedAt: null, enabled: true },
      { skillId: "builtin", name: "pdf", description: "Built-in", creatorType: "anthropic", updatedAt: null, enabled: true },
    ],
  }));
  return sessions;
}

export type CliRun = { code: number; stdout: string; stderr: string; json: unknown };
const FAKE_GITHUB_PORT = 4790;
const ORIGIN = `http://127.0.0.1:${FAKE_GITHUB_PORT}`;

type FixtureRepo = { repo: { owner: string; repo: string; ref: string }; files: Record<string, string> };
export const COWORK_FIXTURE: FixtureRepo = JSON.parse(readFileSync(`${FIXTURE_DIR}repo.json`, "utf8"));

export type GithubRequest = { kind: "api" | "raw" | "other"; path: string };

export interface DenCoworkMarketplaceWorld {
  den: Den;
  organizationId: string;
  /** The admin, holding an MCP token as an outside agent (Claude Code, Codex) would. */
  agent: DenSession;
  repoUrl(dir?: string): string;
  /** Calls one OpenWork MCP tool as the admin's agent. */
  callTool(name: string, args: Record<string, unknown>): Promise<{ isError: boolean; json: unknown }>;
  /** Runs `openwork-bootstrap migrate ...` on a computer that has Cowork's files, signed in as the admin. */
  migrate(args: string[]): Promise<CliRun>;
  /** Changes one file in the served repository, as an upstream commit would. */
  setRepoFile(path: string, content: string): Promise<void>;
  /** Deletes one file from the served repository, as an upstream commit would. */
  deleteRepoFile(path: string): Promise<void>;
  /** Requests the GitHub stand-in served so far. */
  githubRequests(): Promise<GithubRequest[]>;
  [Symbol.asyncDispose](): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readRequests(value: unknown): GithubRequest[] {
  if (!isRecord(value) || !Array.isArray(value.requests)) return [];
  return value.requests.flatMap((entry): GithubRequest[] => {
    if (!isRecord(entry) || typeof entry.path !== "string") return [];
    const kind = entry.kind === "api" || entry.kind === "raw" ? entry.kind : "other";
    return [{ kind, path: entry.path }];
  });
}

async function waitForLocal(url: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`GitHub stand-in did not start at ${url}`);
}

export async function denCoworkMarketplace(seed: Seed): Promise<DenCoworkMarketplaceWorld> {
  const den = await seed.den({
    env: {
      DEN_PUBLIC_GITHUB_API_BASE: `${ORIGIN}/api`,
      DEN_PUBLIC_GITHUB_RAW_BASE: `${ORIGIN}/raw`,
    },
  });

  let local: ChildProcess | null = null;
  const sandboxId = den.placement?.kind === "daytona" ? den.placement.sandboxId : null;
  if (sandboxId) {
    await execInSandbox(defaultDaytonaExec, sandboxId,
      `cd /workspace/evals/fixtures/cowork-marketplace && (nohup node fake-github.mjs ${FAKE_GITHUB_PORT} >/tmp/fake-github.log 2>&1 &) && for i in $(seq 1 50); do curl -sf ${ORIGIN}/__requests >/dev/null && exit 0; sleep 0.2; done; cat /tmp/fake-github.log; exit 1`,
      { context: "start the GitHub stand-in next to den-api", timeoutMs: 60_000 });
  } else {
    local = spawn("node", [`${FIXTURE_DIR}fake-github.mjs`, String(FAKE_GITHUB_PORT)], { stdio: "ignore" });
    await waitForLocal(`${ORIGIN}/__requests`);
  }

  const orgs = await seed.api(den.admin, "/v1/me/orgs");
  const firstOrg = isRecord(orgs.body) && Array.isArray(orgs.body.orgs) ? orgs.body.orgs.find(isRecord) : undefined;
  const organizationId = typeof firstOrg?.id === "string" ? firstOrg.id : "";
  if (!organizationId) throw new Error("The seeded admin has no organization.");
  const issued = await seed.api(den.admin, "/v1/mcp/token", {
    method: "POST",
    headers: { "x-openwork-org-id": organizationId },
    body: JSON.stringify({ scopes: ["mcp:read", "mcp:write"] }),
  });
  const token = isRecord(issued.body) && typeof issued.body.token === "string" ? issued.body.token : "";
  if (!token) throw new Error(`Minting the MCP token failed: HTTP ${issued.response.status}`);

  const agent: DenSession = { ...den.admin, token };
  const coworkDir = writeCoworkHome(seed.tmpPath("cowork-home"), COWORK_FIXTURE.repo);
  const emptyClaudeCode = seed.tmpPath("claude-code-plugins");
  mkdirSync(emptyClaudeCode, { recursive: true });
  let rpcId = 0;
  const editRepo = async (route: string, query: string) => {
    if (sandboxId) {
      await execInSandbox(defaultDaytonaExec, sandboxId, `curl -sf "${ORIGIN}${route}?${query}"`, { context: "edit the served repository", timeoutMs: 30_000 });
      return;
    }
    const response = await fetch(`${ORIGIN}${route}?${query}`);
    if (!response.ok) throw new Error(`GitHub stand-in refused the edit: HTTP ${response.status}`);
  };
  return {
    den,
    organizationId,
    agent,
    async callTool(name, args) {
      const result = await denFetch(den.ref, "/mcp/agent", {
        method: "POST",
        headers: { accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
        body: mcpCallBody(++rpcId, name, args),
        signal: AbortSignal.timeout(180_000),
      });
      const rpc = rpcResult(result);
      return { isError: rpc.isError === true, json: rpc.structuredContent ?? toolJson(result) };
    },
    repoUrl: (dir) => `https://github.com/${COWORK_FIXTURE.repo.owner}/${COWORK_FIXTURE.repo.repo}${dir ? `/tree/${COWORK_FIXTURE.repo.ref}/${dir}` : ""}`,
    migrate(args) {
      return new Promise((resolve) => {
        execFile("node", [BOOTSTRAP_CLI, "migrate", ...args, "--base-url", den.ref.apiUrl, "--json"], {
          env: {
            PATH: process.env.PATH,
            HOME: seed.tmpPath("cli-home"),
            OPENWORK_API_TOKEN: den.admin.token,
            OPENWORK_COWORK_DIR: coworkDir,
            OPENWORK_CLAUDE_CODE_PLUGINS_DIR: emptyClaudeCode,
          },
          timeout: 300_000,
        }, (error, stdout, stderr) => {
          let json: unknown = null;
          try { json = JSON.parse(stdout); } catch { /* not JSON */ }
          const code = error && typeof error.code === "number" ? error.code : error ? 1 : 0;
          resolve({ code, stdout, stderr, json });
        });
      });
    },
    async setRepoFile(path, content) {
      await editRepo("/__set", `path=${encodeURIComponent(path)}&b64=${encodeURIComponent(Buffer.from(content).toString("base64"))}`);
    },
    async deleteRepoFile(path) {
      await editRepo("/__delete", `path=${encodeURIComponent(path)}`);
    },
    async githubRequests() {
      if (sandboxId) {
        const result = await execInSandbox(defaultDaytonaExec, sandboxId, `curl -sf ${ORIGIN}/__requests`, { context: "read the GitHub stand-in log", timeoutMs: 30_000 });
        return readRequests(JSON.parse(result.stdout));
      }
      return readRequests(await (await fetch(`${ORIGIN}/__requests`)).json());
    },
    async [Symbol.asyncDispose]() {
      local?.kill("SIGTERM");
      await den[Symbol.asyncDispose]();
    },
  };
}

export type OrgConnectionFacts = { id: string; name: string; url: string; nativeProviderKey: string | null };

/** Claude's Slack connector URL, which is also OpenWork's Slack preset. */
export const SLACK_MCP_URL = "https://mcp.slack.com/mcp";

export interface DenCoworkMarketplaceWithConnectionsWorld extends DenCoworkMarketplaceWorld {
  /** Connections the organization had before anything was imported, by provider. */
  existing: { slack: OrgConnectionFacts[]; microsoft365: OrgConnectionFacts[]; googleWorkspace: OrgConnectionFacts[] };
  /** Every connection in the organization right now, as an admin lists them. */
  connections(): Promise<OrgConnectionFacts[]>;
  /** The stored definitions of a plugin's components, as JSON text. */
  pluginComponentsText(pluginId: string): Promise<string>;
}

function readConnections(value: unknown): OrgConnectionFacts[] {
  if (!isRecord(value) || !Array.isArray(value.connections)) return [];
  return value.connections.flatMap((entry): OrgConnectionFacts[] => {
    if (!isRecord(entry) || typeof entry.id !== "string" || typeof entry.name !== "string") return [];
    return [{
      id: entry.id,
      name: entry.name,
      url: typeof entry.url === "string" ? entry.url : "",
      nativeProviderKey: typeof entry.nativeProviderKey === "string" ? entry.nativeProviderKey : null,
    }];
  });
}

const sameUrl = (a: string, b: string) => a.replace(/\/+$/, "") === b.replace(/\/+$/, "");

/**
 * The same Den, for an organization that already uses Slack, Microsoft 365
 * and Google Workspace in OpenWork (a reused Daytona Den's demo organization
 * may already have some of them; those are kept, not duplicated).
 */
export async function denCoworkMarketplaceWithConnections(seed: Seed): Promise<DenCoworkMarketplaceWithConnectionsWorld> {
  const world = await denCoworkMarketplace(seed);
  const headers = { "x-openwork-org-id": world.organizationId };
  const list = async () => readConnections((await seed.api(world.den.admin, "/v1/mcp-connections?scope=manageable", { headers })).body);
  const before = await list();
  const slack = before.filter((connection) => !connection.nativeProviderKey && sameUrl(connection.url, SLACK_MCP_URL));
  if (slack.length === 0) {
    const created = await seed.orgConnection(world.den.admin, { name: "Slack", url: SLACK_MCP_URL, authType: "oauth", credentialMode: "per_member", access: { orgWide: true } });
    slack.push({ ...created, url: SLACK_MCP_URL, nativeProviderKey: null });
  }
  const native = async (providerKey: string, name: string) => {
    const found = before.filter((connection) => connection.nativeProviderKey === providerKey);
    if (found.length > 0) return found;
    const created = await seed.nativeConnector(world.den.admin, {
      providerKey, name, clientId: `eval-${providerKey}-client`, clientSecret: "eval-native-client-secret", features: [],
    });
    return [{ ...created, url: "", nativeProviderKey: providerKey }];
  };
  const microsoft365 = await native("microsoft-365", "Microsoft 365");
  const googleWorkspace = await native("google-workspace", "Google Workspace");

  return {
    ...world,
    existing: { slack, microsoft365, googleWorkspace },
    connections: async () => {
      const result = await denFetch(world.den.ref, "/v1/mcp-connections?scope=manageable", {
        headers: { ...headers, authorization: `Bearer ${world.den.admin.token}` },
      });
      return readConnections(result.body);
    },
    async pluginComponentsText(pluginId) {
      const auth = { ...headers, authorization: `Bearer ${world.den.admin.token}` };
      const components = await denFetch(world.den.ref, `/v1/plugins/${encodeURIComponent(pluginId)}/config-objects`, { headers: auth });
      const items = isRecord(components.body) && Array.isArray(components.body.items) ? components.body.items : [];
      const texts = [JSON.stringify(components.body)];
      for (const item of items) {
        const configObject = isRecord(item) && isRecord(item.configObject) ? item.configObject : null;
        if (typeof configObject?.id !== "string") continue;
        const latest = await denFetch(world.den.ref, `/v1/config-objects/${encodeURIComponent(configObject.id)}/versions/latest`, { headers: auth });
        texts.push(JSON.stringify(latest.body));
      }
      return texts.join("\n");
    },
  };
}
