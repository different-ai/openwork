import { expect, test } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { sandboxName } from "@openwork/sandbox";
import { runtimeDbPath } from "../src/runtime-db.js";
import { tmpdir } from "node:os";
import { createSandboxToolsBridge } from "../src/sandbox-tools-bridge.js";
import { closeLocalSandboxRuntime, localSandboxRuntime } from "../src/local-sandbox-runtime.js";
import { writeSandboxSettings } from "../src/sandbox-settings-store.js";
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
  const policy = managedDesktopPolicy(config, { sandboxFreshnessMs: 0 });
  await policy.setSession({ baseUrl: `http://127.0.0.1:${den.port}`, orgId: "org_fixture", token: "fixture-not-a-real-key" });
  await policy.current();
  await writeSandboxSettings(config, { useSandbox: true, forceSandbox: false });
  await writeGlobalRuntimeOpencodeConfig(config, current => ({ ...current, permission: { external_directory: { [`${external}/*`]: "allow" } } }));
  let bridge = await createSandboxToolsBridge(config);
  const request = (name: string, input: unknown) => fetch(bridge.url, {
    method: "POST", headers: { authorization: `Bearer ${bridge.token}`, "content-type": "application/json" },
    body: JSON.stringify({ operation: "execute", directory: workspace, name, input, sessionId: "session-fixture" }),
  });
  const runtime = localSandboxRuntime(config);
  const require = createRequire(import.meta.url);
  const entry = createRequire(require.resolve("@openwork/sandbox-microsandbox")).resolve("microsandbox");
  type Instance = { id: string; status: string; kill(): Promise<void>; stopWithTimeout(ms: number): Promise<void>; destroy(options: { force: boolean }): Promise<void> };
  const sdk: { Sandbox: { get(key: string): Promise<Instance> } } = await import(pathToFileURL(entry).href);
  const permission = await policy.localSandboxAccess();
  const install = createHash("sha256").update(runtimeDbPath(config)).digest("hex");
  const scope = createHash("sha256").update(`${install}\n${permission.scope}`).digest("hex");
  const key = sandboxName(scope, "tools", "live-workspace");
  const elapsed = async (run: () => Promise<void>) => {
    const start = performance.now();
    await run();
    return Math.round(performance.now() - start);
  };
  const shell = async () => {
    const response = await request("shell", { command: "uname -s" });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Linux");
  };
  try {
    const pending = runtime.prepare(workspace, "live-cold");
    let downloadBytes = 0;
    let startObserved = false;
    while (!["ready", "failed", "unsupported"].includes(runtime.snapshot(workspace).state)) {
      const status = runtime.snapshot(workspace);
      downloadBytes = Math.max(downloadBytes, status.steps[0].completedBytes ?? 0);
      startObserved ||= status.steps[1].state === "active";
      await delay(10);
    }
    await pending;
    expect(runtime.snapshot(workspace).state).toBe("ready");
    expect(downloadBytes).toBeGreaterThan(0);
    expect(startObserved).toBe(true);
    const firstCommandMs = await elapsed(shell);
    const roundTripMs = await elapsed(shell);
    const first = await sdk.Sandbox.get(key);
    await first.stopWithTimeout(5_000);
    const stoppedToStartMs = await elapsed(() => runtime.prepare(workspace, "live-stopped"));
    expect((await sdk.Sandbox.get(key)).id).toBe(first.id);
    const candidates = execFileSync("ps", ["-ww", "-axo", "pid=,command="], { encoding: "utf8" })
      .split("\n").filter(line => line.includes(`/bin/msb machine --name ${key} --sandbox-id `));
    expect(candidates).toHaveLength(1);
    const pid = Number(candidates[0].trim().split(/\s+/)[0]);
    expect(pid).toBeGreaterThan(1);
    process.kill(pid, "SIGKILL");
    await expect.poll(async () => (await sdk.Sandbox.get(key)).status).toBe("crashed");
    const crashRecoveryMs = await elapsed(shell);
    expect((await sdk.Sandbox.get(key)).id).not.toBe(first.id);
    await bridge.close();
    await closeLocalSandboxRuntime(config);
    bridge = await createSandboxToolsBridge(config);
    const old = await sdk.Sandbox.get(key);
    const destroyRecreateMs = await elapsed(() => localSandboxRuntime(config).prepare(workspace, "live-app-restart"));
    expect((await sdk.Sandbox.get(key)).id).not.toBe(old.id);
    console.info("[openwork:sandbox] live timings", { downloadBytes, firstCommandMs, roundTripMs, stoppedToStartMs, crashRecoveryMs, destroyRecreateMs });
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
    await closeLocalSandboxRuntime(config);
    const instance = await sdk.Sandbox.get(key).catch(() => undefined);
    await instance?.destroy({ force: true });
    await policy.clearSession();
    await den.stop();
    await rm(temp, { recursive: true, force: true });
  }
}, 120_000);
