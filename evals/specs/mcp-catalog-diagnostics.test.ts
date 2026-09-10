import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
import { needs, test } from "@openwork/testkit";
import { startCatalogWitness } from "../packages/labs/src/mock-mcp-catalog.ts";
import { bootServer, isRecord, stopChild } from "../worlds/openwork-server-cli.ts";

// New journey: operators can distinguish catalog failures in the real server's
// reconciliation response. Quick-add catalog specs exercise Den/UI, not this API.
test("catalog reconciliation attributes failures without leaking private auth or retaining revoked direct servers", async ({ evidence }) => {
  needs({ commands: ["bun"] });
  const root = await mkdtemp(join(tmpdir(), "mcp-catalog-diagnostics-"));
  const privateAuthorization = "Bearer catalog-private-test-token";
  const memberAuthorization = "Bearer catalog-member-test-token";
  const clientToken = "catalog-client-test-token";
  const witness = await startCatalogWitness(privateAuthorization);
  const children: ReturnType<typeof bootServer>["child"][] = [];
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("OPENWORK_") && !key.startsWith("OPENCODE")));
  const headers = { authorization: `Bearer ${clientToken}`, "content-type": "application/json" };
  const config = { type: "remote", url: `${witness.url}/mcp/agent`, enabled: true, oauth: false, headers: { Authorization: memberAuthorization } };
  const index = (servers: unknown[]) => JSON.stringify({ schemaVersion: "openwork.connect/mcp-servers/1", servers });
  async function boot(name: string, devMode: string) {
    const home = join(root, name);
    const workspace = join(home, "workspace");
    await mkdir(workspace, { recursive: true });
    const server = bootServer({
      ...inherited, HOME: home, XDG_CONFIG_HOME: join(home, "config"), XDG_DATA_HOME: join(home, "data"),
      XDG_STATE_HOME: join(home, "state"), XDG_CACHE_HOME: join(home, "cache"),
      OPENWORK_RUNTIME_DB: join(home, "runtime.sqlite"), OPENWORK_DEV_MODE: devMode,
      OPENWORK_OPENCODE_BASE_URL: witness.url, OPENWORK_MANAGE_OPENCODE: "0",
    }, clientToken, workspace, () => {});
    children.push(server.child);
    const base = await server.listening;
    const response = await fetch(`${base}/workspaces`, { headers, signal: AbortSignal.timeout(10_000) });
    expect(response.status).toBe(200);
    const payload: unknown = await response.json();
    if (!isRecord(payload) || !Array.isArray(payload.items) || !isRecord(payload.items[0]) || typeof payload.items[0].id !== "string") throw new Error("Missing workspace");
    return `${base}/workspace/${payload.items[0].id}/mcp/openwork-cloud/reconcile`;
  }
  async function reconcile(url: string, authorization?: string, enabled = true) {
    const response = await fetch(url, {
      method: "POST", headers, signal: AbortSignal.timeout(45_000),
      body: JSON.stringify({ config: { ...config, enabled }, ...(authorization === undefined ? {} : { appHostAuthorization: authorization }) }),
    });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain(privateAuthorization.slice("Bearer ".length));
    expect(text).not.toContain(memberAuthorization.slice("Bearer ".length));
    const body: unknown = JSON.parse(text);
    if (!isRecord(body)) throw new Error("Missing reconciliation result");
    return body;
  }
  async function expectResolveError(endpoint: string, code: string) {
    const response = await fetch(endpoint.replace("/mcp/openwork-cloud/reconcile", "/mcp-apps/resolve"), {
      method: "POST", headers, signal: AbortSignal.timeout(20_000),
      body: JSON.stringify({ launch: { connectionId: "catalog-connection", toolName: "show", resourceUri: "ui://fixture/app" } }),
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
    const text = await response.text();
    expect(text).not.toContain(privateAuthorization.slice("Bearer ".length));
    expect(text).not.toContain(memberAuthorization.slice("Bearer ".length));
    expect(JSON.parse(text)).toMatchObject({ code });
  }
  try {
    const endpoint = await boot("trusted-dev", "1");
    const disabled = await reconcile(endpoint, undefined, false);
    expect(disabled.connectCatalogDiagnostic).toBeUndefined();
    expect(disabled.firstFailure).toMatchObject({ code: "cloud_mcp_disabled" });
    expect((await reconcile(endpoint)).connectCatalogDiagnostic).toBe("missing_app_host_auth");
    await expectResolveError(endpoint, "connect_catalog_missing_app_host_auth");
    expect(witness.requests.filter((entry) => entry.privateAuth || entry.method === "resources/read")).toEqual([]);

    witness.catalog(index([]));
    expect((await reconcile(endpoint, privateAuthorization)).connectCatalogDiagnostic).toBe("empty");
    await expectResolveError(endpoint, "server_unavailable");
    expect(witness.requests.some((entry) => entry.method === "resources/read" && entry.privateAuth && entry.appHostCapability)).toBe(true);
    expect(witness.registrations.some((entry) => entry.name.startsWith("openwork-direct-"))).toBe(false);
    const descriptor = { connectionId: "catalog-connection", name: "Catalog fixture", description: null, url: `${witness.url}/mcp/agent/connections/catalog-connection`, exposeDirectly: true };
    witness.catalog(index([descriptor]));
    expect((await reconcile(endpoint)).connectCatalogDiagnostic).toBe("ready");
    const directName = witness.registrations.find((entry) => entry.name.startsWith("openwork-direct-"))?.name;
    expect(directName).toBeDefined();

    for (const invalid of ["not-json", JSON.stringify({ schemaVersion: "unsupported", servers: [] })]) {
      witness.catalog(invalid);
      expect((await reconcile(endpoint)).connectCatalogDiagnostic).toBe("invalid_catalog");
      await expectResolveError(endpoint, "connect_catalog_invalid_catalog");
    }
    expect(witness.disconnects).toContain(directName);
    const projectedCount = witness.registrations.filter((entry) => entry.name.startsWith("openwork-direct-")).length;
    witness.catalog(index([descriptor, { ...descriptor, connectionId: "rejected", url: "https://untrusted.invalid/mcp" }]));
    expect((await reconcile(endpoint)).connectCatalogDiagnostic).toBe("invalid_proxy_descriptor");
    await expectResolveError(endpoint, "connect_catalog_invalid_proxy_descriptor");
    for (const status of [401, 403, 404, 503]) {
      witness.catalog(index([]), status);
      expect((await reconcile(endpoint)).connectCatalogDiagnostic).toBe("discovery_unavailable");
      await expectResolveError(endpoint, "connect_catalog_discovery_unavailable");
    }
    expect(witness.registrations.filter((entry) => entry.name.startsWith("openwork-direct-"))).toHaveLength(projectedCount);
    expect(witness.registrations.every((entry) => !entry.privateAuth)).toBe(true);
    evidence.recordAssertionEvidence("Catalog failure attribution and fail-closed projection", "Real reconciliation HTTP responses distinguish missing auth, empty, ready, invalid JSON/schema, invalid proxy, and unavailable HTTP 401/403/404/503; revoked direct entry disconnected and no rejected catalog reprojected it. Engine registrations contain no private auth.", true);

    // Same loopback origin without the explicit development trust exception is
    // unactivated: supplying private auth must not send it to that origin.
    witness.catalog(index([]));
    const untrustedEndpoint = await boot("unactivated", "0");
    const privateRequestsBefore = witness.requests.filter((entry) => entry.privateAuth).length;
    expect((await reconcile(untrustedEndpoint, privateAuthorization)).connectCatalogDiagnostic).toBe("untrusted_origin");
    await expectResolveError(untrustedEndpoint, "connect_catalog_untrusted_origin");
    expect(witness.requests.filter((entry) => entry.privateAuth)).toHaveLength(privateRequestsBefore);
    evidence.recordAssertionEvidence("Unactivated origin cannot receive private App-host credentials", "An isolated non-development server reports untrusted_origin for the same unactivated origin; private request count does not increase. Reconciliation responses omit both bearer credentials.", true);
    evidence.recordAssertionEvidence("App resolve retains catalog failure attribution", "Real resolve HTTP errors distinguish missing private authorization, untrusted origin, invalid catalog/proxy and unavailable discovery from server_unavailable after successful empty discovery; no response exposes bearer credentials.", true);
  } finally {
    for (const child of children) await stopChild(child);
    await witness.stop();
    await rm(root, { recursive: true, force: true });
  }
});
