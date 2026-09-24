import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { resolveEvalEngine, SkipError, type Seed } from "@openwork/env";
import { readHeadlessRuntimeManifest, resolveHeadlessWorldRuntimePaths } from "@openwork/world";
import { sessionlessFirstSendWorld } from "./first-run.ts";
import { eventually } from "@openwork/testkit";

export async function localSendDenOutageWorld(seed: Seed) {
  if (resolveEvalEngine() !== "v1") throw new SkipError("DEN-LOCAL-SEND requires the real v1 engine");
  const base = await sessionlessFirstSendWorld(seed);
  await using setup = new AsyncDisposableStack();
  let unavailable = false;
  const counts: { method: string; path: string; status: number; count: number }[] = [];
  const den = createServer((request, response) => {
    const method = request.method ?? "GET";
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    const status = unavailable ? 503 : method === "GET" && path === "/v1/me/desktop-config" ? 200 : 404;
    const existing = counts.find((entry) => entry.method === method && entry.path === path && entry.status === status);
    if (existing) existing.count += 1;
    else counts.push({ method, path, status, count: 1 });
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(JSON.stringify(status === 200 ? { allowCustomProviders: true } : { error: "fixture_unavailable" }));
  });
  await new Promise<void>((resolve, reject) => {
    den.once("error", reject);
    den.listen(0, "127.0.0.1", resolve);
  });
  setup.defer(() => new Promise<void>((resolve, reject) => {
    den.close((error) => error ? reject(error) : resolve());
    den.closeAllConnections();
  }));
  const address = den.address();
  if (!address || typeof address === "string") throw new Error("Fake Den did not bind a TCP port");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const paths = resolveHeadlessWorldRuntimePaths(fileURLToPath(new URL("../../", import.meta.url)), base.app.handle.name);
  const runtime = await readHeadlessRuntimeManifest(paths.runtimeManifestPath);
  if (!runtime || runtime.workspace !== base.workspacePath || runtime.openworkUrl !== base.app.openworkUrl) {
    throw new Error("Outage fixture could not identify its owned headless runtime");
  }
  // Host-only identity arrangement, not renderer Cloud sign-in or provider sync.
  const installed = await fetch(`${runtime.openworkUrl}/den-session/identity`, {
    method: "PUT",
    headers: { "X-OpenWork-Host-Token": runtime.hostToken, "Content-Type": "application/json" },
    body: JSON.stringify({ baseUrl, token: "den-outage-fixture-token", orgId: "org_test" }),
    signal: AbortSignal.timeout(30_000),
  });
  if (installed.status !== 204) throw new Error(`Outage fixture identity installation failed: ${installed.status}`);
  if (!counts.some((entry) => entry.path === "/v1/me/desktop-config" && entry.status === 200)) {
    throw new Error("Identity installation did not validate healthy Den policy");
  }
  // Identity policy writes schedule an asynchronous engine reload. A 204 is
  // not engine readiness: fault only after the server reports that reload applied.
  const reloadBefore = await base.readNative("/cloud-provider-sync/status");
  const reloadReady = await eventually(() => base.readNative("/cloud-provider-sync/status"), {
    within: 60_000,
    label: "identity policy engine reload applied before Den outage",
    until: (response) => response.status === 200 && typeof response.body === "object"
      && response.body !== null && "reloadPending" in response.body && response.body.reloadPending === false,
  });
  const engineHealthPath = `/workspace/${encodeURIComponent(base.workspace.workspaceId)}/opencode/global/health`;
  const engineHealth = await base.readNative(engineHealthPath);
  if (engineHealth.status !== 200) throw new Error(`Configured engine health failed: ${engineHealth.status}`);
  unavailable = true;
  const owned = setup.move();
  return {
    ...base,
    hostedServerIdentityInstalled: true,
    rendererCloudSignedIn: false,
    readiness: { reloadBefore, reloadReady, engineHealth },
    denRequests: () => counts.map((entry) => ({ ...entry })),
    denUnavailable: async () => {
      const response = await fetch(`${baseUrl}/v1/me/desktop-config`, { signal: AbortSignal.timeout(5_000) });
      await response.text();
      if (response.status !== 503) throw new Error(`Expected Den outage, received ${response.status}`);
      return response.status;
    },
    [Symbol.asyncDispose]: () => owned[Symbol.asyncDispose](),
  };
}
