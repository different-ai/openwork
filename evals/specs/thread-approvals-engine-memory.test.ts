import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
import { needs, test, unmetNeeds } from "@openwork/testkit";
import type { TestNeeds } from "@openwork/testkit";
import constants from "../../constants.json" with { type: "json" };

/**
 * The case for OpenWork owning thread approvals.
 *
 * "Allow for session" is an engine "always" reply. In the pinned engine that
 * grant lives in the memory of the per-directory instance, so it covers every
 * later matching call in that instance — until the instance is rebuilt, which
 * OpenWork does on config, skill, and MCP reloads, idle eviction, and engine
 * rollover. This spec drives the real engine with a scripted provider and
 * shows exactly that: the grant works, the instance is disposed, and the very
 * same thread asks again for a command the user already approved.
 */

const requirements: TestNeeds = { commands: ["opencode"] };
const missingRequirements = unmetNeeds(requirements, process.env);
const skipSuffix = missingRequirements.length > 0 ? ` skipped — needs: ${missingRequirements.join(", ")}` : "";

const providerId = "thread-approval-fixture";
const modelId = "thread-approval-model";
const AUTH = "Basic " + Buffer.from("probe:probe").toString("base64");

interface PendingPermission {
  id: string;
  sessionID: string;
  permission: string;
  patterns: string[];
  always: string[];
}

interface ToolState {
  command: string;
  status: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.unref();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (!address || typeof address === "string") {
        probe.close();
        reject(new Error("Failed to allocate a free port"));
        return;
      }
      probe.close(() => resolve(address.port));
    });
  });
}

/**
 * OpenAI-compatible stand-in: the first call of a turn returns a bash tool
 * call for the command named in the user's message (`RUN: <command>`); once a
 * tool result is present it answers with a fixed completion marker.
 */
