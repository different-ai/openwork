import { expect, test } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createSandboxToolsBridge } from "../src/sandbox-tools-bridge.js";
import { managedDesktopPolicy } from "../src/managed-desktop-policy.js";
import { writeGlobalRuntimeOpencodeConfig } from "../src/runtime-opencode-config-store.js";
import { serve } from "../src/serve-node.js";
import type { ServerConfig } from "../src/types.js";

// Explicit opt-in: real local microVMs, disposable loopback Den fixture, no model or production calls.
test.skipIf(process.env.MICROSANDBOX_LIVE !== "1")("local bridge executes tools in a real VM with live absolute-path mounts and rechecks revocation", async () => {
  const temp = await mkdtemp(join(tmpdir(), "sandbox-bridge-live-"));
  const workspace = join(temp, "workspace");
  const external = join(temp, "authorized");
  await mkdir(workspace); await mkdir(external);
  await writeFile(join(external, "reference.txt"), "authorized-host-nonce");
  let enabled = true;
  const den = await serve({ hostname: "127.0.0.1", port: 0, fetch: request => {
    const path = new URL(request.url).pathname;
    if (path === "/v1/org") return Response.json({ features: { sandboxTools: enabled } });
    if (path === "/v1/me/desktop-config") return Response.json({ agentPermissions: { rules: [] } });
    return new Response(null, { status: 404 });
  } });
  const config: ServerConfig = {
    host: "127.0.0.1", port: 0, token: "client", hostToken: "host", configPath: join(temp, "runtime", "server.json"),
    approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [],
    workspaces: [{ id: "live-workspace", path: workspace, name: "Live test", preset: "starter", workspaceType: "local" }],
    authorizedRoots: [], readOnly: false, startedAt: Date.now(), tokenSource: "generated", hostTokenSource: "generated", logFormat: "json", logRequests: false,
  };
  const policy = managedDesktopPolicy(config);
  await policy.setSession({ baseUrl: `http://127.0.0.1:${den.port}`, orgId: "org_fixture", token: "fixture-not-a-real-key" });
  await policy.current();
  await writeGlobalRuntimeOpencodeConfig(config, current => ({ ...current, permission: { external_directory: { [`${external}/*`]: "allow" } } }));
  const bridge = await createSandboxToolsBridge(config);
  const request = (name: string, input: unknown) => fetch(bridge.url, {
    method: "POST", headers: { authorization: `Bearer ${bridge.token}`, "content-type": "application/json" },
    body: JSON.stringify({ operation: "execute", directory: workspace, name, input, sessionId: "session-fixture" }),
  });
  try {
    const shell = await request("shell", { command: "uname -s" });
    expect(shell.status).toBe(200);
    expect(await shell.text()).toContain("Linux");
    const read = await request("read", { path: join(external, "reference.txt") });
    expect(read.status).toBe(200);
    expect(await read.text()).toContain("authorized-host-nonce");
    const write = await request("write", { path: join(workspace, "result.txt"), content: "live-bind-write" });
    expect(write.status).toBe(200);
    expect(await readFile(join(workspace, "result.txt"), "utf8")).toBe("live-bind-write");
    await writeGlobalRuntimeOpencodeConfig(config, current => ({ ...current, permission: { external_directory: {} } }));
    const removed = await request("read", { path: join(external, "reference.txt") });
    expect(removed.status).toBe(503);
    expect(await readFile(join(external, "reference.txt"), "utf8")).toBe("authorized-host-nonce");
    const after = await request("read", { path: join(workspace, "result.txt") });
    expect(after.status).toBe(200);
    enabled = false;
    const revoked = await request("write", { path: join(workspace, "forbidden.txt"), content: "must-not-exist" });
    expect(revoked.status).toBe(503);
    await expect(readFile(join(workspace, "forbidden.txt"))).rejects.toThrow();
  } finally {
    await bridge.close();
    await policy.clearSession();
    await den.stop();
    await rm(temp, { recursive: true, force: true });
  }
}, 120_000);
