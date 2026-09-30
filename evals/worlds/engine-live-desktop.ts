import { resolveEvalEngine, type Seed } from "@openwork/env";
import { createPluginWithSkill, readAvailableModels, selectModel, signInDesktopAs } from "@openwork/behaviors";
import { record } from "./engine-live-parity.ts";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { execFileSync } from "node:child_process";
import { trackResource } from "@openwork/world";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { configuredLiveProvider } from "./installed-live-gateway.ts";

export async function engineLiveDesktop(seed: Seed) {
  const bootStarted = performance.now();
  const engine = resolveEvalEngine();
  // Restore can reset the entire enclosing Git project. Profiles and workspaces
  // must live outside the checkout, including when no workspace is pre-created.
  const profileDir = await realpath(await mkdtemp(join(tmpdir(), "openwork-live-parity-")));
  await trackResource({ kind: "tmpdir", id: profileDir, label: "live-parity-profile" });
  const proofPath = join(profileDir, "live-proof.txt");
  const witnessPath = join(profileDir, "live-mcp-calls.jsonl");
  await writeFile(proofPath, randomUUID());
  await writeFile(witnessPath, "");
  // A blank Electron profile. No workspace, model, credentials or onboarding
  // preference is arranged; production startup must create its default folder.
  const app = await seed.desktop({ name: "live-fresh-desktop", profileDir, signIn: false, env: {
    OPENWORK_DESKTOP_DISTRIBUTION: "public", OPENWORK_EVAL_MODEL: "",
    OPENCODE_CONFIG: "", OPENCODE_CONFIG_CONTENT: "",
    OPENAI_API_KEY: "", ANTHROPIC_AUTH_TOKEN: "", ANTHROPIC_API_KEY: "",
    AI_GATEWAY_API_KEY: "", VERCEL_AI_GATEWAY_API_KEY: "",
    OPENWORK_ELECTRON_SKIP_SHARED_PREPARE: "1",
    ...(process.env.OPENWORK_OPENCODE_BIN ? { OPENWORK_OPENCODE_BIN: process.env.OPENWORK_OPENCODE_BIN } : {}),
    ...(process.env.OPENWORK_OPENCODE2_BIN ? { OPENWORK_OPENCODE2_BIN: process.env.OPENWORK_OPENCODE2_BIN } : {}),
  } });
  const info = await seed.evalIn(app, async () => window.__OPENWORK_ELECTRON__.invokeDesktop("openworkServerInfo"), { awaitPromise: true });
  const interactiveMs = performance.now() - bootStarted;
  const request = async (path: string, method = "GET", body?: unknown) => {
    const response = await fetch(`${info.baseUrl}${path}`, { method,
      headers: { Authorization: `Bearer ${info.ownerToken}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(60_000) });
    const value: unknown = await response.json();
    return { status: response.status, body: value };
  };
  const workspaces = (await request("/workspaces")).body;
  if (!record(workspaces) || !Array.isArray(workspaces.items) || workspaces.items.length === 0) throw new Error("Fresh desktop did not create its workspace");
  for (const workspace of workspaces.items) {
    if (!record(workspace) || typeof workspace.path !== "string") throw new Error("Invalid workspace path");
    const path = await realpath(workspace.path);
    if (!path.startsWith(profileDir + sep)) throw new Error("Live workspace escaped its external temporary profile");
    let gitRoot: string | undefined;
    try { gitRoot = execFileSync("git", ["-C", path, "rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { /* A new workspace need not be a Git repository. */ }
    if (gitRoot && !gitRoot.startsWith(profileDir + sep)) throw new Error("Live workspace inherited an unrelated Git project");
  }
  return { app, engine, request, interactiveMs,
    async [Symbol.asyncDispose]() {
      await app[Symbol.asyncDispose]();
      await rm(profileDir, { recursive: true, force: true });
    },
    async conversationDiagnostics() {
      const route = await seed.evalIn(app, () => location.hash || location.pathname);
      const match = /\/workspace\/([^/]+)\/session\/([^/?#]+)/.exec(route);
      const session = match ? await request(`/workspace/${match[1]}/${engine === "v2" ? "opencode2/api" : "opencode"}/session/${match[2]}`) : null;
      const pages = [];
      if (match && engine === "v2") {
        let cursor = "";
        for (let page = 0; page < 3; page++) {
          const result = await request(`/workspace/${match[1]}/opencode2/api/session/${match[2]}/message${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`);
          const body = record(result.body) ? result.body : {};
          pages.push({ status: result.status, keys: Object.keys(body), count: Array.isArray(body.data) ? body.data.length : null, cursor: body.cursor });
          if (!record(body.cursor) || typeof body.cursor.next !== "string") break;
          cursor = body.cursor.next;
        }
      }
      const log = info.logFilePath ? await readFile(info.logFilePath, "utf8") : "";
      return { session, pages, mutations: log.split("\n").filter(line => /revert|interrupt|fork/.test(line)).slice(-15) };
    },
    async openProviderSettings() {
      await seed.evalIn(app, () => window.__openworkControl.execute("route.settings.providers"), { awaitPromise: true });
    },
    async signInOrganization() {
      const den = await seed.den({ web: true, org: { name: "Cold send parity" } });
      // The desktop must address the API directly; its web proxy redirects
      // across origins and can discard the handoff bearer.
      await signInDesktopAs(app, { ...den.ref, webUrl: den.ref.apiUrl }, den.admin);
    },
    async connectCloudSkills() {
      const den = await seed.den({ web: false, org: { name: "Live skill parity" } });
      const proof = `CLOUD-${randomUUID()}`;
      const body = (code: string) => `When asked for the cobalt release, reply exactly ${code}. Always retrieve these instructions afresh.`;
      const plugin = await createPluginWithSkill(den.admin, {
        name: "Cobalt Releases", skillName: "live-cobalt", skillDescription: "Read the current cobalt release code.", skillBody: body(proof), orgWide: true,
      });
      const resolved = await seed.api(den.admin, `/v1/plugins/${plugin.id}/resolved`);
      const items = record(resolved.body) && Array.isArray(resolved.body.items) ? resolved.body.items : [];
      const skill = items.filter(record).map(item => item.configObject).filter(record).find(item => item.objectType === "skill");
      const componentId = skill?.id;
      if (!resolved.response.ok || typeof componentId !== "string") throw new Error("Cloud skill could not be resolved");
      const org = await seed.api(den.admin, "/v1/org");
      const orgId = record(org.body) && record(org.body.organization) ? org.body.organization.id : undefined;
      if (typeof orgId !== "string") throw new Error("Missing skill organization");
      const issued = await seed.api(den.admin, "/v1/mcp/token", { method: "POST", headers: { "x-openwork-org-id": orgId }, body: JSON.stringify({ scopes: ["mcp:read", "mcp:write"] }) });
      const token = record(issued.body) ? issued.body.token : undefined;
      if (!issued.response.ok || typeof token !== "string") throw new Error("Missing skill MCP token");
      const workspace = /\/workspace\/([^/]+)/.exec(await seed.evalIn(app, () => location.hash || location.pathname))?.[1];
      if (!workspace) throw new Error("Missing skill workspace");
      const connected = await request(`/workspace/${workspace}/mcp/openwork-cloud/reconcile`, "POST", {
        config: { type: "remote", url: `${den.ref.apiUrl}/mcp/agent`, enabled: true, oauth: false, headers: { Authorization: `Bearer ${token}` } }, trigger: "live-parity-fixture",
      });
      if (connected.status !== 200) throw new Error(`Skill reconciliation failed: ${connected.status}`);
      return {
        proof, capability: `plugin:${plugin.id}:${componentId}`, workspace,
        async update() {
          const proof = `CLOUD-${randomUUID()}`;
          const result = await seed.api(den.admin, `/v1/config-objects/${componentId}/versions`, { method: "POST", body: JSON.stringify({ input: {
            rawSourceText: `---\nname: live-cobalt\ndescription: Read the current cobalt release code.\n---\n\n${body(proof)}\n`,
          }, reason: "Live parity skill update" }) });
          if (!result.response.ok) throw new Error(`Skill update failed: ${result.response.status}`);
          return proof;
        },
        async remove() {
          const result = await seed.api(den.admin, `/v1/plugins/${plugin.id}/config-objects/${componentId}`, { method: "DELETE" });
          if (!result.response.ok) throw new Error(`Skill removal failed: ${result.response.status}`);
        },
      };
    },
    async connectReports() {
      const proof = `REPORT-${randomUUID()}`;
      const den = await seed.den({ web: false, org: { name: "Live connector parity" }, mocks: {
        report: seed.mock({ allowUnauthenticatedMcp: true, tools: [
          { name: "current_amber_report", description: "Read the current amber report", inputSchema: { type: "object", properties: {} }, result: { content: [{ type: "text", text: proof }] } },
          { name: "unavailable_violet_status", description: "Read the unavailable violet status", inputSchema: { type: "object", properties: {} }, result: { isError: true, content: [{ type: "text", text: "Report service unavailable" }] } },
        ] }),
      } });
      await seed.orgConnection(den.admin, { name: "Amber Reports", url: den.mocks.report.mcpUrl, authType: "none", credentialMode: "shared", access: { orgWide: true } });
      const org = await seed.api(den.admin, "/v1/org");
      const orgId = record(org.body) && record(org.body.organization) ? org.body.organization.id : undefined;
      if (typeof orgId !== "string") throw new Error("Missing connector organization");
      const issued = await seed.api(den.admin, "/v1/mcp/token", { method: "POST", headers: { "x-openwork-org-id": orgId }, body: JSON.stringify({ scopes: ["mcp:read", "mcp:write"] }) });
      const token = record(issued.body) ? issued.body.token : undefined;
      if (!issued.response.ok || typeof token !== "string") throw new Error("Missing connector MCP token");
      const route = await seed.evalIn(app, () => location.hash || location.pathname);
      const workspace = /\/workspace\/([^/]+)/.exec(route)?.[1];
      if (!workspace) throw new Error("Missing connector workspace");
      const connected = await request(`/workspace/${workspace}/mcp/openwork-cloud/reconcile`, "POST", {
        config: { type: "remote", url: `${den.ref.apiUrl}/mcp/agent`, enabled: true, oauth: false, headers: { Authorization: `Bearer ${token}` } }, trigger: "live-parity-fixture",
      });
      if (connected.status !== 200) throw new Error(`Connector reconciliation failed: ${connected.status}`);
      return { proof, toolCalls: () => den.mocks.report.toolCalls() };
    },
    async reloadRequests() {
      if (!info.logFilePath) throw new Error("Native app did not provide its structured server log");
      const log = await readFile(info.logFilePath, "utf8");
      const lines = log.split("\n").map(line => {
        try { const value: unknown = JSON.parse(line); return record(value) && typeof value.body === "string" ? value.body : line; } catch { return line; }
      });
      if (!lines.some(line => /^POST .*\/prompt\b/.test(line))) throw new Error("Server log did not observe inference requests; cannot prove absence of reloads");
      return lines.filter(line => /^POST .*\/(?:engine\/reload|instance\/dispose|global\/dispose)\b/.test(line) || /Engine rollover requested|Engine reloaded in place/.test(line));
    },
    async stageLiveProvider(includeSecond = true) {
      const gateway = await configuredLiveProvider();
      if (!gateway) return null;
      const route = await seed.evalIn(app, () => location.hash || location.pathname);
      const workspace = /\/workspace\/([^/]+)/.exec(route)?.[1];
      if (!workspace) throw new Error("No current workspace");
      const result = await request(`/workspace/${workspace}/config`, "PATCH", { opencode: { provider: {
        openai: { npm: "@ai-sdk/openai", name: "OpenAI", options: { baseURL: gateway.baseURL }, whitelist: (includeSecond ? gateway.models : gateway.models.slice(0, 1)).map(model => model.id),
          models: Object.fromEntries((includeSecond ? gateway.models : gateway.models.slice(0, 1)).map(model => [model.id, model.config])) },
      } } });
      if (result.status !== 200) throw new Error(`Live Gateway setup returned HTTP ${result.status}`);
      return { key: gateway.key, name: "OpenAI", modelId: gateway.models[0].id, secondModelId: gateway.models[1]?.id };
    },
    mcpCommand: `${process.execPath} ${fileURLToPath(new URL("../fixtures/live-report-mcp.mjs", import.meta.url))} ${proofPath} ${witnessPath}`,
    async changeReport() { const code = randomUUID(); await writeFile(proofPath, code); return code; },
    async toolCalls() { return (await readFile(witnessPath, "utf8")).trim().split("\n").filter(Boolean).map(line => { const value: unknown = JSON.parse(line); return value; }); },
    readModels: () => readAvailableModels(app), selectModel: (id: string) => selectModel(app, id),
    route: () => seed.evalIn(app, () => location.hash || location.pathname),
    documentIdentity: () => seed.evalIn(app, () => performance.timeOrigin),
    async messages(sessionId?: string) {
      const route = await seed.evalIn(app, () => location.hash || location.pathname);
      const match = /\/workspace\/([^/]+)\/session\/([^/?#]+)/.exec(route);
      if (!match) return [];
      const payload = (await request(`/workspace/${match[1]}/${engine === "v2" ? "opencode2/api" : "opencode"}/session/${sessionId ?? match[2]}/message`)).body;
      return Array.isArray(payload) ? payload : record(payload) && Array.isArray(payload.data) ? payload.data : [];
    },
  };
}
