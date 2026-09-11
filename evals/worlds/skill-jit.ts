import { browserScript } from "@openwork/cdp";
import { deriveMockEnv, type MockBoot, type Place, type Seed } from "@openwork/env";
import { startMockCloudSkills, type MockAgentRequest, type MockCloudSkillsHandle } from "@openwork/labs";
import { access, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { configureProvider } from "./chat.ts";

/** Account labels the fixture mints credentials for. Labels are safe to log; credentials are not. */
export const skillJitAccounts = Object.freeze({ a: "account-a", b: "account-b" });
/** Both Cloud accounts publish a skill under this name; only the body differs per account. */
export const skillJitCloudSkillName = "amber-release-report";
/** The workspace-scoped skill installed through the OpenWork skills route in the native lifecycle case. */
export const skillJitWorkspaceSkillName = "release-briefing";
/** Every native skill materialized from OpenWork Cloud is registered under this id prefix. */
export const cloudNativeSkillIdPrefix = "openwork-cloud-";

export interface NativeSkillEntry {
  id: string;
  name: string;
  description: string;
  location: string;
  content: string;
}

export type SkillJitTurnTarget =
  | { kind: "catalog"; skill: string }
  | { kind: "forced"; skillId: string };

export interface CloudReconcileReceipt {
  status: number;
  desiredPresent: boolean | null;
  deliveryState: string | null;
  engineStatus: string | null;
  failureCodes: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function parseNativeSkills(payload: unknown): NativeSkillEntry[] {
  const data = isRecord(payload) && Array.isArray(payload.data) ? payload.data : Array.isArray(payload) ? payload : null;
  if (!data) throw new Error("The native skill registry response was not a list.");
  return data.filter(isRecord).map((entry) => {
    const name = readString(entry.name) ?? "";
    return {
      id: readString(entry.id) ?? name,
      name,
      description: readString(entry.description) ?? "",
      location: readString(entry.location) ?? "",
      content: readString(entry.content) ?? "",
    };
  });
}

async function listFilesRecursively(root: string): Promise<string[]> {
  const output: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) output.push(path);
    }
  };
  await walk(root);
  return output;
}

function isInside(path: string, root: string): boolean {
  const relativePath = relative(resolve(root), resolve(path));
  return relativePath === "" || (!relativePath.startsWith("..") && !relativePath.startsWith(sep) && !/^[A-Za-z]:/.test(relativePath));
}

/**
 * Headless app-web fixture for just-in-time skills on the native v2 engine.
 *
 * The world owns: a deterministic model witness (seed.mock) whose only tool
 * step is the native `skill` tool, an identity-scoped mock of the OpenWork
 * Cloud `/mcp/agent` endpoint serving `skill://` resources, and typed seed-side
 * steps that persist that endpoint as the account-global Cloud MCP config for
 * one account at a time. Nothing here injects renderer prompts or evaluates
 * browser code on behalf of a spec body.
 */
