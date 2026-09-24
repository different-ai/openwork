import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { performance as nodePerformance } from "node:perf_hooks";
import { resolveEvalEngine, type MockHandle, type Place, type Seed } from "@openwork/env";
import type { MockAgentToolStep, MockAgentWorkload } from "@openwork/labs";
import { readHeadlessRuntimeManifest, resolveHeadlessWorldRuntimePaths } from "@openwork/world";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Real app, server and pinned engine; only the paid model transport is synthetic. */
export async function engineParity(seed: Seed, { place }: { place: Place }, options: { mock?: MockHandle; env?: Record<string, string> } = {}) {
  const engine = resolveEvalEngine();
  const binary = engine === "v1" ? process.env.OPENWORK_OPENCODE_BIN ?? "opencode" : process.env.OPENWORK_OPENCODE2_BIN ?? "opencode2";
  const { stdout } = await promisify(execFile)(binary, ["--version"], { timeout: 15_000 });
  const engineVersion = stdout.trim().replace(/^opencode2\s+/, "").replace(/^v/, "");
  const nonce = randomUUID();
  const prompt = `Introduce this workspace briefly. PARITY-${nonce}`;
  const reply = `Your workspace is ready. ${nonce}`;
  const temporaryWorkspace = seed.tmpPath("engine-parity");
  await mkdir(temporaryWorkspace, { recursive: true });
  // macOS aliases /tmp to /private/tmp; v1 instance disposal uses exact paths.
  const workspacePath = await realpath(temporaryWorkspace);
  const mock = options.mock ?? (await seed.mock({ isolatedProcessEnv: true }).boot(place)).handle;
  try {
    const configured = await fetch(`${mock.url}/admin/agent-workloads`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ workloads: [{ promptMarker: prompt, latestUserTurn: true, finalReply: reply, steps: [] }] }) });
    if (!configured.ok) throw new Error("Could not configure initial model witness");
    await mkdir(workspacePath, { recursive: true });
    await writeFile(join(workspacePath, "opencode.json"), JSON.stringify({
      permission: { skill: "allow" },
      provider: { opencode: {
        npm: "@ai-sdk/openai-compatible",
        options: { baseURL: `${mock.url}/v1`, apiKey: "parity-starter-only" },
        whitelist: ["big-pickle"],
        models: { "big-pickle": { name: "Big Pickle", tool_call: true,
          provider: { npm: "@ai-sdk/openai-compatible", api: `${mock.url}/v1` } } },
      } },
    }));
    const startedAt = nodePerformance.now();
    const app = await seed.appWeb({ name: "engine-parity", workspacePath, env: {
      OPENWORK_CLOUD_PROVIDER_SYNC_INTERVAL_MS: "1000",
      OPENWORK_LOG_FORMAT: "json",
      ...(process.env.OPENWORK_OPENCODE_BIN ? { OPENWORK_OPENCODE_BIN: process.env.OPENWORK_OPENCODE_BIN } : {}),
      ...(process.env.OPENWORK_OPENCODE2_BIN ? { OPENWORK_OPENCODE2_BIN: process.env.OPENWORK_OPENCODE2_BIN } : {}),
      ...options.env,
    } });
    const interactiveMs = nodePerformance.now() - startedAt;
    const paths = resolveHeadlessWorldRuntimePaths(fileURLToPath(new URL("../../", import.meta.url)), app.handle.name);
    const manifest = await readHeadlessRuntimeManifest(paths.runtimeManifestPath);
    if (!manifest) throw new Error("Missing owned app runtime manifest");
    const ownerResponse = await fetch(`${app.openworkUrl}/tokens`, {
      method: "POST", headers: { "X-OpenWork-Host-Token": manifest.hostToken, "Content-Type": "application/json" },
      body: JSON.stringify({ scope: "owner", label: "engine-parity-fixture" }),
    });
    const owner: unknown = await ownerResponse.json();
    if (ownerResponse.status !== 201 || !owner || typeof owner !== "object" || !("token" in owner) || typeof owner.token !== "string") throw new Error("Could not mint fixture owner token");
    const request = async (path: string, method = "GET", body?: unknown) => {
      const response = await fetch(`${app.openworkUrl}${path}`, {
        method, headers: { Authorization: `Bearer ${owner.token}`, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(60_000),
      });
      const text = await response.text();
      const value: unknown = text ? JSON.parse(text) : null;
      return { status: response.status, body: value };
    };
    return {
      app, engine, engineVersion, mock, prompt, reply, interactiveMs, startedAt, workspacePath, request,
      documentIdentity: () => seed.evalIn(app, () => performance.timeOrigin),
      route: () => seed.evalIn(app, () => location.hash || `#${location.pathname}`),
      async reloadRequests() {
        const log = await readFile(paths.headlessLogPath, "utf8");
        return log.split("\n").map((line) => {
          try { const entry: unknown = JSON.parse(line); return record(entry) && typeof entry.body === "string" ? entry.body : line; } catch { return line; }
        }).filter((line) => /^POST .*\/(?:engine\/reload|instance\/dispose|global\/dispose)\b/.test(line)
          || line === "Engine rollover requested." || line === "Engine reloaded in place (idle).");
      },
      async serverErrors() {
        const log = await readFile(paths.headlessLogPath, "utf8");
        return log.split("\n").flatMap((line) => {
          try {
            const entry: unknown = JSON.parse(line);
            if (!record(entry) || typeof entry.body !== "string" || !/ 5\d\d /.test(entry.body)) return [];
            const attributes = record(entry.attributes) ? entry.attributes : {};
            return [{ message: entry.body, error: attributes.error, cause: attributes["error.cause"] }];
          } catch { return []; }
        });
      },
      async observeNativeCatalog(workspaceId: string) {
        const abort = new AbortController();
        const events: Array<{ type: string; directory?: string }> = [];
        const response = await fetch(`${app.openworkUrl}/workspace/${workspaceId}/opencode2/api/event`, {
          headers: { Authorization: `Bearer ${owner.token}`, Accept: "text/event-stream" }, signal: abort.signal,
        });
        if (!response.ok || !response.body) throw new Error("Native event observer did not connect");
        const reader = response.body.getReader();
        const reading = (async () => {
          const decoder = new TextDecoder();
          let buffer = "";
          while (!abort.signal.aborted) {
            const chunk = await reader.read();
            if (chunk.done) break;
            buffer += decoder.decode(chunk.value, { stream: true });
            const lines = buffer.split(/\r?\n/); buffer = lines.pop() ?? "";
            for (const line of lines) {
              if (!line.startsWith("data:")) continue;
              const event: unknown = JSON.parse(line.slice(5));
              if (!record(event) || (event.type !== "catalog.updated" && event.type !== "config.updated")) continue;
              const location = record(event.location) ? event.location : {};
              events.push({ type: event.type, ...(typeof location.directory === "string" ? { directory: location.directory } : {}) });
            }
          }
        })().catch((error: unknown) => { if (!abort.signal.aborted) throw error; });
        void reading.catch(() => undefined);
        return { events, async stop() { abort.abort(); await reading; } };
      },
      async hostRequest(path: string, method: string, body?: unknown) {
        const response = await fetch(`${app.openworkUrl}${path}`, {
          method, headers: { "X-OpenWork-Host-Token": manifest.hostToken, "Content-Type": "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(60_000),
        });
        const text = await response.text();
        const value: unknown = text ? JSON.parse(text) : null;
        return { status: response.status, body: value };
      },
      async prepareTurn(promptMarker: string, finalReply: string, steps: MockAgentToolStep[] = [], finalReplyFrom?: MockAgentWorkload["finalReplyFrom"]) {
        const response = await fetch(`${mock.url}/admin/agent-workloads`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ workloads: [{ promptMarker, latestUserTurn: true, finalReply, steps, finalReplyFrom }] }),
        });
        if (!response.ok) throw new Error(`Model witness setup failed: ${response.status}`);
      },
      async prepareStream(promptMarker: string, chunks: string[]) {
        const response = await fetch(`${mock.url}/admin/agent-workloads`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ workloads: [{ promptMarker, latestUserTurn: true, finalReply: chunks.join(""), steps: [], finalReplyChunks: chunks, finalReplyInitiallyReleasedChunks: 1 }] }),
        });
        if (!response.ok) throw new Error(`Streaming witness setup failed: ${response.status}`);
      },
      async runtime() {
        const { status, body } = await request("/experimental/engine-v2-preview/status");
        if (status !== 200 || !body || typeof body !== "object" || !("chatRouting" in body)) throw new Error("Missing runtime identity");
        if (engine === "v2" && (!("pid" in body) || typeof body.pid !== "number")) throw new Error("V2 must report a real process identity");
        return { chatRouting: body.chatRouting === true, pid: "pid" in body ? body.pid : null, version: "version" in body ? body.version : null };
      },
      async [Symbol.asyncDispose]() { if (!options.mock) await mock.stop(); },
    };
  } catch (error) { if (!options.mock) await mock.stop(); throw error; }
}
