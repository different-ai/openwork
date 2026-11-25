/** @jsxImportSource react */
import { describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";

import type { OpencodeConnectionsPreview } from "../src/app/lib/opencode-connections-import";
import { OpenworkServerError } from "../src/app/lib/openwork-server";
import { readChatEngineMcpStatus } from "../src/react-app/domains/connections/chat-engine-mcp-status";
import {
  OpencodeConnectionsImport,
  opencodeImportProblemRows,
  opencodeImportReceiptRows,
} from "../src/react-app/domains/connections/opencode-connections-import";

function render(preview: OpencodeConnectionsPreview): string {
  const queryClient = new QueryClient();
  queryClient.setQueryData(["opencode-import", "connections", "ws_one"], preview);
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <OpencodeConnectionsImport
        source={{ workspaceId: "ws_one", preview: async () => preview, importConnections: async () => [] }}
        stateOf={() => null}
      />
    </QueryClientProvider>,
  );
}

describe("the Import from OpenCode line in Settings", () => {
  test("says how many connections are not in OpenWork and offers to import them", () => {
    const html = render({
      source: "found",
      items: [
        { name: "notes", kind: "local", target: "notes-mcp", status: "new" },
        { name: "tracker", kind: "remote", target: "mcp.example.com", status: "new" },
        { name: "files", kind: "local", target: "files-mcp", status: "already_present" },
      ],
    });
    expect(html).toContain("2 connections in OpenCode are not in OpenWork");
    expect(html).toContain("notes, tracker");
    expect(html).toContain("Import from OpenCode");
    expect(html).not.toContain("files");
    expect(html).not.toContain("mcp.example.com");
  });

  test("shows nothing when OpenCode has nothing to bring over", () => {
    expect(render({ source: "missing", items: [] })).toBe("");
    expect(render({ source: "invalid", items: [] })).toBe("");
    expect(render({ source: "found", items: [{ name: "files", kind: "local", target: "files-mcp", status: "already_present" }] })).toBe("");
  });

  test("a blocked connection is a quiet row with the reason, and is not offered for import", () => {
    const html = render({
      source: "found",
      items: [
        { name: "tracker", kind: "remote", target: "mcp.example.com", status: "blocked", reason: "Your organization does not allow this connection." },
        { name: "broken", status: "invalid", reason: "It needs a command to run." },
      ],
    });
    expect(html).toContain("2 connections in OpenCode can&#x27;t be imported");
    expect(html).toContain("Blocked by your organization");
    expect(html).toContain("It needs a command to run.");
    expect(html).not.toContain("Import from OpenCode");
  });

  test("problem rows mark only blocked entries as blocked", () => {
    expect(opencodeImportProblemRows([
      { name: "notes", status: "new" },
      { name: "tracker", status: "blocked" },
      { name: "broken", status: "invalid", reason: "It needs a command to run." },
    ])).toEqual([
      { name: "tracker", detail: "Blocked by your organization", blocked: true, attention: true },
      { name: "broken", detail: "It needs a command to run.", blocked: false, attention: true },
    ]);
  });

  test("the receipt shows each imported connection's real state and what was left out", () => {
    const states: Record<string, { label: string; ready: boolean }> = {
      notes: { label: "Ready", ready: true },
      tracker: { label: "Sign in needed", ready: false },
    };
    expect(opencodeImportReceiptRows([
      { name: "notes", status: "imported" },
      { name: "tracker", status: "imported" },
      { name: "slow", status: "imported" },
      { name: "files", status: "already_present" },
      { name: "wiki", status: "blocked", message: "Your organization does not allow this connection." },
      { name: "broken", status: "invalid", message: "It needs a command to run." },
      { name: "db", status: "failed", message: "OpenWork could not save this connection." },
    ], (name) => states[name] ?? null)).toEqual([
      { name: "notes", detail: "Ready", blocked: false, attention: false },
      { name: "tracker", detail: "Sign in needed", blocked: false, attention: true },
      { name: "slow", detail: "Checking…", blocked: false, attention: false },
      { name: "wiki", detail: "Blocked by your organization", blocked: true, attention: true },
      { name: "broken", detail: "It needs a command to run.", blocked: false, attention: true },
      { name: "db", detail: "OpenWork could not save this connection.", blocked: false, attention: true },
    ]);
  });
});

describe("connection status comes from the engine that runs chats", () => {
  const preview = (chatRouting: boolean) => async () => ({ enabled: chatRouting, chatRouting });
  const olderEngine = async () => ({ notes: { status: "connected" as const }, tracker: { status: "connected" as const } });
  const chatEngine = async () => ({ data: [{ name: "notes", status: { status: "connected" } }] });

  test("when chats run on the newer engine, a connection it never registered is not reported as connected", async () => {
    const statuses = await readChatEngineMcpStatus({
      getEngineV2PreviewStatus: preview(true),
      getMcpStatus: olderEngine,
      getChatEngineMcpCatalog: chatEngine,
    }, "ws_one");
    expect(statuses).toEqual({ notes: { status: "connected" } });
  });

  test("when chats run on the older engine, its status is used", async () => {
    const statuses = await readChatEngineMcpStatus({
      getEngineV2PreviewStatus: preview(false),
      getMcpStatus: olderEngine,
      getChatEngineMcpCatalog: chatEngine,
    }, "ws_one");
    expect(Object.keys(statuses)).toEqual(["notes", "tracker"]);
  });

  test("a server without the newer engine uses the older engine's status", async () => {
    const statuses = await readChatEngineMcpStatus({
      getEngineV2PreviewStatus: async () => { throw new OpenworkServerError(404, "not_found", "Not found"); },
      getMcpStatus: olderEngine,
      getChatEngineMcpCatalog: chatEngine,
    }, "ws_one");
    expect(Object.keys(statuses)).toEqual(["notes", "tracker"]);
  });
});
