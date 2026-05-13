#!/usr/bin/env node

/**
 * openwork-atomic-chat-mcp
 *
 * Stdio MCP server that exposes tools calling [Atomic Chat](https://github.com/AtomicBot-ai/Atomic-Chat)'s
 * OpenAI-compatible HTTP API. Atomic Chat itself is an MCP *client* in its UI; this package is a small *server*
 * so OpenCode / OpenWork agents can invoke Atomic-backed completions alongside the session model.
 *
 * Prerequisites: Atomic Chat running with the local API (default `http://localhost:1337/v1`).
 *
 * Environment:
 *   ATOMIC_CHAT_BASE_URL — default `http://localhost:1337/v1`
 *   ATOMIC_CHAT_API_KEY  — optional `Authorization: Bearer …` if your Atomic build requires a key
 *
 * OpenCode / OpenWork (workspace `.config/opencode/opencode.json` or root `opencode.jsonc`):
 *   "mcp": {
 *     "atomic-chat": {
 *       "type": "local",
 *       "command": ["npx", "-y", "openwork-atomic-chat-mcp"],
 *       "environment": {
 *         "ATOMIC_CHAT_BASE_URL": "http://localhost:1337/v1"
 *       }
 *     }
 *   }
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const DEFAULT_BASE = "http://localhost:1337/v1";
const REQUEST_TIMEOUT_MS = 180_000;

function baseUrl() {
  return (process.env.ATOMIC_CHAT_BASE_URL || DEFAULT_BASE).trim().replace(/\/+$/, "");
}

function authHeaders() {
  const key = process.env.ATOMIC_CHAT_API_KEY?.trim();
  if (!key) return {};
  return { Authorization: `Bearer ${key}` };
}

async function atomicFetch(path, { method = "GET", body } = {}) {
  const url = `${baseUrl()}${path.startsWith("/") ? path : `/${path}`}`;
  try {
    const response = await fetch(url, {
      method,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        ...authHeaders(),
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    let parsed;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      return {
        ok: false,
        error: `Non-JSON response (${response.status}): ${text.slice(0, 500)}`,
      };
    }
    if (!response.ok) {
      const msg = parsed?.error?.message || parsed?.message || JSON.stringify(parsed);
      return { ok: false, error: `HTTP ${response.status}: ${msg}` };
    }
    return { ok: true, data: parsed };
  } catch (err) {
    return {
      ok: false,
      error: `Request to ${url} failed: ${err.message}. Is Atomic Chat running? See https://github.com/AtomicBot-ai/Atomic-Chat`,
    };
  }
}

const server = new McpServer({
  name: "openwork-atomic-chat",
  version: "0.1.0",
});

server.tool(
  "atomic_list_models",
  "List models available from Atomic Chat's OpenAI-compatible API. Use the returned `id` as `model` in atomic_chat_completion.",
  {},
  async () => {
    const result = await atomicFetch("/models");
    if (!result.ok) {
      return { content: [{ type: "text", text: result.error }], isError: true };
    }
    const models = result.data?.data;
    if (!Array.isArray(models)) {
      return {
        content: [{ type: "text", text: `Unexpected payload: ${JSON.stringify(result.data).slice(0, 800)}` }],
        isError: true,
      };
    }
    const lines = models.map((m) => `${m.id}${m.id !== m.name && m.name ? ` (${m.name})` : ""}`);
    return {
      content: [
        {
          type: "text",
          text: lines.length ? lines.join("\n") : "No models returned. Open Atomic Chat and load a model.",
        },
      ],
    };
  }
);

server.tool(
  "atomic_chat_completion",
  "Run a non-streaming chat completion via Atomic Chat (isolated from the main OpenWork session LLM). Use for a second local opinion, summarization, or long-running local generation.",
  {
    model: z.string().describe("Model id from atomic_list_models"),
    messages: z
      .array(
        z.object({
          role: z.enum(["system", "user", "assistant"]),
          content: z.string(),
        })
      )
      .min(1)
      .describe("Chat messages; typically end with a user message"),
    temperature: z.number().optional().describe("Sampling temperature"),
    max_tokens: z.number().optional().describe("Max tokens to generate"),
  },
  async ({ model, messages, temperature, max_tokens }) => {
    const body = {
      model,
      messages,
      stream: false,
      ...(temperature !== undefined ? { temperature } : {}),
      ...(max_tokens !== undefined ? { max_tokens } : {}),
    };
    const result = await atomicFetch("/chat/completions", { method: "POST", body });
    if (!result.ok) {
      return { content: [{ type: "text", text: result.error }], isError: true };
    }
    const choice = result.data?.choices?.[0];
    const content = choice?.message?.content;
    if (typeof content === "string" && content.length > 0) {
      return { content: [{ type: "text", text: content }] };
    }
    return {
      content: [{ type: "text", text: JSON.stringify(result.data, null, 2).slice(0, 12_000) }],
    };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