export async function skillJitWeb(seed: Seed, context: { place: Place }) {
  if (context.place.kind !== "local") {
    throw new Error("skillJitWeb runs on local placement only: its Cloud skill fixture is an in-process loopback MCP server.");
  }
  const providerId = "skill-jit-mock";
  const modelId = "skill-jit-model";
  const workspacePath = seed.tmpPath("skill-jit");
  const booted: { cloud: MockCloudSkillsHandle | null } = { cloud: null };
  const cloudBoot: MockBoot = {
    async boot() {
      const handle = await startMockCloudSkills({ identities: [skillJitAccounts.a, skillJitAccounts.b] });
      booted.cloud = handle;
      return { handle, env: ({ name, url, mcpUrl }) => deriveMockEnv(name, url, mcpUrl) };
    },
  };
  const app = await seed.appWeb({
    name: "skill-jit",
    workspacePath,
    mocks: { agent: seed.mock({ isolatedProcessEnv: true }), cloud: cloudBoot },
  });
  const agentMock = app.mocks.agent;
  const cloud = booted.cloud;
  if (!agentMock || !cloud) throw new Error("The app-web fixture did not boot both the model witness and the Cloud skill fixture.");

  const workspace = await seed.workspace(app, workspacePath);
  const credentials = await seed.evalIn(app, browserScript(() => ({
    port: localStorage.getItem("openwork.server.port"),
    token: localStorage.getItem("openwork.server.token"),
  }), []));
  if (!credentials.port || !credentials.token) throw new Error("The app-web renderer has no local server credentials.");
  const serverUrl = `http://127.0.0.1:${credentials.port}`;
  const serverToken = credentials.token;
  const request = async (path: string, init: { method?: string; body?: unknown; timeoutMs?: number } = {}) => {
    const response = await fetch(serverUrl + path, {
      method: init.method ?? "GET",
      headers: { Authorization: `Bearer ${serverToken}`, ...(init.body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(init.timeoutMs ?? 30_000),
    });
    const text = await response.text();
    let json: unknown = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: response.status, json, text };
  };

  // Native v2 conversation regardless of the inherited engine selector.
  const preview = await request("/experimental/engine-v2-preview", { method: "PUT", body: { enabled: true, chatRouting: true }, timeoutMs: 180_000 });
  if (preview.status !== 200) throw new Error(`Could not enable the native engine: ${preview.status} ${preview.text.slice(0, 300)}`);
  await configureProvider(seed, app, workspace.workspaceId, providerId, modelId, {
    permission: { skill: "allow" },
    provider: {
      [providerId]: {
        npm: "@ai-sdk/openai-compatible",
        name: "Skill JIT model",
        options: { baseURL: `${agentMock.url}/v1`, apiKey: "sk-skill-jit-fixture" },
        models: { [modelId]: { name: "Skill JIT model", tool_call: true } },
      },
    },
  }, "v2");
  const session = await createSession(seed, app, "Amber release report");
  const nativeSkillPath = `/workspace/${encodeURIComponent(workspace.workspaceId)}/opencode2/api/skill`;
  const cloudMcpPath = `/workspace/${encodeURIComponent(workspace.workspaceId)}/mcp/openwork-cloud`;
  const cloudReceipt = (status: number, json: unknown): CloudReconcileReceipt => {
    const health = isRecord(json) ? json : {};
    const failures = Array.isArray(health.failures) ? health.failures : [];
    return {
      status,
      desiredPresent: isRecord(health.desired) && typeof health.desired.present === "boolean" ? health.desired.present : null,
      deliveryState: isRecord(health.delivery) ? readString(health.delivery.state) : null,
      engineStatus: isRecord(health.engine) ? readString(health.engine.status) : null,
      failureCodes: failures.flatMap((failure) => isRecord(failure) && typeof failure.code === "string" ? [failure.code] : []),
    };
  };

  return {
    app,
    workspace,
    session,
    workspaceRoot: workspacePath,
    /** The signed-in eval user's real home; nothing engine-private may land there. */
    realHome: homedir(),
    engine: "v2" as const,
    providerId,
    modelId,
    cloud,
    cloudSkillName: skillJitCloudSkillName,
    workspaceSkillName: skillJitWorkspaceSkillName,
    /** Arrange the deterministic model turn: one native `skill` call, then the tool text as the visible answer. */
    async prepareTurn(prompt: string, target: SkillJitTurnTarget): Promise<void> {
      const step = target.kind === "catalog"
        ? { tool: "skill", argumentsFrom: "skill-catalog", arguments: { skill: target.skill } }
        : { tool: "skill", arguments: { id: target.skillId } };
      const result = await fetch(`${agentMock.url}/admin/agent-workloads`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ workloads: [{
          latestUserTurn: true, promptMarker: prompt, finalReply: "OpenWork: UNAVAILABLE", finalReplyFrom: "last-tool-text", steps: [step],
        }] }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!result.ok) throw new Error(`Could not arrange the model turn: HTTP ${result.status}`);
    },
    /** Persist the fixture endpoint as the global Cloud MCP config using one account's minted bearer token. */
    async authorizeCloud(identity: string): Promise<CloudReconcileReceipt> {
      const result = await request(`${cloudMcpPath}/reconcile`, { method: "POST", timeoutMs: 120_000, body: {
        config: {
          type: "remote", url: cloud.agentUrl, enabled: true, oauth: false,
          headers: { Authorization: `Bearer ${cloud.credential(identity)}` },
        },
        trigger: `skill-jit:${identity}`,
      } });
      return cloudReceipt(result.status, result.json);
    },
    /** Remove the global Cloud MCP config; the host must stop contacting the endpoint. */
    async removeCloud(): Promise<{ status: number; remaining: string[] }> {
      const result = await request(cloudMcpPath, { method: "DELETE", timeoutMs: 60_000 });
      const items = isRecord(result.json) && Array.isArray(result.json.items) ? result.json.items : [];
      return { status: result.status, remaining: items.flatMap((item) => isRecord(item) && typeof item.name === "string" ? [item.name] : []) };
    },
    /** Install or overwrite the workspace skill through the authoring API (validated shape; the app uses this route). */
    async installWorkspaceSkill(input: { description: string; content: string }): Promise<{ status: number }> {
      const result = await request(`/workspace/${encodeURIComponent(workspace.workspaceId)}/skills`, { method: "POST", body: {
        name: skillJitWorkspaceSkillName, description: input.description, content: input.content,
      } });
      return { status: result.status };
    },
    async removeWorkspaceSkill(): Promise<{ status: number }> {
      const result = await request(`/workspace/${encodeURIComponent(workspace.workspaceId)}/skills/${encodeURIComponent(skillJitWorkspaceSkillName)}`, { method: "DELETE" });
      return { status: result.status };
    },
    async cloudHealth(): Promise<CloudReconcileReceipt> {
      const result = await request(`${cloudMcpPath}/health`);
      return cloudReceipt(result.status, result.json);
    },
    /** The engine's live native skill registry, as the proxied v2 route exposes it. */
    async nativeSkills(): Promise<NativeSkillEntry[]> {
      const result = await request(nativeSkillPath);
      if (result.status !== 200) throw new Error(`Native skill registry unavailable: HTTP ${result.status}`);
      return parseNativeSkills(result.json);
    },
    async cloudNativeSkills(): Promise<NativeSkillEntry[]> {
      const result = await request(nativeSkillPath);
      if (result.status !== 200) throw new Error(`Native skill registry unavailable: HTTP ${result.status}`);
      return parseNativeSkills(result.json).filter((skill) => skill.id.startsWith(cloudNativeSkillIdPrefix));
    },
    /** PID of the running v2 conversation runtime. */
    async runtimeIdentity(): Promise<number> {
      const result = await request("/experimental/engine-v2-preview/status");
      if (!isRecord(result.json) || result.json.running !== true || result.json.chatRouting !== true || typeof result.json.pid !== "number") {
        throw new Error("The v2 conversation runtime is not running");
      }
      return result.json.pid;
    },
    /** What the model witness saw for one prompt: tool rounds with their arguments, then the final round. */
    modelRequests(prompt: string, opts: { atLeast?: number; timeoutMs?: number } = {}): Promise<MockAgentRequest[]> {
      return agentMock.agentRequests({ promptMarker: prompt, ...opts });
    },
    /** Write a raw workspace SKILL.md at a directory the skills route would never choose. */
    async writeWorkspaceSkillFile(directoryName: string, markdown: string): Promise<string> {
      const directory = join(workspacePath, ".opencode", "skills", directoryName);
      await mkdir(directory, { recursive: true });
      const path = join(directory, "SKILL.md");
      await writeFile(path, markdown, "utf8");
      return path;
    },
    /** Workspace-relative paths of files whose contents include any needle. */
    async workspaceFilesContaining(needles: readonly string[]): Promise<string[]> {
      const matches: string[] = [];
      for (const path of await listFilesRecursively(workspacePath)) {
        const text = await readFile(path, "utf8").catch(() => "");
        if (needles.some((needle) => text.includes(needle))) matches.push(relative(workspacePath, path));
      }
      return matches.sort();
    },
    /** Whether a previously reported engine-private SKILL.md still exists on disk (the engine runs on this host). */
    async materializedFileExists(location: string): Promise<boolean> {
      return access(location).then(() => true, () => false);
    },
    /** Whether a registry location sits inside the workspace or the real home directory. */
    locationLeaks(location: string): { workspace: boolean; home: boolean } {
      return {
        workspace: location.length > 0 && isInside(location, workspacePath),
        home: location.length > 0 && isInside(location, homedir()),
      };
    },
  };
}

async function createSession(seed: Seed, app: Awaited<ReturnType<Seed["appWeb"]>>, title: string) {
  const deadline = Date.now() + 60_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return await seed.session(app, { title });
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error(`Session creation did not settle: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}
