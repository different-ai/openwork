import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
import { needs, test, unmetNeeds } from "@openwork/testkit";
import type { TestNeeds } from "@openwork/testkit";
import { clearEnginePoolForConfig, computeEngineConfigFingerprint, type EngineSpawnTemplate } from "../../apps/server/src/engine-pool.js";
import { buildEngineAuthProbeHeader } from "../../apps/server/src/engine-registry.js";
import { createManagedOpencodeServer, type ManagedOpencodeServer } from "../../apps/server/src/managed-opencode.js";
import { createEnginePoolForConfig, registerTrustedOpencodeProcess, startServer } from "../../apps/server/src/server.js";
import { listThreadApprovals } from "../../apps/server/src/thread-approvals.js";
import type { ServerConfig } from "../../apps/server/src/types.js";

/**
 * OpenWork server + engine pool around the real pinned engine + a scripted
 * provider. thread-approvals-engine-memory shows the engine forgetting an
 * "always" reply once its instance is rebuilt; this spec shows OpenWork
 * remembering it for the thread and answering the repeat ask. The engine's
 * own event stream is watched, so "the engine asked and OpenWork answered" is
 * observed at the source rather than inferred.
 */

const requirements: TestNeeds = { commands: ["opencode"] };
const missingRequirements = unmetNeeds(requirements, process.env);
const skipSuffix = missingRequirements.length > 0 ? ` skipped — needs: ${missingRequirements.join(", ")}` : "";

const providerId = "thread-approval-fixture";
const modelId = "thread-approval-model";
const CLIENT_TOKEN = "owt_thread_approvals";
const HOST_TOKEN = "owt_thread_approvals_host";

type Served = { port: number; stop: (closeActiveConnections?: boolean) => void | Promise<void> };

interface EngineEvent {
  type: string;
  sessionID: string;
  reply: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** OpenAI-compatible stand-in: user prompt → one bash tool call for `RUN: <command>`; tool result → completion. */
function scriptedProvider(): Promise<{ server: Server; url: string; calls: string[] }> {
  const calls: string[] = [];
  return new Promise((resolve, reject) => {
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method === "GET" && url.pathname.endsWith("/models")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ object: "list", data: [{ id: modelId, object: "model" }] }));
        return;
      }
      if (request.method !== "POST" || !url.pathname.endsWith("/chat/completions")) {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "not found" } }));
        return;
      }
      let raw = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => { raw += chunk; });
      request.on("end", () => {
        const body: unknown = JSON.parse(raw);
        const messages = isRecord(body) && Array.isArray(body.messages) ? body.messages : [];
        const last = messages.at(-1);
        const toolResult = isRecord(last) && last.role === "tool";
        const lastUser = [...messages].reverse().find((message) => isRecord(message) && message.role === "user");
        const text = isRecord(lastUser)
          ? (typeof lastUser.content === "string"
            ? lastUser.content
            : Array.isArray(lastUser.content) ? lastUser.content.map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : "")).join("\n") : "")
          : "";
        const command = text.match(/RUN:\s*(.+)$/m)?.[1]?.trim() ?? "printf 'no command'";
        const id = `chatcmpl-${Date.now()}`;
        const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
          `data: ${JSON.stringify({ id, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
        response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        response.write(chunk({ role: "assistant" }));
        if (toolResult) {
          response.write(chunk({ content: "FIXTURE-DONE" }) + chunk({}, "stop"));
        } else {
          calls.push(command);
          response.write(chunk({ tool_calls: [{ index: 0, id: `call_${Date.now()}`, type: "function", function: { name: "bash", arguments: JSON.stringify({ command }) } }] }));
          response.write(chunk({}, "tool_calls"));
        }
        response.write("data: [DONE]\n\n");
        response.end();
      });
    });
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("provider did not bind"));
        return;
      }
      resolve({ server, url: `http://127.0.0.1:${address.port}`, calls });
    });
  });
}

interface Stack {
  config: ServerConfig;
  request: (method: string, path: string, body?: unknown) => Promise<unknown>;
  events: EngineEvent[];
  calls: string[];
  [Symbol.asyncDispose]: () => Promise<void>;
}