function scriptedProvider(): Promise<{ server: Server; port: number }> {
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
        // A turn is: user prompt → one tool call → tool result → completion.
        // Only the most recent message decides which step this request is.
        const lastMessage = messages.at(-1);
        const hasToolResult = isRecord(lastMessage) && lastMessage.role === "tool";
        const lastUser = [...messages].reverse().find((message) => isRecord(message) && message.role === "user");
        const text = isRecord(lastUser)
          ? (typeof lastUser.content === "string"
            ? lastUser.content
            : Array.isArray(lastUser.content)
              ? lastUser.content.map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : "")).join("\n")
              : "")
          : "";
        const command = text.match(/RUN:\s*(.+)$/m)?.[1]?.trim() ?? "printf 'no command'";
        const id = `chatcmpl-${Date.now()}`;
        const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
          `data: ${JSON.stringify({ id, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
        response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        response.write(chunk({ role: "assistant" }));
        if (hasToolResult) {
          response.write(chunk({ content: "FIXTURE-DONE" }));
          response.write(chunk({}, "stop"));
        } else {
          response.write(chunk({
            tool_calls: [{ index: 0, id: `call_${Date.now()}`, type: "function", function: { name: "bash", arguments: JSON.stringify({ command }) } }],
          }));
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
      resolve({ server, port: address.port });
    });
  });
}

interface Engine {
  version: string;
  workspace: string;
  request: (method: string, path: string, body?: unknown) => Promise<unknown>;
  [Symbol.asyncDispose]: () => Promise<void>;
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGTERM");
  const graceful = await Promise.race([exited.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2_500))]);
  if (!graceful) {
    child.kill("SIGKILL");
    await exited;
  }
}

async function bootEngine(providerPort: number): Promise<Engine> {
  const root = await mkdtemp(join(tmpdir(), "openwork-thread-approval-engine-"));
  const workspace = join(root, "workspace");
  const xdg = join(root, "xdg");
  await Promise.all([mkdir(workspace, { recursive: true }), mkdir(join(xdg, "config", "opencode"), { recursive: true }), mkdir(join(root, "home"), { recursive: true })]);
  // The workspace asks before every shell command so the approval flow is
  // exercised; the provider is the local script above.
  await writeFile(join(workspace, "opencode.json"), JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    permission: { bash: "ask" },
    provider: {
      [providerId]: {
        npm: "@ai-sdk/openai-compatible",
        name: "Thread approval fixture",
        options: { baseURL: `http://127.0.0.1:${providerPort}/v1`, apiKey: "fixture-key" },
        models: { [modelId]: { name: "Thread approval fixture", tool_call: true } },
      },
    },
  }), "utf8");
  await writeFile(join(xdg, "config", "opencode", "opencode.json"), "{}", "utf8");

  const port = await freePort();
  const child = spawn("opencode", ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: workspace,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      OPENCODE_SERVER_USERNAME: "probe",
      OPENCODE_SERVER_PASSWORD: "probe",
      OPENCODE_TEST_HOME: join(root, "home"),
      XDG_CONFIG_HOME: join(xdg, "config"),
      XDG_DATA_HOME: join(xdg, "data"),
      XDG_CACHE_HOME: join(xdg, "cache"),
      XDG_STATE_HOME: join(xdg, "state"),
      OPENCODE_CLIENT: "openwork-test",
    },
  });
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => { stderr += chunk; });
  const baseUrl = `http://127.0.0.1:${port}`;
  const dispose = async () => {
    await stop(child);
    await rm(root, { recursive: true, force: true });
  };

  const request = async (method: string, path: string, body?: unknown): Promise<unknown> => {
    const url = new URL(path, baseUrl);
    url.searchParams.set("directory", workspace);
    const response = await fetch(url.toString(), {
      method,
      headers: { Authorization: AUTH, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`${method} ${path} → ${response.status} ${(await response.text()).slice(0, 300)}`);
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  };

  const deadline = Date.now() + 45_000;
  let version = "";
  while (Date.now() < deadline && !version) {
    if (child.exitCode !== null) break;
    try {
      const health = await request("GET", "/global/health");
      if (isRecord(health) && health.healthy === true && typeof health.version === "string") version = health.version;
    } catch {
      // not up yet
    }
    if (!version) await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!version) {
    await dispose();
    throw new Error(`opencode serve never became healthy: ${stderr.slice(0, 800)}`);
  }
  return { version, workspace, request, [Symbol.asyncDispose]: dispose };
}

async function pendingPermissions(engine: Engine): Promise<PendingPermission[]> {
  const value = await engine.request("GET", "/permission");
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => isRecord(entry) && typeof entry.id === "string" && typeof entry.sessionID === "string"
    ? [{
      id: entry.id,
      sessionID: entry.sessionID,
      permission: typeof entry.permission === "string" ? entry.permission : "",
      patterns: strings(entry.patterns),
      always: strings(entry.always),
    }]
    : []);
}

async function toolStates(engine: Engine, sessionId: string): Promise<ToolState[]> {
  const value = await engine.request("GET", `/session/${encodeURIComponent(sessionId)}/message`);
  if (!Array.isArray(value)) return [];
  return value.flatMap((message) => {
    const parts = isRecord(message) && Array.isArray(message.parts) ? message.parts : [];
    return parts.flatMap((part) => {
      if (!isRecord(part) || part.type !== "tool" || !isRecord(part.state)) return [];
      const input = isRecord(part.state.input) ? part.state.input : {};
      return [{ command: typeof input.command === "string" ? input.command : "", status: typeof part.state.status === "string" ? part.state.status : "" }];
    });
  });
}

async function sessionIdle(engine: Engine, sessionId: string): Promise<boolean> {
  const value = await engine.request("GET", "/session/status");
  const status = isRecord(value) ? value[sessionId] : undefined;
  return !isRecord(status) || status.type === "idle";
}

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, label: string, timeoutMs = 60_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T = await read();
  while (Date.now() < deadline) {
    if (done(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 250));
    last = await read();
  }
  throw new Error(`${label}: ${JSON.stringify(last)}`);
}

