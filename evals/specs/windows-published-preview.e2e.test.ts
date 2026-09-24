import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { readLedger, readScriptWorldSnapshot } from "@openwork/world";
import { attachSurface, evaluateOnSurface, eventually, readDenClientState, screenshot, spec } from "@openwork/testkit";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../..", import.meta.url));
const VERSION = "0.18.52";
const ASSET = `openwork-win-x64-${VERSION}.exe`;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function sandboxExists(id: string): Promise<boolean> {
  try {
    const { stdout } = await exec("daytona", ["info", id, "-f", "json"], { timeout: 30_000 });
    const info: unknown = JSON.parse(stdout);
    return record(info) && info.id === id;
  } catch { return false; }
}

// The CLI is the user's act under test: it creates its own isolated Windows
// desktop and Den. The testkit world owns only the proof and its cleanup.
const test = spec.world(async () => ({}), {
  needs: { placement: "daytona" }, timeout: 1_800_000,
  resources: { surfaces: ["desktop"], services: ["den"], nativeReason: "A published Windows installer requires an interactive Windows desktop session and OS certificate store." },
});

test("a Windows owner previews the exact published OpenWork release and can stop only that world", { timeout: 1_800_000 }, async ({ evidence, step }) => {
  const snapshots = await mkdtemp(join(tmpdir(), "openwork-win-release-proof-"));
  const stage = `win-${Date.now()}`;
  const previous = process.env.OPENWORK_WORLD_SNAPSHOT_DIR;
  process.env.OPENWORK_WORLD_SNAPSHOT_DIR = snapshots;
  // Invoke the real CLI so its ownership reapers run on `down`, too.
  const cli = async (args: string[]): Promise<number> => {
    try {
      await exec(process.execPath, [join(root, "evals/bin/world.mjs"), ...args], { cwd: root, timeout: 1_260_000, maxBuffer: 8 * 1024 * 1024 });
      return 0;
    } catch (error) {
      if (record(error) && typeof error.code === "number") return error.code;
      throw new Error("World CLI failed before reporting an exit code; private URLs withheld.");
    }
  };
  const receiptPath = join(snapshots, `preview-desktop--${stage}.json`);
  const ledger = join(snapshots, `preview-desktop--${stage}.ledger.jsonl`);
  const up = (args: string[]) => cli(["up", "preview-desktop", "--stage", stage, "--place", "daytona", "--os", "windows", "--detach", "--timeout", "1200000", ...args]);
  let worldReady = false;
  let cleanupFailed = false;
  let desktopSandbox = "";
  let denSandbox = "";
  try {
    await step("before: an unsupported Windows source cannot allocate a sandbox", async () => {
      assert.equal(await up(["--", "--release", "latest", "--distribution", "public", "--scenario", "blank"]), 1);
      assert.equal(await readScriptWorldSnapshot(receiptPath), undefined);
      evidence.recordAssertionEvidence("unsupported release refused", "A mutable latest release returned failure without a readiness receipt or a Windows VM allocation.", true);
    });

    const receipt = await step("when the owner requests Windows x64 version 0.18.52 from the published release", async () => {
      assert.equal(await up(["--source", `desktop=release:${VERSION}/public`, "--seed", "blank", "--", "--lifetime", "30"]), 0);
      const value = await readScriptWorldSnapshot(receiptPath);
      assert.ok(value, "the world must have a readiness receipt");
      worldReady = true;
      desktopSandbox = value.outputs.desktopSandbox ?? "";
      denSandbox = value.outputs.denSandbox ?? "";
      assert.ok(desktopSandbox && denSandbox && desktopSandbox !== denSandbox);
      const { stdout } = await exec("daytona", ["info", desktopSandbox, "-f", "json"], { timeout: 30_000 });
      const info: unknown = JSON.parse(stdout);
      assert.ok(record(info) && info.id === desktopSandbox && info.public === false
        && info.snapshot === "windows-medium" && info.autoPauseInterval === 0);
      evidence.recordAssertionEvidence("isolated release preview allocated", "One private Windows VM runs the exact published x64 release; a separate Linux Den VM uses a pinned source SHA. Neither is a borrowed sandbox.", true);
      return value;
    });

    await step("then the installer hash and the interactive Windows app match the release", async () => {
      assert.equal(receipt.outputs.platform, "windows");
      assert.equal(receipt.outputs.architecture, "x64");
      assert.equal(receipt.outputs.releaseVersion, VERSION);
      assert.equal(receipt.outputs.releaseAsset, ASSET);
      assert.equal(receipt.outputs.startup, "cdp-responsive");
      assert.match(receipt.outputs.denRef ?? "", /^[a-f0-9]{40}$/);
      const { stdout } = await exec("daytona", ["exec", desktopSandbox, "--", "certutil -hashfile C:\\ow\\release.exe SHA256"], { timeout: 60_000 });
      const hash = stdout.match(/\b[a-f0-9]{64}\b/i)?.[0]?.toLowerCase();
      assert.equal(`sha256:${hash}`, receipt.outputs.releaseDigest);
      const metadata = await fetch(`https://api.github.com/repos/different-ai/openwork/releases/tags/v${VERSION}`, {
        headers: { accept: "application/vnd.github+json", "user-agent": "openwork-windows-preview-proof" },
        signal: AbortSignal.timeout(30_000),
      });
      assert.equal(metadata.status, 200);
      const release: unknown = await metadata.json();
      assert.ok(record(release) && Array.isArray(release.assets));
      const asset = release.assets.find((entry: unknown) => record(entry) && entry.name === ASSET);
      assert.ok(record(asset));
      assert.equal(asset.digest, receipt.outputs.releaseDigest);
      evidence.recordAssertionEvidence("published installer bytes match", `Windows certutil SHA-256 and GitHub's published ${ASSET} digest both match the world's installed-release receipt.`, true);
    });

    await step("after: the owner sees the real Windows first-launch screen in the private viewer", async () => {
      assert.equal(receipt.outputMeta?.preview?.secret, true);
      assert.equal(receipt.outputMeta?.cdp?.secret, true);
      assert.ok(receipt.outputs.preview && receipt.outputs.cdp);
      const viewer = await fetch(receipt.outputs.preview, { signal: AbortSignal.timeout(20_000) });
      assert.equal(viewer.status, 200);
      assert.match(await viewer.text(), /noVNC/);
      const cdp = await fetch(new URL("/json/version", receipt.outputs.cdp), { signal: AbortSignal.timeout(20_000) });
      assert.equal(cdp.status, 200);
      assert.match(await cdp.text(), /OpenWork\/0\.18\.52/);
      await using surface = await attachSurface({ name: "windows-published-release", kind: "electron", hostKind: "daytona", cdpUrl: receipt.outputs.cdp });
      const view = await evaluateOnSurface(surface, () => ({
        title: document.title,
        text: document.body.innerText,
        agent: navigator.userAgent,
      }));
      assert.ok(record(view) && typeof view.text === "string" && typeof view.agent === "string");
      assert.equal(view.title, "OpenWork");
      assert.match(view.agent, /Windows NT 10\.0.*OpenWork\/0\.18\.52/);
      assert.match(view.text, /What do you need done\?/);
      assert.deepEqual(await readDenClientState(surface), { authTokenPresent: false, activeOrgId: null, activeOrgSlug: null, activeOrgName: null });
      await screenshot(surface);
      evidence.recordAssertionEvidence("real Windows first launch", "Signed noVNC and CDP respond; the rendered app identifies Windows and version 0.18.52, shows the first-launch composer, and has no seeded Den identity.", true);
    });

    await step("after: stopping the stage removes its two private VMs", async () => {
      assert.equal(await cli(["down", "preview-desktop", "--stage", stage]), 0);
      worldReady = false;
      await eventually(async () => !(await sandboxExists(desktopSandbox)) && !(await sandboxExists(denSandbox)), {
        within: 120_000, intervalMs: 2_000, label: "only this preview's Windows and Den sandboxes are deleted",
      });
      assert.equal(await readScriptWorldSnapshot(receiptPath), undefined);
      if ((await readLedger(ledger)).length > 0) assert.equal(await cli(["down", "preview-desktop", "--stage", stage]), 0);
      assert.deepEqual(await readLedger(ledger), []);
      evidence.recordAssertionEvidence("world-owned teardown", "Down removes the Windows and Den sandbox identities recorded by this stage; its readiness receipt disappears and no shared sandbox was touched.", true);
    });
  } finally {
    if (worldReady || await readScriptWorldSnapshot(receiptPath) || (await readLedger(ledger)).length > 0) {
      cleanupFailed = await cli(["down", "preview-desktop", "--stage", stage]) !== 0;
      if (!cleanupFailed && (await readLedger(ledger)).length > 0) cleanupFailed = await cli(["down", "preview-desktop", "--stage", stage]) !== 0;
    }
    if (previous === undefined) delete process.env.OPENWORK_WORLD_SNAPSHOT_DIR;
    else process.env.OPENWORK_WORLD_SNAPSHOT_DIR = previous;
    if (!cleanupFailed) await rm(snapshots, { recursive: true, force: true });
    if (cleanupFailed) throw new Error(`Windows preview cleanup failed; inspect owner-only receipts in ${snapshots}`);
  }
});
