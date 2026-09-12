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

/**
 * A real openwork-server + managed engine whose provider is a scripted
 * OpenAI-compatible stand-in. The mock model does what its user message says:
 * a message containing `TOOL_CALL: <json>` makes it call that OpenWork tool
 * once, then it answers MOCK_REPLY. Every provider request is recorded with
 * the model and `reasoning_effort` it carried, so a spec can prove not only
 * that a session's record says "low" but that its turn ran at low.
 */

export const MOCK_REPLY = "MOCK OK";
export const PROVIDER_ID = "mock";
export const MODEL_ID = "reasoning-mock";
export const TOOL_CALL_MARKER = "TOOL_CALL:";

export type AgentSessionModelProviderRequest = {
  model: string;
  /** The wire value of `reasoning_effort`; null when the request carried none. */
  reasoningEffort: string | null;
  /** Text of the newest user message, so a request can be attributed to a session's prompt. */
  userText: string;
  toolResults: number;
};

export interface AgentSessionModelWorld extends AsyncDisposable {
  base: string;
  token: string;
  workspaceId: string;
  requests: AgentSessionModelProviderRequest[];
  engine(method: string, path: string, body?: unknown): Promise<unknown>;
  output(): string;
}

function messageText(message: unknown): string {
  if (!isRecord(message)) return "";
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content.map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : "")).join("\n");
}

function scriptedToolCall(userText: string): { name: string; arguments: string } | null {
  const index = userText.indexOf(TOOL_CALL_MARKER);
  if (index < 0) return null;
  const raw = userText.slice(index + TOOL_CALL_MARKER.length).trim();
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed) || typeof parsed.name !== "string") throw new Error(`Invalid scripted tool call: ${raw}`);
  return { name: parsed.name, arguments: JSON.stringify(parsed.arguments ?? {}) };
}

function mockProvider(requests: AgentSessionModelProviderRequest[]): Server {
  return createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method === "POST" && url.pathname.endsWith("/chat/completions")) {
        const body: unknown = JSON.parse(await readBody(request));
        const messages = isRecord(body) && Array.isArray(body.messages) ? body.messages : [];
        // Only the current turn decides the step: tool results from earlier
        // turns stay in the history and must not suppress a new scripted call.
        const lastUserIndex = messages.findLastIndex((message) => isRecord(message) && message.role === "user");
        const toolResults = messages.slice(lastUserIndex + 1).filter((message) => isRecord(message) && message.role === "tool").length;
        const userText = messageText(messages[lastUserIndex]);
        const reasoningEffort = isRecord(body) && typeof body.reasoning_effort === "string" ? body.reasoning_effort : null;
        requests.push({
          model: isRecord(body) && typeof body.model === "string" ? body.model : "?",
          reasoningEffort,
          userText,
          toolResults,
        });
        const id = `chatcmpl-agent-session-model-${requests.length}`;
        const toolCall = toolResults === 0 ? scriptedToolCall(userText) : null;
        sendStream(response, toolCall
          ? [
            { id, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] },
            { id, object: "chat.completion.chunk", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `call_${requests.length}`, type: "function", function: toolCall }] }, finish_reason: null }] },
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

export async function agentSessionModel(seed: Seed): Promise<AgentSessionModelWorld> {
  const root = seed.tmpPath("agent-session-model");
  await mkdir(root, { recursive: true });
  const scratch = await realpath(root);
  const workspace = join(scratch, "workspace");
  await mkdir(workspace, { recursive: true });

  const requests: AgentSessionModelProviderRequest[] = [];
  const provider = mockProvider(requests);
  const providerUrl = await listen(provider);
  await writeFile(join(workspace, "opencode.json"), JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    provider: {
      [PROVIDER_ID]: {
        npm: "@ai-sdk/openai-compatible",
        name: "Mock provider",
        options: { baseURL: `${providerUrl}/v1`, apiKey: "test" },
        models: {
          [MODEL_ID]: {
            name: "Reasoning mock",
            tool_call: true,
            reasoning: true,
            temperature: true,
            modalities: { input: ["text"], output: ["text"] },
            limit: { context: 128_000, output: 4_096 },
            cost: { input: 0, output: 0 },
            // The effort variants a real reasoning model exposes; each one is
            // visible on the wire as `reasoning_effort`.
            variants: { low: { reasoningEffort: "low" }, high: { reasoningEffort: "high" } },
          },
        },
      },
    },
  }, null, 2));

  const token = "agent-session-model-client-token";
  let output = "";
  const sink = (chunk: string) => { output += chunk; };
  let managed: ManagedOpenworkServer | null = null;

  const dispose = async () => {
    if (managed) await managed.stop();
    await close(provider);
    await rm(scratch, { recursive: true, force: true });
  };

  try {
    managed = await bootManagedOpenworkServer({ scratch, workspace, token, sink });
    return {
      base: managed.base,
      token,
      workspaceId: managed.workspaceId,
      requests,
      engine: managed.engine,
      output: () => output,
      [Symbol.asyncDispose]: dispose,
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}
