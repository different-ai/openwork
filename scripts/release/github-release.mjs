import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { isTransientNetworkFailure, runNetworkCommand } from "./network-retry.mjs";

const MAX_BUFFER = 128 * 1024 * 1024;
const sha256 = (file) => `sha256:${createHash("sha256").update(readFileSync(file)).digest("hex")}`;
const failure = (result) => result.error ?? new Error(String(result.stderr ?? "").trim() || `gh exited with ${result.status ?? result.signal ?? "unknown"}`);
const missing = (result) => /\bHTTP 404\b/i.test(String(result.stderr));

export function createGithubReleaseClient({ spawn = spawnSync, sleep = setTimeout, log = console.error } = {}) {
  const once = (args) => spawn("gh", args, { encoding: "utf8", maxBuffer: MAX_BUFFER, timeout: 10 * 60 * 1000 });
  async function command(args) {
    const result = await runNetworkCommand("gh", args, {}, { spawn, sleep, log });
    if (result.status !== 0) throw failure(result);
    return result.stdout;
  }
  async function getRelease(repo, tag) {
    const result = await runNetworkCommand("gh", ["api", `repos/${repo}/releases/tags/${encodeURIComponent(tag)}`], {}, { spawn, sleep, log });
    if (result.status === 0) return JSON.parse(result.stdout);
    if (missing(result)) return null;
    throw failure(result);
  }
  async function listAssets(repo, releaseId) {
    const pages = JSON.parse(await command(["api", "--paginate", "--slurp", `repos/${repo}/releases/${releaseId}/assets?per_page=100`]));
    if (!Array.isArray(pages)) throw new Error("Expected a JSON array from gh api.");
    if (pages.every(Array.isArray)) return pages.flat();
    if (pages.every(item => !Array.isArray(item))) return pages;
    throw new Error("Expected gh api pagination output to contain arrays of assets.");
  }
  async function ensureRelease(repo, tag, args) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      const result = once(["release", "create", tag, "--repo", repo, ...args]);
      if (result.status === 0) return;
      if (result.error || result.signal || !isTransientNetworkFailure(result.stderr)) throw failure(result);
      // The server may have committed a create whose response was lost. Read
      // before retrying; never interpret an arbitrary view failure as absence.
      if (await getRelease(repo, tag)) return;
      if (attempt === 3) throw failure(result);
      log(`gh: transient create failure; retry ${attempt}/2.`);
      await sleep(1000 * 2 ** (attempt - 1));
    }
  }
  async function uploadImmutable(repo, tag, releaseId, file, label) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      const result = once(["release", "upload", tag, `${file}#${label}`, "--repo", repo]);
      if (result.status === 0) return;
      if (result.error || result.signal || !isTransientNetworkFailure(result.stderr)) throw failure(result);
      // An interrupted upload may already exist. Do not blindly retry or
      // clobber signed bytes: reconcile the asset's digest first.
      const asset = (await listAssets(repo, releaseId)).find(asset => asset.name === basename(file));
      if (asset) {
        let digest = asset.digest;
        if (!digest) {
          const staging = mkdtempSync(join(tmpdir(), "openwork-release-reconcile-"));
          try {
            await command(["release", "download", tag, "--repo", repo, "--pattern", asset.name, "--dir", staging]);
            digest = sha256(join(staging, asset.name));
          } finally {
            rmSync(staging, { recursive: true, force: true });
          }
        }
        if (digest !== sha256(file)) throw new Error(`Refusing to replace immutable asset ${asset.name}: remote bytes differ.`);
        return;
      }
      if (attempt === 3) throw failure(result);
      log(`gh: transient upload failure; asset absent, retry ${attempt}/2.`);
      await sleep(1000 * 2 ** (attempt - 1));
    }
  }
  async function deleteAsset(repo, id) {
    const result = await runNetworkCommand("gh", ["api", "-X", "DELETE", `repos/${repo}/releases/assets/${id}`], {}, { spawn, sleep, log });
    // DELETE can succeed before its response is lost. A subsequent 404 is the
    // desired final state, not grounds to replay the whole prune operation.
    if (result.status !== 0 && !missing(result)) throw failure(result);
  }
  return { command, getRelease, listAssets, ensureRelease, uploadImmutable, deleteAsset };
}
