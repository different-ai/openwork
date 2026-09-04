import { mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import type { Seed } from "@openwork/env";
import {
  bootManagedOpenworkServer,
  close,
  isRecord,
  listen,
  readBody,
  sendJson,
  sendStream,
  type ManagedOpenworkServer,
} from "./openwork-server-cli.ts";

export const MOCK_REPLY = "MOCK OK";

export type AgentUiContextProviderRequest = {
  model: string;
  toolResults: string[];
};

export type HandledUiControlItem = {
  id: string;
  kind: string;
  input: unknown;
  createdAt: number;
};

export interface FakeWindow {
  handled: HandledUiControlItem[];
  detach(): Promise<void>;
}

export interface AgentUiContextWorld extends AsyncDisposable {
  base: string;
  token: string;
  hostToken: string;
  workspaceId: string;
  requests: AgentUiContextProviderRequest[];
  engine(method: string, path: string, body?: unknown): Promise<unknown>;
  output(): string;
  attachWindow(context: Record<string, unknown>): Promise<FakeWindow>;
}

function toolResultContents(body: unknown): string[] {
  if (!isRecord(body) || !Array.isArray(body.messages)) return [];
  const results: string[] = [];
  for (const message of body.messages) {
    if (!isRecord(message) || message.role !== "tool") continue;
    const serialized = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
    results.push(serialized ?? "");
  }
  return results;
}

function mockProvider(requests: AgentUiContextProviderRequest[]): Server {
  return createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method === "POST" && url.pathname.endsWith("/chat/completions")) {
        const body: unknown = JSON.parse(await readBody(request));
        const toolResults = toolResultContents(body);
        requests.push({
          model: isRecord(body) && typeof body.model === "string" ? body.model : "?",
          toolResults,
        });
        const id = `chatcmpl-agent-ui-context-${requests.length}`;
        sendStream(response, toolResults.length === 0
          ? [
            { id, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] },
            { id, object: "chat.completion.chunk", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `call_openwork_context_${requests.length}`, type: "function", function: { name: "openwork_context", arguments: JSON.stringify({}) } }] }, finish_reason: null }] },
            { id, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
          ]
          : [
            { id, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] },
            { id, object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: MOCK_REPLY }, finish_reason: null }] },
            { id, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
          ]);
        return;
      }
      sendJson(response, 200, { object: "list", data: [] });
    })().catch((error: unknown) => {
      if (!response.headersSent) sendJson(response, 500, { error: String(error) });
      else response.destroy(error instanceof Error ? error : undefined);
    });
  });
}

function uiControlItems(value: unknown): HandledUiControlItem[] {
  if (!isRecord(value) || !Array.isArray(value.items)) {
    throw new Error(`Invalid UI control pending response: ${JSON.stringify(value)}`);
  }
  return value.items.map((item) => {
    if (!isRecord(item) || typeof item.id !== "string" || typeof item.kind !== "string" || typeof item.createdAt !== "number") {
      throw new Error(`Invalid UI control item: ${JSON.stringify(item)}`);
    }
    return { id: item.id, kind: item.kind, input: item.input, createdAt: item.createdAt };
  });
}

export async function agentUiContext(seed: Seed): Promise<AgentUiContextWorld> {
  const root = seed.tmpPath("agent-ui-context");
  await mkdir(root, { recursive: true });
  const scratch = await realpath(root);
  const workspace = join(scratch, "workspace");
  await mkdir(workspace, { recursive: true });

  const requests: AgentUiContextProviderRequest[] = [];
  const provider = mockProvider(requests);
  const providerUrl = await listen(provider);
  await writeFile(join(workspace, "opencode.json"), JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    provider: {
      mock: {
        npm: "@ai-sdk/openai-compatible",
        name: "Mock provider",
        options: { baseURL: `${providerUrl}/v1`, apiKey: "test" },
        models: {
          mock: {
            name: "mock",
            tool_call: true,
            reasoning: false,
            temperature: true,
            modalities: { input: ["text"], output: ["text"] },
            limit: { context: 128_000, output: 4_096 },
            cost: { input: 0, output: 0 },
          },
        },
      },
    },
  }, null, 2));

  const token = "agent-ui-context-client-token";
  let output = "";
  const sink = (chunk: string) => { output += chunk; };
  let managed: ManagedOpenworkServer | null = null;
  const windows = new Set<FakeWindow>();

  const dispose = async () => {
    const detachResults = await Promise.allSettled([...windows].map((window) => window.detach()));
    if (managed) await managed.stop();
    await close(provider);
    await rm(scratch, { recursive: true, force: true });
    const failed = detachResults.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  };

  try {
    managed = await bootManagedOpenworkServer({ scratch, workspace, token, sink });
    const server = managed;
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };

    const request = async (path: string, init: RequestInit, timeoutMs: number): Promise<unknown> => {
      const response = await fetch(`${server.base}${path}`, {
        ...init,
        headers,
        signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`${init.method ?? "GET"} ${path} → ${response.status}: ${text.slice(0, 400)}`);
      return text ? JSON.parse(text) : null;
    };

    const attachWindow = async (context: Record<string, unknown>): Promise<FakeWindow> => {
      const handled: HandledUiControlItem[] = [];
      const controller = new AbortController();
      let detached = false;
      let loopError: unknown = null;

      const handle = async (items: HandledUiControlItem[]) => {
        for (const item of items) {
          handled.push(item);
          const result = item.kind === "context"
            ? { ok: true, context }
            : { ok: false, error: "unsupported in fake window" };
          await request(`/experimental/ui-control/${encodeURIComponent(item.id)}/reply`, {
            method: "POST",
            body: JSON.stringify({ result }),
            signal: controller.signal,
          }, 5_000);
        }
      };

      // Establish the mailbox heartbeat before returning so an immediate context
      // request cannot race the first long poll and look disconnected.
      await handle(uiControlItems(await request("/experimental/ui-control/pending", { method: "GET", signal: controller.signal }, 5_000)));
      const loop = (async () => {
        while (!detached) {
          const value = await request("/experimental/ui-control/pending?wait=1", { method: "GET", signal: controller.signal }, 15_000);
          if (!detached) await handle(uiControlItems(value));
        }
      })().catch((error: unknown) => {
        if (!detached) loopError = error;
      });

      const fakeWindow: FakeWindow = {
        handled,
        async detach() {
          if (detached) return;
          detached = true;
          controller.abort();
          await loop;
          windows.delete(fakeWindow);
          if (loopError) throw loopError;
        },
      };
      windows.add(fakeWindow);
      return fakeWindow;
    };

    return {
      base: server.base,
      token,
      hostToken: `${token}-host`,
      workspaceId: server.workspaceId,
      requests,
      engine: server.engine,
      output: () => output,
      attachWindow,
      [Symbol.asyncDispose]: dispose,
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}
