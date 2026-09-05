import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { main, isProcessAlive, readScriptWorldSnapshot } from "@openwork/world";
import { denFetch, signIn } from "@openwork/behaviors";
import { attachSurface, evaluateOnSurface } from "@openwork/cdp";
import { screenshot } from "@openwork/test-evidence";
import { eventually, needs, test } from "@openwork/testkit";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../..", import.meta.url));
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }

async function rfbHandshake(url: string): Promise<string> {
  const endpoint = new URL("/websockify", url);
  endpoint.protocol = "wss:";
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(endpoint, ["binary"]);
    socket.binaryType = "arraybuffer";
    const timer = setTimeout(() => { socket.close(); reject(new Error("noVNC did not reach the desktop RFB server")); }, 15000);
    socket.onmessage = (event) => { clearTimeout(timer); socket.close(); resolve(new TextDecoder().decode(event.data)); };
    socket.onerror = () => { clearTimeout(timer); socket.close(); reject(new Error("noVNC WebSocket failed")); };
  });
}

test("preview worlds expose Den and real Electron, preserve progress on frontend update, and tear down only their own stage", { timeout: 1_500_000 }, async ({ evidence }) => {
  needs({ placement: "daytona" });
  const snapshots = await mkdtemp(join(tmpdir(), "openwork-preview-proof-"));
  const previous = process.env.OPENWORK_WORLD_SNAPSHOT_DIR;
  process.env.OPENWORK_WORLD_SNAPSHOT_DIR = snapshots;
  const stage = `proof-${Date.now()}`;
  const options = { cwd: root, worldsDirectory: join(root, "worlds"), print: (line: string) => console.error(line) };
  const up = (name: string, scenario: string, lifetime = "30") => main(["up", name, "--stage", stage, "--place", "daytona", "--detach", "--timeout", "600000", "--", "--scenario", scenario, "--lifetime", lifetime], options);
  const down = (name: string) => main(["down", name, "--stage", stage], options);
  const snapshot = async (name: string) => {
    const value = await readScriptWorldSnapshot(join(snapshots, `${name}--${stage}.json`));
    assert.ok(value);
    return value;
  };
  try {
    const pinnedRef = process.env.OPENWORK_EVAL_REF;
    assert.ok(pinnedRef);
    try {
      process.env.OPENWORK_EVAL_REF = "dev";
      assert.equal(await up("preview-den", "fresh"), 1);
      assert.equal(await readScriptWorldSnapshot(join(snapshots, `preview-den--${stage}.json`)), undefined);
    } finally {
      process.env.OPENWORK_EVAL_REF = pinnedRef;
    }
    await assert.rejects(exec("python3", [join(root, ".opencode/skills/preview-my-work/scripts/update-preview.py"), "preview-den", "--stage", stage, "--ref", "dev"], { cwd: root, timeout: 10000 }), (error: unknown) => record(error) && error.code === 2 && typeof error.stderr === "string" && error.stderr.includes("full 40-character commit SHA"));
    evidence.recordAssertionEvidence("Mutable refs are rejected before preview execution", "Launch with a branch name fails without a live receipt; the updater rejects a branch name before reading a receipt or invoking Daytona.", true);
    assert.equal(await up("preview-den", "fresh"), 0);
    const den = await snapshot("preview-den");
    assert.equal(den.outputs.scenario, "fresh");
    assert.equal(den.outputs.password, undefined);
    assert.equal((await fetch(den.outputs.preview)).status, 200);
    const unauthed = await fetch(`${den.outputs.denApi}/v1/me`);
    assert.equal(unauthed.status, 401);
    assert.equal(await up("preview-den", "fresh"), 0);
    assert.equal((await snapshot("preview-den")).pid, den.pid);
    evidence.recordAssertionEvidence("Fresh Den is reachable and reopening preserves ownership", "The signup URL returns 200, protected identity returns 401, no account password is seeded, and a repeated launch adopts the same process.", true);

    assert.equal(await up("preview-desktop", "restricted"), 0);
    const desktop = await snapshot("preview-desktop");
    assert.notEqual(desktop.outputs.denSandbox, den.outputs.denSandbox);
    assert.ok(desktop.outputs.desktopSandbox);
    assert.equal((await fetch(desktop.outputs.preview)).status, 200);
    assert.match(await rfbHandshake(desktop.outputs.preview), /^RFB 003\./);
    const ref = { apiUrl: desktop.outputs.denApi, webUrl: desktop.outputs.denWeb };
    const session = await signIn(ref, { email: desktop.outputs.email, password: desktop.outputs.password });
    const headers = { authorization: `Bearer ${session.token}` };
    const connections = await denFetch(ref, "/v1/mcp-connections?scope=manageable", { headers });
    assert.equal(connections.response.status, 200);
    assert.ok(record(connections.body) && Array.isArray(connections.body.connections));
    const savedConnections = connections.body.connections;
    assert.equal(savedConnections.length, 2);
    for (const connection of savedConnections) {
      assert.ok(record(connection));
      assert.equal(connection.credentialMode, "per_member");
      assert.equal(connection.connectedForMe, false);
      assert.ok(record(connection.access) && connection.access.orgWide === true);
    }
    const policies = await denFetch(ref, "/v1/desktop-policies", { headers });
    assert.ok(record(policies.body) && Array.isArray(policies.body.desktopPolicies) && Array.isArray(policies.body.definitions));
    const policy = policies.body.desktopPolicies.find((entry: unknown) => record(entry) && entry.isDefault === true);
    assert.ok(record(policy) && record(policy.policy));
    for (const definition of policies.body.definitions) {
      if (record(definition) && typeof definition.id === "string" && typeof definition.restrictedValue === "boolean") assert.equal(policy.policy[definition.id], definition.restrictedValue);
    }
    await using surface = await attachSurface({ name: "preview-proof", kind: "electron", hostKind: "daytona", cdpUrl: desktop.outputs.cdp });
    const before = await evaluateOnSurface(surface, "({ route: location.hash, marker: localStorage.setItem('preview-proof', 'preserved') })");
    assert.ok(record(before) && typeof before.route === "string" && before.route.includes("workspace"));
    await screenshot(surface);
    evidence.recordAssertionEvidence("Desktop preview reaches real Electron through noVNC", "The viewer returns 200, its WebSocket speaks RFB, and the Electron renderer is on a workspace route. Restricted policy matches Den definitions; two team connectors use unconnected individual accounts.", true);

    const buildId = async () => (await exec("daytona", ["exec", desktop.outputs.denSandbox, "--", "cat", "/workspace/ee/apps/den-web/.next/BUILD_ID"], { timeout: 30000 })).stdout.trim();
    const previousBuild = await buildId();
    assert.ok((await (await fetch(desktop.outputs.denWeb)).text()).includes(previousBuild));
    assert.ok(process.env.OPENWORK_EVAL_REF);
    await exec("python3", [join(root, ".opencode/skills/preview-my-work/scripts/update-preview.py"), "preview-desktop", "--stage", stage, "--ref", process.env.OPENWORK_EVAL_REF], { cwd: root, timeout: 300000, maxBuffer: 2_000_000 });
    await eventually(async () => (await fetch(desktop.outputs.denWeb)).status === 200, { within: 60000, intervalMs: 1000, label: "updated Den web responds" });
    const nextBuild = await buildId();
    assert.notEqual(nextBuild, previousBuild);
    assert.ok((await (await fetch(desktop.outputs.denWeb)).text()).includes(nextBuild), "Den must serve the rebuilt frontend, not the old process");
    const after = await denFetch(ref, "/v1/mcp-connections?scope=manageable", { headers });
    assert.ok(record(after.body) && Array.isArray(after.body.connections));
    assert.deepEqual(after.body.connections, savedConnections);
    assert.equal(await evaluateOnSurface(surface, "localStorage.getItem('preview-proof')"), "preserved");
    assert.equal((await snapshot("preview-desktop")).pid, desktop.pid);
    evidence.recordAssertionEvidence("Frontend update preserves the preview", "The live HTTP response contains the new Next build ID, which differs from the previous build; the existing session still reads the same connectors, Electron retains its localStorage marker, and world ownership stays unchanged.", true);
    await surface[Symbol.asyncDispose]();
    assert.equal(await down("preview-den"), 0);
    assert.equal(await up("preview-den", "fresh", "1"), 0);
    const reset = await snapshot("preview-den");
    assert.notEqual(reset.outputs.denSandbox, den.outputs.denSandbox);
    assert.equal((await fetch(reset.outputs.preview)).status, 200);
    assert.equal(await down("preview-desktop"), 0);
    assert.equal(await readScriptWorldSnapshot(join(snapshots, `preview-desktop--${stage}.json`)), undefined);
    assert.equal((await fetch(reset.outputs.preview)).status, 200);
    assert.equal((await snapshot("preview-den")).pid, reset.pid);
    evidence.recordAssertionEvidence("Reset and stop are scoped to their stage", "Reset creates a new Den sandbox. Desktop teardown removes its receipt while the reset Den preview still responds and retains its owner process.", true);
    await eventually(async () => !await readScriptWorldSnapshot(join(snapshots, `preview-den--${stage}.json`)), { within: 90000, intervalMs: 1000, label: "preview expires after its one-minute session lifetime" });
    await eventually(() => !isProcessAlive(reset.pid), { within: 60000, intervalMs: 1000, label: "expired preview finishes disposal" });
    evidence.recordAssertionEvidence("Session lifetime ends the preview", "A one-minute preview removes its live receipt and its owning process finishes disposal automatically without another down command.", true);
  } finally {
    for (const name of ["preview-desktop", "preview-den"]) {
      if (await readScriptWorldSnapshot(join(snapshots, `${name}--${stage}.json`))) await down(name);
    }
    if (previous === undefined) delete process.env.OPENWORK_WORLD_SNAPSHOT_DIR;
    else process.env.OPENWORK_WORLD_SNAPSHOT_DIR = previous;
    await rm(snapshots, { recursive: true, force: true });
  }
});
