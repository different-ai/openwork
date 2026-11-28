import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createMcpEventWatches,
  listMcpEventServers,
  listMcpServerEvents,
  McpEventError,
  resetMcpServerEventsCacheForTests,
  type McpEventWatches,
} from "../src/mcp-server-events.js";
import { writeManagedDesktopPolicy, writeRuntimeOpencodeConfig } from "../src/runtime-opencode-config-store.js";
import type { ServerConfig } from "../src/types.js";

const EXTENSION = "io.modelcontextprotocol/events";
const chat = { sessionId: "ses_1", directory: "/work" };
type Poll = { events?: unknown[]; cursor?: string; truncated?: boolean; nextPollMs?: number };

/** An MCP server that offers one pollable and one webhook-only event, answers polls from a script, and records requests. */
function fakeServer(script: Poll[], extension = true) {
  const requests: Array<{ method: string; params: Record<string, unknown>; routing: [string | null, string | null] }> = [];
  const fetcher = async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    const headers = new Headers(init?.headers);
    requests.push({ method: body.method, params: body.params ?? {}, routing: [headers.get("mcp-method"), headers.get("mcp-name")] });
    if (body.method === "initialize") {
      return Response.json({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-06-18", capabilities: extension ? { extensions: { [EXTENSION]: {} } } : {} } });
    }
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (body.method === "events/list") {
      return Response.json({ jsonrpc: "2.0", id: body.id, result: { events: [
        { name: "issue.created", description: "A new issue.", delivery: ["webhook", "poll"], inputSchema: { type: "object" } },
        { name: "deploy.finished", delivery: ["webhook"], inputSchema: { type: "object" } },
      ] } });
    }
    const next = script.shift();
    if (!next) return new Response(null, { status: 503 });
    return Response.json({ jsonrpc: "2.0", id: body.id, result: { resultType: "complete", events: [], ...next } });
  };
  return { requests, fetcher, polls: () => requests.filter((request) => request.method === "events/poll") };
}

const issue = (id: string) => ({ eventId: id, name: "issue.created", timestamp: "2026-11-27T00:00:00Z", data: { title: `Issue ${id}` } });

describe("events from MCP servers", () => {
  let dir: string;
  let config: ServerConfig;
  let watches: McpEventWatches | undefined;
  const previousDb = process.env.OPENWORK_RUNTIME_DB;
  const delivered: Array<{ sessionId: string; text: string; sentBy: string }> = [];

  const start = (fetcher: ReturnType<typeof fakeServer>["fetcher"]) => {
    watches = createMcpEventWatches({
      config, options: { fetcher }, tickMs: 3_600_000,
      deliver: async (target, message) => { delivered.push({ sessionId: target.sessionId, ...message }); },
    });
    return watches;
  };
  const later = async (ms: number) => {
    setSystemTime(new Date(Date.now() + ms));
    await watches?.tick();
  };
  const watchIssues = (running: McpEventWatches) =>
    running.watch(chat, { server: "tracker", name: "issue.created", arguments: { repo: "app" }, instruction: "Tell me the title." });

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "openwork-mcp-events-"));
    process.env.OPENWORK_RUNTIME_DB = join(dir, "runtime.sqlite");
    config = {
      host: "127.0.0.1", port: 8787, token: "test", hostToken: "host-test", configPath: join(dir, "server.json"),
      approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [], workspaces: [], authorizedRoots: [], readOnly: false,
      startedAt: Date.now(), tokenSource: "generated", hostTokenSource: "generated", logFormat: "json", logRequests: false,
    };
    await writeRuntimeOpencodeConfig(config, "ws_1", (current) => ({ ...current, mcp: { tracker: { type: "remote", url: "https://issues.test/mcp" } } }));
    resetMcpServerEventsCacheForTests();
    delivered.length = 0;
  });

  afterEach(() => {
    watches?.close();
    watches = undefined;
    setSystemTime();
    resetMcpServerEventsCacheForTests();
    if (previousDb === undefined) delete process.env.OPENWORK_RUNTIME_DB;
    else process.env.OPENWORK_RUNTIME_DB = previousDb;
    rmSync(dir, { recursive: true, force: true });
  });

  test("names the servers that offer events and only the events it can poll", async () => {
    const { fetcher } = fakeServer([]);
    expect(await listMcpEventServers(config, { fetcher })).toEqual(["tracker"]);
    expect(await listMcpServerEvents(config, "tracker", { fetcher })).toEqual([{ name: "issue.created", description: "A new issue.", inputSchema: { type: "object" } }]);
    await expect(listMcpServerEvents(config, "other", { fetcher })).rejects.toBeInstanceOf(McpEventError);

    resetMcpServerEventsCacheForTests();
    expect(await listMcpEventServers(config, { fetcher: fakeServer([], false).fetcher })).toEqual([]);
  });

  test("a watch starts from now, then brings each new event to its chat once", async () => {
    const server = fakeServer([
      { events: [issue("old")], cursor: "c1", nextPollMs: 5_000 },
      { events: [issue("a"), issue("b")], cursor: "c2", nextPollMs: 5_000 },
      { events: [issue("b")], cursor: "c3", truncated: true, nextPollMs: 5_000 },
    ]);
    const running = start(server.fetcher);
    const watch = await watchIssues(running);
    expect(watch).toMatchObject({ server: "tracker", name: "issue.created", delivered: 0 });
    expect(delivered).toEqual([]);
    expect((await watchIssues(running)).id).toBe(watch.id);

    await later(1_000);
    expect(server.polls()).toHaveLength(1);
    await later(5_000);
    expect(delivered.map((message) => message.sessionId)).toEqual(["ses_1", "ses_1"]);
    expect(delivered[0]?.sentBy).toBe("tracker (MCP event)");
    expect(delivered[0]?.text).toContain("Saved instruction: Tell me the title.");
    expect(delivered[0]?.text).toContain("untrusted data from the MCP server");
    expect(delivered[0]?.text).toContain('"title":"Issue a"');

    await later(5_000);
    expect(delivered).toHaveLength(3);
    expect(delivered[2]?.text).toStartWith("An MCP event watch missed some events.");
    expect(server.polls().map((request) => request.params.cursor)).toEqual([null, "c1", "c2"]);
    expect(server.polls()[1]).toMatchObject({ params: { name: "issue.created", arguments: { repo: "app" } }, routing: ["events/poll", "issue.created"] });
    expect(running.list(chat)).toMatchObject([{ id: watch.id, delivered: 2 }]);
  });

  test("a watch ends with a notice after an hour or when its server is blocked", async () => {
    const running = start(fakeServer([{ cursor: "c1" }, { cursor: "c1" }]).fetcher);
    await watchIssues(running);
    await later(60 * 60_000 + 1_000);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.text).toStartWith("An MCP event watch ended.");
    expect(running.list(chat)).toEqual([]);

    await watchIssues(running);
    await writeManagedDesktopPolicy(config, { agentPermissions: { rules: [{ action: "mcp", resource: "*", effect: "deny", source: "Everyone" }] } });
    await later(31_000);
    expect(delivered).toHaveLength(2);
    expect(running.list(chat)).toEqual([]);
    await expect(watchIssues(running)).rejects.toBeInstanceOf(McpEventError);
  });

  test("a server that stops answering ends the watch after five failed polls", async () => {
    const running = start(fakeServer([{ cursor: "c1" }]).fetcher);
    await watchIssues(running);
    for (let attempt = 0; attempt < 4; attempt++) await later(31_000);
    expect(delivered).toEqual([]);
    expect(running.list(chat)).toHaveLength(1);
    await later(31_000);
    expect(delivered.map((message) => message.text.split(".")[0])).toEqual(["An MCP event watch ended"]);
    expect(running.list(chat)).toEqual([]);
  });

  test("stopping is limited to the chat that started the watch, and a refused first poll watches nothing", async () => {
    const running = start(fakeServer([{ cursor: "c1" }]).fetcher);
    const watch = await watchIssues(running);
    expect(await running.stop({ sessionId: "ses_other" }, watch.id)).toBe(false);
    expect(await running.stop(chat, watch.id)).toBe(true);
    expect(running.list(chat)).toEqual([]);
    expect(delivered).toEqual([]);

    await expect(watchIssues(running)).rejects.toBeInstanceOf(McpEventError);
    await expect(running.watch(chat, { server: "tracker", name: "deploy.finished", arguments: {}, instruction: "x" })).rejects.toBeInstanceOf(McpEventError);
  });
});
