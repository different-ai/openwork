import { describe, expect, test } from "bun:test";
import type { McpServerEntry, McpStatus, McpStatusMap } from "../src/app/types";
import {
  composerConnectorEntries,
  connectedFirst,
  mcpEntryStatus,
} from "../src/react-app/domains/session/surface/composer/composer-connections";

const remote = (name: string, extra: Partial<McpServerEntry> = {}): McpServerEntry => ({
  name,
  config: { type: "remote", url: `https://${name}.example.com/mcp` },
  ...extra,
});

const local = (name: string): McpServerEntry => ({ name, config: { type: "local", command: ["node", "server.js"] } });

const entries = (servers: McpServerEntry[], statuses?: McpStatusMap, connectingId: string | null = null) =>
  composerConnectorEntries({
    servers,
    statuses,
    orgConnections: [],
    connectingId,
    noteFor: (status: McpStatus | undefined) => (status?.status === "failed" ? "Issue" : null),
  });

describe("mcpEntryStatus", () => {
  test("prefers the id, then the name, and knows nothing without statuses", () => {
    const statuses: McpStatusMap = { "org-mcp:1": { status: "connected" }, notes: { status: "disabled" } };
    expect(mcpEntryStatus(remote("x", { id: "org-mcp:1" }), statuses)).toEqual({ status: "connected" });
    expect(mcpEntryStatus(remote("notes"), statuses)).toEqual({ status: "disabled" });
    expect(mcpEntryStatus(remote("other"), statuses)).toBeUndefined();
    expect(mcpEntryStatus(remote("notes"), undefined)).toBeUndefined();
  });
});

describe("composerConnectorEntries", () => {
  test("counts a server as connected only when the engine says so", () => {
    const result = entries(
      [remote("notes"), remote("linear"), remote("broken"), remote("unknown")],
      { notes: { status: "connected" }, linear: { status: "disabled" }, broken: { status: "failed", error: "boom" } },
    );
    expect(result.map((entry) => [entry.name, entry.connected])).toEqual([
      ["notes", true],
      ["linear", false],
      ["broken", false],
      ["unknown", false],
    ]);
  });

  test("everything is unconnected before any status is known", () => {
    expect(entries([remote("notes"), local("files")], undefined).every((entry) => !entry.connected)).toBe(true);
  });

  test("offers sign-in for an organization connection that needs it", () => {
    const [needsAuth, reconnect] = entries(
      [remote("slack", { orgMcpConnectionId: "c1" }), remote("jira", { orgMcpConnectionId: "c2" })],
      { slack: { status: "needs_auth" }, jira: { status: "reconnect_required" } },
      "c2",
    );
    expect(needsAuth.signIn).toEqual({ connectionId: "c1", reconnect: false });
    expect(needsAuth.connecting).toBe(false);
    expect(needsAuth.note).toBeNull();
    expect(reconnect.signIn).toEqual({ connectionId: "c2", reconnect: true });
    expect(reconnect.connecting).toBe(true);
  });

  test("a local server that needs sign-in has no action to offer", () => {
    const [entry] = entries([local("files")], { files: { status: "needs_auth" } });
    expect(entry.signIn).toBeNull();
    expect(entry.connected).toBe(false);
  });

  test("shows the note instead of an action for a failed server", () => {
    const [entry] = entries([remote("broken")], { broken: { status: "failed", error: "boom" } });
    expect(entry.signIn).toBeNull();
    expect(entry.note).toBe("Issue");
  });

  test("keys by id when there is one, and exposes the service url of remote servers only", () => {
    const [withId, localEntry] = entries([remote("notes", { id: "org-mcp:1" }), local("files")]);
    expect(withId.key).toBe("org-mcp:1");
    expect(withId.serviceUrl).toBe("https://notes.example.com/mcp");
    expect(localEntry.key).toBe("files");
    expect(localEntry.serviceUrl).toBeUndefined();
  });
});

describe("connectedFirst", () => {
  test("puts connected entries first and keeps each group in order", () => {
    const rows = [
      { key: "a", connected: false },
      { key: "b", connected: true },
      { key: "c", connected: false },
      { key: "d", connected: true },
    ];
    expect(connectedFirst(rows).map((row) => row.key)).toEqual(["b", "d", "a", "c"]);
    expect(rows.map((row) => row.key)).toEqual(["a", "b", "c", "d"]);
  });
});
