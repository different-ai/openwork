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
import {
  eventually,
  needs,
  readDenClientState,
  readPublishedDesktopSandboxWitness,
  retainedCrashedDesktopWitness,
  test,
} from "@openwork/testkit";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../..", import.meta.url));
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }

// The pooled lane exports its worker's shared Den/desktop sandboxes for a spec's
// own seeds. Preview worlds refuse to run on borrowed infrastructure, so hide
// those overrides from the worlds this spec launches and restore them after.
const POOLED_SLOT_ENV = ["OPENWORK_EVAL_DEN_API_URL", "OPENWORK_EVAL_DAYTONA_DEN_SANDBOX", "OPENWORK_EVAL_DAYTONA_DESKTOP_SANDBOX", "OPENWORK_EVAL_DAYTONA_SANDBOX"] as const;
function withoutPooledSlotEnv(): () => void {
  const saved = POOLED_SLOT_ENV.map((key) => [key, process.env[key]] as const);
  for (const key of POOLED_SLOT_ENV) delete process.env[key];
  return () => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

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

interface DaytonaSandboxSummary {
  identities: string[];
  autoStopInterval: number;
}

async function daytonaSandboxes(): Promise<DaytonaSandboxSummary[]> {
  const summaries: DaytonaSandboxSummary[] = [];
  for (let page = 1; ; page += 1) {
    const result = await exec("daytona", ["sandbox", "list", "-f", "json", "-l", "200", "-p", String(page)], { timeout: 30000 });
    const value: unknown = JSON.parse(result.stdout);
    const entries = Array.isArray(value) ? value : record(value) && Array.isArray(value.items) ? value.items : null;
    if (!entries) throw new Error("Daytona sandbox list did not return items.");
    for (const entry of entries) {
      if (!record(entry)) continue;
      const identities = [entry.id, entry.name].filter((identity): identity is string => typeof identity === "string");
      if (identities.length > 0 && typeof entry.autoStopInterval === "number") {
        summaries.push({ identities, autoStopInterval: entry.autoStopInterval });
      }
    }
    if (!record(value) || typeof value.totalPages !== "number" || page >= value.totalPages) break;
  }
  return summaries;
}

async function daytonaSandboxIdentities(): Promise<string[]> {
  return [...new Set((await daytonaSandboxes()).flatMap((sandbox) => sandbox.identities))].sort();
}

async function daytonaSandboxAutoStopInterval(identity: string): Promise<number> {
  const sandbox = (await daytonaSandboxes()).find((entry) => entry.identities.includes(identity));
  if (!sandbox) throw new Error(`Daytona sandbox ${identity} was not listed.`);
  return sandbox.autoStopInterval;
}

test("preview worlds expose Den and real Electron, preserve progress on frontend update, and tear down only their own stage", { timeout: 1_500_000 }, async ({ evidence }) => {
  needs({ placement: "daytona" });
  const snapshots = await mkdtemp(join(tmpdir(), "openwork-preview-proof-"));
  const previous = process.env.OPENWORK_WORLD_SNAPSHOT_DIR;
  process.env.OPENWORK_WORLD_SNAPSHOT_DIR = snapshots;
  const restorePooledSlotEnv = withoutPooledSlotEnv();
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
    const before = await evaluateOnSurface(surface, () => (({ route: location.hash, marker: localStorage.setItem('preview-proof', 'preserved') })));
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
    assert.equal(await evaluateOnSurface(surface, () => (localStorage.getItem('preview-proof'))), "preserved");
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
    restorePooledSlotEnv();
    await rm(snapshots, { recursive: true, force: true });
  }
});