async function bootStack(): Promise<Stack> {
  const disposers: Array<() => Promise<void> | void> = [];
  const dispose = async () => {
    while (disposers.length) await disposers.pop()?.();
  };
  try {
    const root = await mkdtemp(join(tmpdir(), "openwork-thread-approvals-stack-"));
    disposers.push(() => rm(root, { recursive: true, force: true }));
    const workspace = join(root, "workspace");
    const xdg = join(root, "xdg");
    await Promise.all([mkdir(workspace, { recursive: true }), mkdir(join(xdg, "config", "opencode"), { recursive: true }), mkdir(join(root, "home"), { recursive: true })]);
    const previousEnv = {
      OPENWORK_DATA_DIR: process.env.OPENWORK_DATA_DIR,
      OPENWORK_TOKEN_STORE: process.env.OPENWORK_TOKEN_STORE,
      OPENWORK_RUNTIME_DB: process.env.OPENWORK_RUNTIME_DB,
    };
    process.env.OPENWORK_DATA_DIR = join(root, "data");
    process.env.OPENWORK_TOKEN_STORE = join(root, "tokens.json");
    process.env.OPENWORK_RUNTIME_DB = join(root, "runtime.sqlite");
    disposers.push(() => {
      for (const [key, value] of Object.entries(previousEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });

    const provider = await scriptedProvider();
    disposers.push(() => new Promise<void>((resolve) => provider.server.close(() => resolve())));
    await writeFile(join(workspace, "opencode.json"), JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      permission: { bash: "ask" },
      provider: {
        [providerId]: {
          npm: "@ai-sdk/openai-compatible",
          name: "Thread approval fixture",
          options: { baseURL: `${provider.url}/v1`, apiKey: "fixture-key" },
          models: { [modelId]: { name: "Thread approval fixture", tool_call: true } },
        },
      },
    }), "utf8");
    await writeFile(join(xdg, "config", "opencode", "opencode.json"), "{}", "utf8");
    const runtimeConfigPath = join(root, "runtime-opencode-config.json");
    await writeFile(runtimeConfigPath, "{}\n", "utf8");

    const engineEnv = {
      OPENCODE_TEST_HOME: join(root, "home"),
      XDG_CONFIG_HOME: join(xdg, "config"),
      XDG_DATA_HOME: join(xdg, "data"),
      XDG_CACHE_HOME: join(xdg, "cache"),
      XDG_STATE_HOME: join(xdg, "state"),
      OPENCODE_CONFIG: runtimeConfigPath,
    };
    const engine: ManagedOpencodeServer = await createManagedOpencodeServer({ cwd: workspace, env: engineEnv, timeoutMs: 60_000 });
    disposers.push(() => engine.close());

    const config: ServerConfig = {
      host: "127.0.0.1",
      port: 0,
      configPath: join(root, "server.json"),
      token: CLIENT_TOKEN,
      hostToken: HOST_TOKEN,
      approval: { mode: "auto", timeoutMs: 1000 },
      corsOrigins: ["*"],
      opencodeUsername: engine.username,
      opencodePassword: engine.password,
      workspaces: [{ id: "ws_1", name: "Workspace", path: workspace, preset: "starter", workspaceType: "local", baseUrl: engine.url }],
      authorizedRoots: [workspace],
      readOnly: false,
      startedAt: Date.now(),
      tokenSource: "cli",
      hostTokenSource: "cli",
      logFormat: "pretty",
      logRequests: false,
    };
    registerTrustedOpencodeProcess(config, { baseUrl: engine.url, identity: "thread-approvals-spec", isAlive: engine.isAlive });
    const template: EngineSpawnTemplate = { cwd: workspace, runtimeConfigPath, env: engineEnv, reservedPorts: () => [] };
    const pool = createEnginePoolForConfig({
      config,
      template,
      handle: engine,
      fingerprint: await computeEngineConfigFingerprint(template),
      registryId: null,
      trustedIdentity: null,
    });
    disposers.push(async () => {
      clearEnginePoolForConfig(config);
      await pool.disposeAll();
    });
    const served = await startServer(config) as Served;
    disposers.push(() => served.stop(true));

    // Watch the engine's own event stream so asks and replies are observed at the source.
    const events: EngineEvent[] = [];
    const watcher = new AbortController();
    disposers.push(() => watcher.abort());
    void (async () => {
      try {
        const response = await fetch(new URL("/global/event", engine.url), {
          headers: { Authorization: buildEngineAuthProbeHeader(engine.username, engine.password) },
          signal: watcher.signal,
        });
        if (!response.body) return;
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffered = "";
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) return;
          buffered += decoder.decode(chunk.value, { stream: true });
          let index: number;
          while ((index = buffered.indexOf("\n\n")) >= 0) {
            const frame = buffered.slice(0, index);
            buffered = buffered.slice(index + 2);
            const data = frame.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("");
            if (!data) continue;
            try {
              const parsed: unknown = JSON.parse(data);
              const payload = isRecord(parsed) && isRecord(parsed.payload) ? parsed.payload : null;
              const properties = payload && isRecord(payload.properties) ? payload.properties : {};
              if (payload && typeof payload.type === "string" && payload.type.startsWith("permission.")) {
                events.push({
                  type: payload.type,
                  sessionID: typeof properties.sessionID === "string" ? properties.sessionID : "",
                  reply: typeof properties.reply === "string" ? properties.reply : "",
                });
              }
            } catch {
              // ignore non-JSON frames
            }
          }
        }
      } catch {
        // aborted at teardown
      }
    })();

    const base = `http://127.0.0.1:${served.port}/workspace/ws_1`;
    const request = async (method: string, path: string, body?: unknown): Promise<unknown> => {
      const response = await fetch(`${base}${path}`, {
        method,
        headers: { Authorization: `Bearer ${CLIENT_TOKEN}`, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(60_000),
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`${method} ${path} → ${response.status} ${text.slice(0, 300)}`);
      return text ? JSON.parse(text) : null;
    };
    return { config, request, events, calls: provider.calls, [Symbol.asyncDispose]: dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, label: string, timeoutMs = 60_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last = await read();
  while (Date.now() < deadline) {
    if (done(last)) return last;
    await sleep(200);
    last = await read();
  }
  throw new Error(`${label}: ${JSON.stringify(last)}`);
}

async function pendingFor(stack: Stack, sessionId: string): Promise<Array<{ id: string; permission: string }>> {
  const value = await stack.request("GET", "/opencode/permission");
  return Array.isArray(value)
    ? value.flatMap((entry) => isRecord(entry) && typeof entry.id === "string" && entry.sessionID === sessionId
      ? [{ id: entry.id, permission: typeof entry.permission === "string" ? entry.permission : "" }]
      : [])
    : [];
}

async function completed(stack: Stack, sessionId: string, command: string): Promise<boolean> {
  const value = await stack.request("GET", `/opencode/session/${encodeURIComponent(sessionId)}/message`);
  if (!Array.isArray(value)) return false;
  return value.some((message) => isRecord(message) && Array.isArray(message.parts) && message.parts.some((part) =>
    isRecord(part) && part.type === "tool" && isRecord(part.state) && part.state.status === "completed"
    && isRecord(part.state.input) && part.state.input.command === command));
}

/** Outcome of one prompt: the engine asked (never answered here) or the command completed. */
async function turn(stack: Stack, sessionId: string, command: string) {
  await stack.request("POST", `/opencode/session/${encodeURIComponent(sessionId)}/prompt_async`, {
    model: { providerID: providerId, modelID: modelId },
    parts: [{ type: "text", text: `Run the fixture command.\nRUN: ${command}` }],
  });
  return until(
    async () => ({ asked: (await pendingFor(stack, sessionId))[0] ?? null, done: await completed(stack, sessionId, command) }),
    (state) => state.asked !== null || state.done,
    `turn ${command}`,
  );
}

async function createThread(stack: Stack, title: string): Promise<string> {
  const created = await stack.request("POST", "/opencode/session", { title });
  if (!isRecord(created) || typeof created.id !== "string") throw new Error(`session create returned ${JSON.stringify(created)}`);
  return created.id;
}

test.skipIf(missingRequirements.length > 0)(
  `an always reply on a thread is replayed by OpenWork after the engine instance is rebuilt, and only for that thread${skipSuffix}`,
  { timeout: 240_000 },
  async ({ evidence }) => {
    needs(requirements);
    await using stack = await bootStack();
    const thread = await createThread(stack, "Thread approvals");

    // Turn 1: the workspace asks; the user replies "always" through OpenWork's proxy.
    const first = await turn(stack, thread, "printf 'grant one'");
    if (!first.asked) throw new Error("the first command did not ask");
    expect(first.asked.permission).toBe("bash");
    await stack.request("POST", `/opencode/permission/${encodeURIComponent(first.asked.id)}/reply`, { reply: "always" });
    await until(() => completed(stack, thread, "printf 'grant one'"), (done) => done, "first command completed");
    const remembered = await until(
      () => listThreadApprovals(stack.config, "ws_1", thread),
      (grants) => grants.some((grant) => grant.permission === "bash"),
      "OpenWork remembered the thread's grant",
      10_000,
    );
    evidence.recordAssertionEvidence(
      "OpenWork records an always reply against its thread",
      `Thread ${thread} now carries ${JSON.stringify(remembered)} in OpenWork's own store.`,
      true,
    );

    // Rebuild the instance as every reload does; the engine's own memory is gone.
    await stack.request("POST", "/opencode/instance/dispose");

    // Turn 2: same thread, covered command — the engine asks, OpenWork answers, the command runs.
    const askedBefore = stack.events.filter((event) => event.type === "permission.asked" && event.sessionID === thread).length;
    const second = await turn(stack, thread, "printf 'grant two'");
    if (second.asked) {
      // A poll may catch the ask before the replay lands; it must still resolve without a human.
      await until(() => completed(stack, thread, "printf 'grant two'"), (done) => done, "second command completed without a human reply", 30_000);
    }
    expect(await completed(stack, thread, "printf 'grant two'")).toBe(true);
    const askedAfter = stack.events.filter((event) => event.type === "permission.asked" && event.sessionID === thread).length;
    expect(askedAfter).toBeGreaterThan(askedBefore);
    const alwaysReplies = stack.events.filter((event) => event.type === "permission.replied" && event.sessionID === thread && event.reply === "always").length;
    expect(alwaysReplies).toBeGreaterThanOrEqual(2);
    expect(stack.calls).toEqual(["printf 'grant one'", "printf 'grant two'"]);
    evidence.recordAssertionEvidence(
      "After an engine instance rebuild the same thread's covered command runs without a human reply",
      `The engine asked (${askedAfter - askedBefore} new ask on ${thread}), OpenWork answered "always" (${alwaysReplies} always replies observed on the engine's event stream), and the command completed.`,
      true,
    );

    // Replaying with "always" re-seeds the engine's own memory, which is
    // instance-wide today (one click covers every thread in the instance until
    // it is rebuilt) — unchanged by this change. After another rebuild only
    // OpenWork's memory is left, and that is per thread.
    await stack.request("POST", "/opencode/instance/dispose");
    const third = await turn(stack, thread, "printf 'grant three'");
    if (third.asked) {
      await until(() => completed(stack, thread, "printf 'grant three'"), (done) => done, "third command completed without a human reply", 30_000);
    }
    expect(await completed(stack, thread, "printf 'grant three'")).toBe(true);
    await stack.request("POST", "/opencode/instance/dispose");
    const sibling = await createThread(stack, "Sibling");
    const siblingTurn = await turn(stack, sibling, "printf 'grant one'");
    expect(siblingTurn.asked).not.toBeNull();
    await sleep(1_000);
    expect((await pendingFor(stack, sibling)).length).toBe(1);
    expect(await listThreadApprovals(stack.config, "ws_1", sibling)).toEqual([]);
    evidence.recordAssertionEvidence(
      "A thread's approval never replays for a sibling thread",
      `Sibling ${sibling} asked for the same command and kept waiting; OpenWork holds no grant for it.`,
      true,
    );
    if (siblingTurn.asked) {
      await stack.request("POST", `/opencode/permission/${encodeURIComponent(siblingTurn.asked.id)}/reply`, { reply: "reject" });
    }
  },
);
