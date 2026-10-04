import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
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
  let rpcId = 0;
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
