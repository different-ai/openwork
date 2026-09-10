import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
import { needs, test } from "@openwork/testkit";
import { startCatalogTransportWitness, type CatalogTransportMode } from "../packages/labs/src/mock-mcp-catalog-transport.ts";
import { bootServer, isRecord, stopChild } from "../worlds/openwork-server-cli.ts";

// New interoperability journey: a real server's catalog API reads a remote MCP
// resource. No product imports, provider credentials, or test-runner subprocesses.
// https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle
// https://modelcontextprotocol.io/specification/2025-06-18/basic/transports
const modes: CatalogTransportMode[] = [
  "json", "sse-lf", "sse-cr", "sse-crlf", "older-version", "unsupported-version", "missing-version",
  "initialize-error", "notification-rejected", "notification-rpc-error", "read-error", "wrong-id", "wrong-json-id", "unfinished-stream",
];
for (const mode of modes) {
  test(`catalog transport: ${mode}`, { timeout: 90_000 }, async ({ evidence }) => {
    needs({ commands: ["bun"] });
    const root = await mkdtemp(join(tmpdir(), "openwork-catalog-transport-"));
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const witness = await startCatalogTransportWitness(mode);
    const token = "synthetic-catalog-client";
    const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("OPENWORK_") && !key.startsWith("OPENCODE")));
    const server = bootServer({
      ...inherited, HOME: root, XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"),
      XDG_STATE_HOME: join(root, "state"), XDG_CACHE_HOME: join(root, "cache"),
      OPENWORK_RUNTIME_DB: join(root, "runtime.sqlite"), OPENWORK_ENCRYPTION_KEY: "synthetic-catalog-vault-key",
      OPENWORK_ALLOW_PRIVATE_MCP_URLS: "1",
    }, token, workspace, () => {});
    try {
      const base = await server.listening;
      const request = (path: string, method = "GET", body?: unknown) => fetch(`${base}${path}`, {
        method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20_000),
      });
      const workspaces: unknown = await (await request("/workspaces")).json();
      if (!isRecord(workspaces) || !Array.isArray(workspaces.items) || !isRecord(workspaces.items[0]) || typeof workspaces.items[0].id !== "string") throw new Error("Workspace missing");
      const configured = await request(`/workspace/${workspaces.items[0].id}/config`, "PATCH", {
        opencode: { mcp: { "openwork-cloud": {
          type: "remote", url: witness.url, enabled: true, oauth: false,
          headers: { Authorization: "Bearer synthetic-catalog-token", "MCP-Protocol-Version": "invalid-configured-version" },
        } } },
      });
      expect(configured.status, await configured.text()).toBe(200);
      expect((await fetch(witness.url, { signal: AbortSignal.timeout(5_000) })).status).toBe(405);
      const started = Date.now();
      const response = await request("/experimental/connect/skills");
      const catalog: unknown = await response.json();
      expect(response.status).toBe(200);
      const success = ["json", "sse-lf", "sse-cr", "sse-crlf", "older-version"].includes(mode);
      expect(catalog).toMatchObject({ ok: true, skills: success ? [witness.skill] : [] });
      expect(Date.now() - started).toBeLessThan(15_000);
      expect(witness.requests.length).toBeGreaterThan(0);
      const methods = witness.requests.map((entry) => entry.rpc.method);
      if (["unsupported-version", "missing-version", "initialize-error"].includes(mode)) {
        expect(methods.every((method) => method === "initialize")).toBe(true);
      } else {
        for (const entry of witness.requests.filter((entry) => entry.rpc.method !== "initialize")) {
          expect(entry.headers["mcp-protocol-version"]).toBe(witness.version);
          expect(entry.headers["mcp-session-id"]).toBe("synthetic-session");
        }
        expect(methods).toContain("notifications/initialized");
        if (mode.startsWith("notification-")) expect(methods).not.toContain("resources/read");
        else expect(methods).toContain("resources/read");
      }
      for (const entry of witness.requests) {
        expect(entry.headers.authorization).toBe("Bearer synthetic-catalog-token");
        expect(entry.headers.accept).toContain("application/json");
        expect(entry.headers.accept).toContain("text/event-stream");
      }
      evidence.recordAssertionEvidence(`Catalog interoperability: ${mode}`,
        `${success ? "Witness skill visible" : "No skill leaked from rejected exchange"}; HTTP 200; bounded completion; ${methods.join(", ")}; negotiated version/session and auth headers asserted. GET 405 does not prevent POST discovery.`, true);
    } finally {
      await stopChild(server.child);
      await witness.stop();
      await rm(root, { recursive: true, force: true });
    }
  });
}
