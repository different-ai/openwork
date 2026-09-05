import { mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import type { Seed } from "@openwork/env";
import { startMockMcp } from "@openwork/labs";
import { bootManagedOpenworkServer, close, isRecord, listen, readBody, sendJson, sendStream } from "./openwork-server-cli.ts";

function gate() {
  let release: () => void = () => {};
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

/** Real managed engine and server, with the existing MCP witness and a paused model/tool response. */
export async function mcpRegistration(seed: Seed) {
  const root = seed.tmpPath("mcp-registration");
  await mkdir(root, { recursive: true });
  const scratch = await realpath(root);
  const workspace = join(scratch, "workspace");
  await mkdir(workspace);
  const witness = await startMockMcp({
    allowUnauthenticatedMcp: true,
    tools: [{ name: "ping", description: "Check the connection", inputSchema: { type: "object", properties: {} }, result: { content: [{ type: "text", text: "pong" }] } }],
  });
  let pause: "model" | "tool" | "initialize" | null = null;
  let entered = gate();
  let release = gate();
  let initializations = 0;
  const wait = async (stage: "model" | "tool" | "initialize") => {
    if (pause !== stage) return;
    entered.release();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([release.promise, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out at ${stage} gate`)), 30_000);
      })]);
    } finally { clearTimeout(timer); }
  };
  const proxy = createServer(async (request, response) => {
    try {
      if (request.method !== "POST") return sendJson(response, 405, {});
      const raw = await readBody(request);
      const body: unknown = JSON.parse(raw);
      if (isRecord(body) && body.method === "initialize") {
        initializations += 1;
        await wait("initialize");
      }
      if (isRecord(body) && body.method === "tools/call") await wait("tool");
      const upstream = await fetch(witness.mcpUrl, {
        method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: raw, signal: AbortSignal.timeout(15_000),
      });
      response.writeHead(upstream.status, Object.fromEntries(upstream.headers));
      response.end(await upstream.text());
    } catch (error) { sendJson(response, 500, { error: String(error) }); }
  });
  const mcpUrl = await listen(proxy);
  const provider = createServer(async (request, response) => {
    try {
      const body: unknown = JSON.parse(await readBody(request));
      if (!isRecord(body)) throw new Error("Expected model request");
      const tools = Array.isArray(body.tools) ? body.tools.filter(isRecord) : [];
      const tool = tools.find((item) => isRecord(item.function) && item.function.name === "race_ping");
      const hasResult = Array.isArray(body.messages) && body.messages.some((message) => isRecord(message) && message.role === "tool");
      const call = Boolean(tool) && !hasResult;
      if (call) await wait("model");
      const delta = call
        ? { tool_calls: [{ index: 0, id: "call_ping", type: "function", function: { name: "race_ping", arguments: "{}" } }] }
        : { content: "Done." };
      sendStream(response, [
        { id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] },
        { id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: call ? "tool_calls" : "stop" }] },
      ]);
    } catch (error) { sendJson(response, 500, { error: String(error) }); }
  });
  const providerUrl = await listen(provider);
  const mcpConfig = { type: "remote", url: mcpUrl, oauth: false, enabled: true };
  await writeFile(join(workspace, "opencode.json"), JSON.stringify({
    permission: "allow", mcp: { race: mcpConfig },
    model: "mock/mock", small_model: "mock/mock",
    provider: { mock: { npm: "@ai-sdk/openai-compatible", name: "Mock", options: { baseURL: `${providerUrl}/v1`, apiKey: "fixture" }, models: { mock: { name: "Mock", tool_call: true, limit: { context: 32_768, output: 4_096 } } } } },
  }));
  const token = "mcp-registration-fixture";
  let output = "";
  let managed: Awaited<ReturnType<typeof bootManagedOpenworkServer>> | undefined;
  const dispose = async () => {
    release.release();
    if (managed) await managed.stop();
    await close(provider);
    await close(proxy);
    await witness.stop();
    await rm(scratch, { recursive: true, force: true });
  };
  try {
    managed = await bootManagedOpenworkServer({ scratch, workspace, token, sink: (chunk) => { output += chunk; } });
    const running = managed;
    return {
      engine: running.engine,
      initializations: () => initializations,
      toolCalls: () => witness.toolCalls(),
      output: () => output,
      pause(stage: "model" | "tool" | "initialize") { pause = stage; entered = gate(); release = gate(); },
      async entered() {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([entered.promise, new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`No ${pause} request arrived:\n${output.slice(-3_000)}`)), 30_000);
          })]);
        } finally { clearTimeout(timer); }
      },
      release() { pause = null; release.release(); },
      async register(revision = "original") {
        const response = await fetch(`${running.base}/workspace/${running.workspaceId}/mcp`, {
          method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({ name: "race", config: { ...mcpConfig, headers: { "x-fixture-revision": revision } } }),
          signal: AbortSignal.timeout(20_000),
        });
        if (!response.ok) throw new Error(`MCP registration failed: ${response.status} ${await response.text()}`);
      },
      [Symbol.asyncDispose]: dispose,
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}