async function prompt(engine: Engine, sessionId: string, command: string): Promise<void> {
  await engine.request("POST", `/session/${encodeURIComponent(sessionId)}/prompt_async`, {
    model: { providerID: providerId, modelID: modelId },
    parts: [{ type: "text", text: `Run the fixture command.\nRUN: ${command}` }],
  });
}

/** Outcome of one prompt: either the engine asked (and we say what), or the tool ran without asking. */
async function runTurn(engine: Engine, sessionId: string, command: string): Promise<{ asked: PendingPermission | null }> {
  await prompt(engine, sessionId, command);
  const settled = await until(
    async () => ({
      pending: (await pendingPermissions(engine)).find((entry) => entry.sessionID === sessionId) ?? null,
      done: (await toolStates(engine, sessionId)).some((tool) => tool.command === command && tool.status === "completed"),
    }),
    (state) => state.pending !== null || state.done,
    `turn for ${command} neither asked nor completed`,
  );
  return { asked: settled.pending };
}

async function finishTurn(engine: Engine, sessionId: string, command: string): Promise<void> {
  await until(
    async () => ({
      completed: (await toolStates(engine, sessionId)).some((tool) => tool.command === command && tool.status === "completed"),
      idle: await sessionIdle(engine, sessionId),
    }),
    (state) => state.completed && state.idle,
    `turn for ${command} did not complete`,
  );
}

test.skipIf(missingRequirements.length > 0)(
  `the engine honours an always grant inside an instance and forgets it for the same thread once the instance is rebuilt${skipSuffix}`,
  { timeout: 240_000 },
  async ({ evidence }) => {
    needs(requirements);
    const provider = await scriptedProvider();
    try {
      await using engine = await bootEngine(provider.port);
      expect(engine.version).toBe(constants.opencodeVersion.replace(/^v/, ""));

      const created = await engine.request("POST", "/session", { title: "Thread approval memory" });
      if (!isRecord(created) || typeof created.id !== "string") throw new Error(`session.create returned ${JSON.stringify(created)}`);
      const thread = created.id;

      // Turn 1: the workspace asks; the user replies "always" to the engine's suggested pattern.
      const first = await runTurn(engine, thread, "printf 'grant one'");
      if (!first.asked) throw new Error("the first command did not ask");
      expect(first.asked.permission).toBe("bash");
      expect(first.asked.always.length).toBeGreaterThan(0);
      await engine.request("POST", `/permission/${encodeURIComponent(first.asked.id)}/reply`, { reply: "always" });
      await finishTurn(engine, thread, "printf 'grant one'");

      // Turn 2: same thread, same instance — the grant holds and nothing asks.
      const second = await runTurn(engine, thread, "printf 'grant two'");
      expect(second.asked).toBeNull();
      await finishTurn(engine, thread, "printf 'grant two'");
      evidence.recordAssertionEvidence(
        "An always grant covers later matching calls on the thread while the engine instance lives",
        `Reply "always" to ${JSON.stringify(first.asked.always)} on ${thread}; the next printf ran with no permission request.`,
        true,
      );

      // Rebuild the instance the way OpenWork does on every reload, then ask
      // the very same thread for another covered command.
      await engine.request("POST", "/instance/dispose");
      const third = await runTurn(engine, thread, "printf 'grant three'");
      expect(third.asked).not.toBeNull();
      expect(third.asked?.sessionID).toBe(thread);
      expect(third.asked?.permission).toBe("bash");
      evidence.recordAssertionEvidence(
        "An always grant survives an engine instance rebuild for the same thread",
        `After /instance/dispose, thread ${thread} asked again for ${JSON.stringify(third.asked?.patterns)} although ${JSON.stringify(first.asked.always)} was granted with "always" on this thread.`,
        false,
      );
      if (third.asked) {
        await engine.request("POST", `/permission/${encodeURIComponent(third.asked.id)}/reply`, { reply: "once" });
        await finishTurn(engine, thread, "printf 'grant three'");
      }
    } finally {
      await new Promise<void>((resolve) => provider.server.close(() => resolve()));
    }
  },
);