test("preview-desktop retains an exact blank published release and tears down its two owned sandboxes", { timeout: 1_500_000 }, async ({ evidence }) => {
  needs({ placement: "daytona" });
  const snapshots = await mkdtemp(join(tmpdir(), "openwork-release-preview-proof-"));
  const previous = process.env.OPENWORK_WORLD_SNAPSHOT_DIR;
  process.env.OPENWORK_WORLD_SNAPSHOT_DIR = snapshots;
  const restorePooledSlotEnv = withoutPooledSlotEnv();
  const suffix = Date.now();
  const stage = `release-${suffix}`;
  const invalidStage = `invalid-${suffix}`;
  const controlStage = `control-${suffix}`;
  const options = { cwd: root, worldsDirectory: join(root, "worlds"), print: (line: string) => console.error(line) };
  const up = (name: string, selectedStage: string, args: string[]) => main(["up", name, "--stage", selectedStage, "--place", "daytona", "--detach", "--timeout", "600000", "--", ...args], options);
  const down = (name: string, selectedStage: string) => main(["down", name, "--stage", selectedStage], options);
  const snapshot = async (name: string, selectedStage: string) => {
    const value = await readScriptWorldSnapshot(join(snapshots, `${name}--${selectedStage}.json`));
    assert.ok(value);
    return value;
  };
  try {
    assert.match(process.env.OPENWORK_EVAL_REF ?? "", /^[0-9a-f]{40}$/);
    assert.equal(await up("preview-desktop", invalidStage, ["--release", "latest", "--distribution", "enterprise", "--scenario", "blank"]), 1);
    assert.equal(await readScriptWorldSnapshot(join(snapshots, `preview-desktop--${invalidStage}.json`)), undefined);
    assert.equal((await daytonaSandboxIdentities()).some((identity) => identity.includes(invalidStage)), false);
    evidence.recordAssertionEvidence("Invalid release arguments allocate nothing", "A mutable release value exits without a world receipt or any stage-labeled Daytona sandbox.", true);

    assert.equal(await up("preview-den", controlStage, ["--scenario", "fresh", "--lifetime", "30"]), 0);
    const control = await snapshot("preview-den", controlStage);
    assert.equal(await up("preview-desktop", stage, ["--release", "0.18.44", "--distribution", "enterprise", "--scenario", "blank", "--lifetime", "30"]), 0);
    const release = await snapshot("preview-desktop", stage);
    assert.equal(release.outputs.releaseVersion, "0.18.44");
    assert.equal(release.outputs.distribution, "enterprise");
    assert.equal(release.outputs.platform, "linux");
    assert.equal(release.outputs.architecture, "x64");
    assert.equal(release.outputs.denRef, process.env.OPENWORK_EVAL_REF);
    assert.equal(release.outputs.startup, "cdp-responsive");
    assert.ok(release.outputs.cdp);
    assert.notEqual(release.outputs.denSandbox, release.outputs.desktopSandbox);
    assert.notEqual(release.outputs.denSandbox, control.outputs.denSandbox);
    assert.notEqual(release.outputs.desktopSandbox, control.outputs.denSandbox);
    for (const sandbox of [control.outputs.denSandbox, release.outputs.denSandbox, release.outputs.desktopSandbox]) {
      assert.equal(await daytonaSandboxAutoStopInterval(sandbox), 0);
    }
    evidence.recordAssertionEvidence("Preview lifetime owns both sandbox lifecycles", "Daytona reports autoStopInterval 0 for the control Den and for the release world's Den and desktop; expiry/down remains the only configured stop timer.", true);
    assert.equal((await fetch(release.outputs.preview)).status, 200);
    assert.match(await rfbHandshake(release.outputs.preview), /^RFB 003\./);
    await assert.rejects(
      exec("python3", [join(root, ".opencode/skills/preview-my-work/scripts/update-preview.py"), "preview-desktop", "--stage", stage, "--ref", process.env.OPENWORK_EVAL_REF ?? ""], { cwd: root, timeout: 10000 }),
      (error: unknown) => record(error) && error.code === 2 && typeof error.stderr === "string" && error.stderr.includes("Published release previews are immutable"),
    );

    const metadataResponse = await fetch("https://api.github.com/repos/different-ai/openwork/releases/tags/v0.18.44", {
      headers: { accept: "application/vnd.github+json", "user-agent": "openwork-release-preview-evidence" },
    });
    assert.equal(metadataResponse.status, 200);
    const metadata: unknown = await metadataResponse.json();
    assert.ok(record(metadata) && Array.isArray(metadata.assets));
    const asset = metadata.assets.find((entry: unknown) => record(entry) && entry.name === release.outputs.releaseAsset);
    assert.ok(record(asset) && typeof asset.digest === "string");
    assert.equal(release.outputs.releaseDigest, asset.digest);
    await using surface = await attachSurface({ name: "release-preview-proof", kind: "electron", hostKind: "daytona", cdpUrl: release.outputs.cdp });
    const rendererState = await evaluateOnSurface(surface, () => ({
      hash: location.hash,
      seededKeys: Object.keys(localStorage).filter((key) => key.includes("workspace") || key.includes("activation")),
    }));
    assert.ok(record(rendererState) && rendererState.hash === "" && Array.isArray(rendererState.seededKeys) && rendererState.seededKeys.length === 0);
    assert.deepEqual(await readDenClientState(surface), { authTokenPresent: false, activeOrgId: null, activeOrgSlug: null, activeOrgName: null });
    const bootstrap = `${release.outputs.profilePath}/openwork/config/desktop-bootstrap.json`;
    const expectedPaths: Record<string, string> = {
      HOME: `${release.outputs.profilePath}/home`,
      USERPROFILE: `${release.outputs.profilePath}/home`,
      XDG_CONFIG_HOME: `${release.outputs.profilePath}/xdg/config`,
      XDG_DATA_HOME: `${release.outputs.profilePath}/xdg/data`,
      XDG_CACHE_HOME: `${release.outputs.profilePath}/xdg/cache`,
      XDG_STATE_HOME: `${release.outputs.profilePath}/xdg/state`,
      APPDATA: `${release.outputs.profilePath}/windows/app-data/roaming`,
      LOCALAPPDATA: `${release.outputs.profilePath}/windows/app-data/local`,
      OPENWORK_ELECTRON_USERDATA: `${release.outputs.profilePath}/electron-userdata`,
      OPENWORK_DESKTOP_BOOTSTRAP_PATH: bootstrap,
      OPENWORK_SERVER_CONFIG: `${release.outputs.profilePath}/openwork/config/server.json`,
      OPENWORK_ENV_STORE: `${release.outputs.profilePath}/openwork/config/env.json`,
      OPENWORK_TOKEN_STORE: `${release.outputs.profilePath}/openwork/config/tokens.json`,
      OPENWORK_RUNTIME_DB: `${release.outputs.profilePath}/openwork/config/runtime.sqlite`,
      OPENWORK_DATA_DIR: `${release.outputs.profilePath}/openwork/data`,
      OPENCODE_CONFIG_DIR: `${release.outputs.profilePath}/opencode/config`,
      OPENCODE_DB: `${release.outputs.profilePath}/opencode/data/opencode.db`,
    };
    const environment = { ...expectedPaths, DISPLAY: ":99", OPENWORK_DEV_MODE: "0" };
    const witnessOptions = {
      sandboxId: release.outputs.desktopSandbox,
      pid: release.outputs.desktopPid,
      archivePath: release.outputs.releaseArchive,
      bootstrapPath: bootstrap,
      protocolHandlerPath: release.outputs.protocolHandler,
      shortcutPaths: [release.outputs.relaunchShortcut, release.outputs.browserShortcut],
      environmentKeys: Object.keys(environment),
    };
    const witness = await readPublishedDesktopSandboxWitness({ ...witnessOptions, dispatchDeepLink: true });
    assert.equal(`sha256:${witness.archiveSha256}`, asset.digest);
    assert.equal(witness.executablePath, release.outputs.releaseBinary);
    assert.equal(witness.workingDirectory, `${release.outputs.profilePath}/home`);
    assert.equal(witness.primaryProcessAlive, true);
    evidence.recordAssertionEvidence("The preview runs exact published enterprise bytes without source fallback", "The requested Linux x64 asset and receipt digest equal live GitHub release metadata, the retained archive hashes to that digest, and the running process executable is the extracted release binary.", true);

    assert.equal(witness.bootstrapExists, false);
    assert.deepEqual(witness.environment, environment);
    assert.deepEqual(witness.unexpectedSensitiveEnvironmentKeys, []);
    assert.ok(witness.protocolHandler.includes(`Exec=${release.outputs.profilePath}/launch-openwork %U`));
    assert.ok(witness.protocolHandler.includes("MimeType=x-scheme-handler/openwork;"));
    assert.equal(witness.defaultProtocolHandler, "openwork-release-preview.desktop");
    assert.deepEqual(witness.shortcutsExecutable, [true, true]);
    assert.equal(witness.handoffExitCode, 0);
    evidence.recordAssertionEvidence("Blank means no seeded identity, activation, or workspace", "The renderer has no workspace or Den identity, no bootstrap file exists, every expected HOME/XDG/OpenWork/OpenCode path is rooted in one launch profile, credential-like and source override environment keys are absent, and xdg-open completes a benign handoff through the discoverable same-profile handler.", true);

    {
      await using broken = await retainedCrashedDesktopWitness(release.outputs.desktopSandbox);
      assert.equal(broken.startup.state, "crashed");
      assert.match(broken.startup.detail, /Process exited/);
      assert.equal((await fetch(release.outputs.preview)).status, 200);
      assert.match(await rfbHandshake(release.outputs.preview), /^RFB 003\./);
    }
    const afterCrash = await readPublishedDesktopSandboxWitness(witnessOptions);
    assert.equal(afterCrash.defaultProtocolHandler, "openwork-release-preview.desktop");
    assert.equal(afterCrash.primaryProcessAlive, true);
    evidence.recordAssertionEvidence("An app crash retains a real viewer without a healthy label", "A real /bin/false launch is observed as crashed while the same HTTP/noVNC endpoint continues to answer and complete an RFB handshake.", true);

    const owned = [release.outputs.denSandbox, release.outputs.desktopSandbox];
    assert.equal(await down("preview-desktop", stage), 0);
    await eventually(async () => {
      const identities = await daytonaSandboxIdentities();
      return owned.every((sandbox) => !identities.includes(sandbox));
    }, { within: 120000, intervalMs: 2000, label: "release preview owned sandboxes deleted" });
    assert.equal((await fetch(control.outputs.preview)).status, 200);
    assert.ok((await daytonaSandboxIdentities()).includes(control.outputs.denSandbox));
    evidence.recordAssertionEvidence("Down deletes exactly the release world's Den and desktop", "Both recorded owned sandbox identities disappear while the separately staged control Den remains listed and HTTP-reachable.", true);
    assert.equal(await down("preview-den", controlStage), 0);
  } finally {
    for (const [name, selectedStage] of [["preview-desktop", stage], ["preview-desktop", invalidStage], ["preview-den", controlStage]]) {
      if (await readScriptWorldSnapshot(join(snapshots, `${name}--${selectedStage}.json`))) await down(name, selectedStage);
    }
    if (previous === undefined) delete process.env.OPENWORK_WORLD_SNAPSHOT_DIR;
    else process.env.OPENWORK_WORLD_SNAPSHOT_DIR = previous;
    restorePooledSlotEnv();
    await rm(snapshots, { recursive: true, force: true });
  }
});
