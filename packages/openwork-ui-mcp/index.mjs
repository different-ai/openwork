#!/usr/bin/env node

/**
 * openwork-ui-mcp
 *
 * MCP server that exposes OpenWork's UI control surface as MCP tools.
 * Speaks MCP stdio and proxies to the OpenWork desktop bridge HTTP API.
 *
 * Requires OpenWork desktop running with the local UI control bridge active.
 *
 * Usage:
 *   npx openwork-ui-mcp
 *
 * MCP config (OpenCode / Claude Desktop / Cursor / etc.):
 *   {
 *     "mcpServers": {
 *       "openwork-ui": {
 *         "command": "npx",
 *         "args": ["-y", "openwork-ui-mcp"]
 *       }
 *     }
 *   }
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// ── Bridge discovery ──

const DISCOVERY_PATHS = [
  join(homedir(), "Library", "Application Support", "com.differentai.openwork", "openwork-ui-control.json"),
  join(homedir(), "Library", "Application Support", "com.differentai.openwork.dev", "openwork-ui-control.json"),
];

async function discoverBridge() {
  for (const candidate of DISCOVERY_PATHS) {
    try {
      const raw = await readFile(candidate, "utf8");
      const parsed = JSON.parse(raw);
      if (typeof parsed.baseUrl === "string" && typeof parsed.token === "string") {
        return { baseUrl: parsed.baseUrl, token: parsed.token, path: candidate };
      }
    } catch {
      // Try next
    }
  }
  return null;
}

async function bridgeRequest(path, options = {}) {
  const bridge = await discoverBridge();
  if (!bridge) {
    return {
      ok: false,
      error: "OpenWork is not running. Launch the OpenWork desktop app first.",
      hint: "The MCP server connects to a running OpenWork instance via its local bridge.",
    };
  }
  const url = `${bridge.baseUrl}${path}`;
  try {
    const response = await fetch(url, {
      method: options.method || "GET",
      headers: {
        Authorization: `Bearer ${bridge.token}`,
        ...(options.body ? { "Content-Type": "application/json" } : {}),
      },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    });
    const text = await response.text();
    try {
      return JSON.parse(text);
    } catch {
      return { ok: false, error: text || `HTTP ${response.status}` };
    }
  } catch (error) {
    return { ok: false, error: `Bridge unreachable at ${url}: ${error.message}` };
  }
}

// ── MCP Server ──

const server = new McpServer({
  name: "openwork-ui",
  version: "0.1.0",
});

// ── ui.snapshot ──
server.tool(
  "ui_snapshot",
  "Get a snapshot of the current OpenWork UI state: active route, narration, visible actions, and status. Use this before taking action to understand what the user sees.",
  {},
  async () => {
    const result = await bridgeRequest("/snapshot");
    if (!result.ok && result.error) {
      return { content: [{ type: "text", text: `Error: ${result.error}${result.hint ? `\n${result.hint}` : ""}` }], isError: true };
    }
    const lines = [];
    if (result.route) lines.push(`Route: ${result.route}`);
    if (result.status) lines.push(`Status: ${result.status}`);
    if (result.narration) lines.push(`Narration: ${result.narration}`);
    if (result.busyActionId) lines.push(`Busy: ${result.busyActionId}`);
    if (Array.isArray(result.actions)) {
      lines.push(`\nActions (${result.actions.length}):`);
      for (const action of result.actions) {
        const args = action.args?.length ? ` [${action.args.map((a) => a.name).join(", ")}]` : "";
        lines.push(`  ${action.id} — ${action.label || action.description || ""}${args}`);
      }
    }
    return { content: [{ type: "text", text: lines.join("\n") || JSON.stringify(result, null, 2) }] };
  }
);

// ── ui.list_actions ──
server.tool(
  "ui_list_actions",
  "List all UI control actions currently available in OpenWork: session navigation, composer control, transcript access, and more. Each action has an id you can pass to ui_execute_action.",
  {},
  async () => {
    const result = await bridgeRequest("/actions");
    if (!result.ok && result.error) {
      return { content: [{ type: "text", text: `Error: ${result.error}` }], isError: true };
    }
    if (!Array.isArray(result.actions) || result.actions.length === 0) {
      return { content: [{ type: "text", text: "No actions available. Is OpenWork on the main screen?" }] };
    }
    const text = result.actions.map((a) => {
      const args = a.args?.length ? `\n    Args: ${a.args.map((p) => `${p.name}${p.required ? " (required)" : ""}: ${p.description || p.type || ""}`).join(", ")}` : "";
      return `${a.id}\n    ${a.label || ""}${a.description ? ` — ${a.description}` : ""}${args}`;
    }).join("\n\n");
    return { content: [{ type: "text", text: `${result.actions.length} actions:\n\n${text}` }] };
  }
);

// ── ui.execute_action ──
server.tool(
  "ui_execute_action",
  "Execute an OpenWork UI action by its id. Use ui_list_actions first to see available actions and their required arguments.",
  {
    actionId: z.string().describe("The action id from ui_list_actions, e.g. 'session.create_task' or 'composer.set_text'"),
    args: z.record(z.unknown()).optional().describe("JSON arguments for the action, if required"),
  },
  async ({ actionId, args }) => {
    const result = await bridgeRequest("/execute", {
      method: "POST",
      body: { actionId, args: args ?? {} },
    });
    if (!result.ok && result.error) {
      return { content: [{ type: "text", text: `Error executing ${actionId}: ${result.error}` }], isError: true };
    }
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

// ── ui.status ──
server.tool(
  "ui_status",
  "Check if OpenWork is running and the bridge is reachable. Returns connection status and app info.",
  {},
  async () => {
    const bridge = await discoverBridge();
    if (!bridge) {
      return { content: [{ type: "text", text: "OpenWork is not running.\nLaunch the OpenWork desktop app to enable UI control." }], isError: true };
    }
    try {
      const response = await fetch(`${bridge.baseUrl}/health`, { signal: AbortSignal.timeout(3000) });
      const data = await response.json();
      return { content: [{ type: "text", text: `Connected to ${data.app || "OpenWork"}\nBridge: ${bridge.baseUrl}\nVersion: ${data.version ?? "?"}` }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Bridge file found but not reachable: ${error.message}\nOpenWork may have quit. Relaunch it.` }], isError: true };
    }
  }
);

// ── Start ──
const transport = new StdioServerTransport();
await server.connect(transport);
