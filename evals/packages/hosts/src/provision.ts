import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { checkedExec, defaultDaytonaExec } from "./daytona.ts";
import { FAULT_PROXY_SCRIPT } from "./fault-proxy-script.ts";
import type { DaytonaExec, DaytonaExecResult } from "./daytona.ts";
import type { DesktopRelease, DesktopReleaseDistribution } from "./types.ts";

const REPO_ROOT = fileURLToPath(new URL("../../../..", import.meta.url));
const DESKTOP_READY_TIMEOUT_MS = 300_000;
const INSTALL_TIMEOUT_MS = 25 * 60 * 1_000;
const SERVER_SCRIPT_TIMEOUT_MS = 20 * 60 * 1_000;
const VITE_PREWARM_TIMEOUT_MS = 180_000;
const READINESS_POLL_INTERVAL_MS = 5_000;
const HTTPS_URL = /https:\/\/[^\s"'<>)]+/;
const DEN_WEB_PORT = 3005;
const DEN_API_PORT = 8788;
const SANDBOX_SOURCE_RECEIPT_PATH = "/workspace/.openwork-daytona/source-receipt.json";
const SANDBOX_PREPARED_FINGERPRINT_PATH = "/workspace/.openwork-daytona/source-prepared.sha256";
const RELEASE_REPOSITORY = "different-ai/openwork";
const MAX_DESKTOP_RELEASE_ARCHIVE_BYTES = 1024 * 1024 * 1024;

const RELEASE_ARTIFACTS: Record<DesktopReleaseDistribution, { prefix: string; binary: string }> = {
  public: { prefix: "openwork", binary: "openwork" },
  cloud: { prefix: "openwork-cloud", binary: "openwork-cloud" },
  enterprise: { prefix: "openwork-enterprise", binary: "openwork-enterprise" },
};

export const DESKTOP_RELEASE_ARCHIVE_INSTALLER = `
import hashlib
import pathlib
import stat
import sys
import tarfile

archive = pathlib.Path(sys.argv[1])
root = pathlib.Path(sys.argv[2]).resolve()
binary_name = sys.argv[3]
expected_digest = sys.argv[4]
expected_size = int(sys.argv[5])
actual_size = archive.stat().st_size
if actual_size != expected_size:
    raise RuntimeError("Published release size mismatch: expected " + str(expected_size) + ", received " + str(actual_size))
digest = hashlib.sha256()
with archive.open("rb") as source:
    for chunk in iter(lambda: source.read(1024 * 1024), b""):
        digest.update(chunk)
if digest.hexdigest() != expected_digest:
    raise RuntimeError("Published release SHA-256 mismatch")

root.mkdir(parents=True, exist_ok=True)
seen = set()
member_limit = 10000
member_size_limit = 2 * 1024 * 1024 * 1024
unpacked_size_limit = 4 * 1024 * 1024 * 1024

with tarfile.open(archive, "r:gz") as bundle:
    members = bundle.getmembers()
    if len(members) > member_limit:
        raise RuntimeError("Archive contains too many members: " + str(len(members)))
    unpacked_size = 0
    for member in members:
        if member.size < 0 or member.size > member_size_limit:
            raise RuntimeError("Archive member exceeds size limit: " + member.name)
        unpacked_size += member.size
        if unpacked_size > unpacked_size_limit:
            raise RuntimeError("Archive exceeds unpacked size limit")
        pure = pathlib.PurePosixPath(member.name)
        if pure.is_absolute() or ".." in pure.parts:
            raise RuntimeError("Archive member escapes extraction root: " + member.name)
        normalized = str(pure)
        if normalized in seen:
            raise RuntimeError("Archive contains a duplicate member: " + member.name)
        seen.add(normalized)
        target = (root.joinpath(*pure.parts)).resolve()
        if target != root and root not in target.parents:
            raise RuntimeError("Archive member escapes extraction root: " + member.name)
        if member.issym():
            link = (target.parent / member.linkname).resolve()
            if link != root and root not in link.parents:
                raise RuntimeError("Archive symlink escapes extraction root: " + member.name)
        elif member.islnk():
            link = (root / member.linkname).resolve()
            if link != root and root not in link.parents:
                raise RuntimeError("Archive hard link escapes extraction root: " + member.name)
        elif member.isdev() or member.isfifo():
            raise RuntimeError("Archive contains a device or FIFO: " + member.name)
    bundle.extractall(root, filter="data")

candidates = [candidate for candidate in root.rglob(binary_name) if candidate.is_file() and not candidate.is_symlink()]
if len(candidates) != 1:
    raise RuntimeError("Archive must contain exactly one " + binary_name + " executable; found " + str(len(candidates)))
binary = candidates[0].resolve()
binary.chmod(binary.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
print("OPENWORK_RELEASE_BINARY=" + str(binary))
`.trim();

export interface ProvisionExecOptions {
  exec?: DaytonaExec;
}

export interface DesktopSandboxOptions {
  ref: string;
  name: string;
  reuse?: string;
  snapshot?: string;
  /**
   * Mount the shared eval secrets volume. Off by default: `pnpm install` runs
   * lifecycle scripts from the checked-out ref, so mounting provider keys next
   * to an untrusted ref hands them to it. Signed-in org desktops can only pick
   * the org's own models anyway, and driver-side vision keys never live here —
   * so nothing in the connector room needs this.
   */
  secrets?: boolean;
  /** Install exact published desktop bytes instead of checking out/building source. */
  release?: DesktopRelease;
  /** Test seam for GitHub release metadata retrieval. */
  releaseFetch?: typeof fetch;
  /** Daytona idle shutdown in minutes; preview worlds pass 0 so their owner process controls expiry. */
  autoStopMinutes?: number;
  /** Test-only override for the sandbox exec-readiness budget. */
  sandboxReadyTimeoutMs?: number;
  log?: (line: string) => void;
}

export interface PublishedDesktopRelease extends DesktopRelease {
  assetName: string;
  binaryName: string;
  browserDownloadUrl: string;
  digest: string;
  size: number;
}

export interface InstalledDesktopRelease extends PublishedDesktopRelease {
  archivePath: string;
  binaryPath: string;
  installRoot: string;
  manifestPath: string;
}

export interface DesktopSandbox {
  sandbox: string;
  created: boolean;
  source?: SandboxRepoSourceReceipt;
  release?: InstalledDesktopRelease;
}

export type WebSandboxOptions = Omit<DesktopSandboxOptions, "release" | "releaseFetch">;
export type WebSandbox = Omit<DesktopSandbox, "release">;

export interface SandboxRepoSourceReceipt {
  requestedRef: string;
  expectedSha: string;
  actualSha: string;
  preparedFingerprint: string;
  dependenciesInstalled: boolean;
  verifiedAt: string;
}

export interface PrepareSandboxRepoOptions extends ProvisionExecOptions {
  sandbox: string;
  ref: string;
  log?: (line: string) => void;
}

export interface DenSandboxOptions {
  ref: string;
  reuse?: string;
  repoRoot?: string;
  bootstrapAdminEmail?: string;
  /** Extra Den environment for a freshly provisioned sandbox; a reused Den is already running and cannot take it. */
  env?: Record<string, string>;
  /** Daytona idle shutdown in minutes; preview worlds pass 0 so their owner process controls expiry. */
  autoStopMinutes?: number;
  log?: (line: string) => void;
}

export interface DenSandbox {
  sandbox: string;
  apiUrl: string;
  webUrl: string;
  created: boolean;
}

export interface MockOnSandboxOptions {
  sandbox: string;
  port?: number;
  log?: (line: string) => void;
  fetchImpl?: typeof fetch;
  allowUnauthenticatedMcp?: boolean;
  appToolName?: string;
  /** Exact trusted runner-side mock source to execute instead of the checkout copy. */
  scriptSource?: string;
  /** SHA-256 of scriptSource, used in the remote path and provisioning receipt. */
  sourceFingerprint?: string;
}

export interface MockOnSandbox {
  url: string;
  loopbackUrl: string;
  sourceFingerprint: string;
  stop(): Promise<void>;
}

export interface FaultProxyOnSandboxOptions {
  sandbox: string;
  port?: number;
  upstreamPort?: number;
  log?: (line: string) => void;
  fetchImpl?: typeof fetch;
}

export interface FaultProxyOnSandbox {
  url: string;
  token: string;
  stop(): Promise<void>;
}

export interface ConnectorE2eTestEnv {
  denApiUrl: string;
  denWebUrl: string;
  sandboxA: string;
  sandboxB: string;
  mockUrl: string;
  ref: string;
  created: string[];
}

function messageText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isInfrastructureReadinessError(error: unknown): boolean {
  return /(?:status|HTTP) 502|connection refused|ECONNREFUSED/i.test(messageText(error));
}

function outputTail(result: DaytonaExecResult): string {
  return `${result.stdout}${result.stderr}`.trim().slice(-2_000);
}

function textTail(text: string): string {
  return text.trim().slice(-4_000);
}

function firstHttpsUrl(text: string): string | null {
  const match = HTTPS_URL.exec(text);
  return match ? match[0].replace(/[.,;:]+$/, "") : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function desktopReleaseArtifact(release: DesktopRelease): { assetName: string; binaryName: string } {
  if (!/^\d+\.\d+\.\d+$/.test(release.version)) {
    throw new Error(`Desktop release version must be an exact x.y.z version without a tag prefix; received ${JSON.stringify(release.version)}.`);
  }
  const artifact = RELEASE_ARTIFACTS[release.distribution];
  if (!artifact) {
    throw new Error(`Unsupported desktop release distribution ${JSON.stringify(release.distribution)}. Use public, cloud, or enterprise.`);
  }
  return {
    assetName: `${artifact.prefix}-linux-x64-${release.version}.tar.gz`,
    binaryName: artifact.binary,
  };
}

export async function resolvePublishedDesktopRelease(
  release: DesktopRelease,
  fetchImpl: typeof fetch = fetch,
): Promise<PublishedDesktopRelease> {
  const { assetName, binaryName } = desktopReleaseArtifact(release);
  const tag = `v${release.version}`;
  const response = await fetchImpl(`https://api.github.com/repos/${RELEASE_REPOSITORY}/releases/tags/${tag}`, {
    headers: { accept: "application/vnd.github+json", "user-agent": "openwork-release-preview" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(`Could not resolve published desktop release ${tag}: GitHub API returned HTTP ${response.status}.`);
  }
  const body: unknown = await response.json();
  if (!isRecord(body) || body.tag_name !== tag || body.draft === true || body.prerelease === true || !Array.isArray(body.assets)) {
    throw new Error(`GitHub returned invalid or unpublished metadata for desktop release ${tag}.`);
  }
  const matches = body.assets.filter((entry: unknown) => isRecord(entry) && entry.name === assetName && entry.state === "uploaded");
  if (matches.length !== 1) {
    throw new Error(`Published desktop release ${tag} must contain exactly one ${assetName} asset; found ${matches.length}.`);
  }
  const asset = matches[0];
  if (!isRecord(asset)) throw new Error(`GitHub returned invalid metadata for ${assetName}.`);
  const digest = asset.digest;
  const browserDownloadUrl = asset.browser_download_url;
  const size = asset.size;
  if (typeof digest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(digest)) {
    throw new Error(`Published asset ${assetName} has no authoritative SHA-256 digest.`);
  }
  const expectedUrl = `https://github.com/${RELEASE_REPOSITORY}/releases/download/${tag}/${assetName}`;
  if (browserDownloadUrl !== expectedUrl) {
    throw new Error(`Published asset ${assetName} has an unexpected download URL.`);
  }
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size <= 0 || size > MAX_DESKTOP_RELEASE_ARCHIVE_BYTES) {
    throw new Error(`Published asset ${assetName} has an invalid size.`);
  }
  return { ...release, assetName, binaryName, browserDownloadUrl, digest, size };
}

async function timedStep<T>(log: (line: string) => void, name: string, action: () => Promise<T>): Promise<T> {
  const startedAt = Date.now();
  log(`==> ${name}...`);
  try {
    const result = await action();
    log(`==> ${name} done (${Date.now() - startedAt}ms)`);
    return result;
  } catch (error) {
    log(`==> ${name} failed (${Date.now() - startedAt}ms)`);
    throw error;
  }
}

/**
 * daytona exec joins its trailing args with spaces, so a multi-word command
 * must travel as ONE argument or `bash -lc` receives only the first word and
 * the rest leaks into the remote login shell.
 */
export async function execInSandbox(
  exec: DaytonaExec,
  sandbox: string,
  script: string,
  opts: { timeoutMs?: number; context: string },
): Promise<DaytonaExecResult> {
  if (script.includes("'")) throw new Error(`Remote script for ${opts.context} must not contain single quotes.`);
  return checkedExec(exec, ["exec", sandbox, "--", `bash -lc '${script}'`], opts.context, { timeoutMs: opts.timeoutMs });
}

/**
 * A ref travels into a remote double-quoted shell word AND into a file the
 * operator is told to `source`, so `$(...)`, a quote, or a newline in it is
 * remote code execution. Refuse anything outside git's own safe alphabet here
 * rather than escaping it correctly at each site forever.
 */
function assertSafeRef(ref: string): string {
  const value = ref.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value)) {
    throw new Error(`Unsafe git ref ${JSON.stringify(ref)}: only letters, digits and . _ / - are allowed, and it may not start with "-".`);
  }
  return value;
}

function snapshotId(output: string, name: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch (error) {
    throw new Error(`Snapshot gate failed: daytona snapshot list returned invalid JSON: ${messageText(error)}. Output tail: ${textTail(output)}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`Snapshot gate failed: daytona snapshot list did not return an array. Output tail: ${textTail(output)}`);
  }
  for (const entry of parsed) {
    if (isRecord(entry) && entry.name === name && typeof entry.id === "string" && entry.id.length > 0) return entry.id;
  }
  return null;
}

function sandboxTimestamp(): string {
  return new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
}

export function desktopSandboxName(name: string): string {
  // Split/join rather than trimming with /^-+|-+$/g: that pattern backtracks
  // quadratically on a mid-string run of hyphens (~1s at 40KB), which CodeQL
  // flags as polynomial ReDoS. This form cannot backtrack and also collapses
  // internal runs, so "a_-_b" yields "a-b" instead of "a---b".
  const safeName = name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).join("-") || "surface";
  return `openwork-connector-${safeName}-${sandboxTimestamp()}-${process.pid}-${randomBytes(4).toString("hex")}`;
}

export function serverSandboxName(): string {
  return `openwork-server-${sandboxTimestamp()}-${process.pid}-${randomBytes(4).toString("hex")}`;
}

async function waitForExecReady(exec: DaytonaExec, sandbox: string, timeoutMs = DESKTOP_READY_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "not attempted";
  while (Date.now() < deadline) {
    try {
      await execInSandbox(exec, sandbox, "true", { timeoutMs: 30_000, context: `sandbox exec-ready gate for ${sandbox}` });
      return;
    } catch (error) {
      lastError = messageText(error);
    }
    await delay(Math.min(5_000, Math.max(0, deadline - Date.now())));
  }
  throw new Error(`Sandbox exec-ready gate failed for ${sandbox} after ${timeoutMs}ms. Last output: ${lastError}`);
}

function lastNonemptyLine(text: string): string {
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1) ?? "";
}

function parseFullGitSha(value: string, context: string): string {
  const sha = lastNonemptyLine(value);
  if (!/^[0-9a-f]{40,64}$/.test(sha)) {
    throw new Error(`${context}: expected a full immutable git SHA, received ${JSON.stringify(sha)}.`);
  }
  return sha;
}

function parseSandboxRepoSourceReceipt(content: string, expectedRef?: string): SandboxRepoSourceReceipt {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch (error) {
    throw new Error(`Sandbox source receipt is not valid JSON: ${messageText(error)}.`);
  }
  if (!isRecord(value)
    || typeof value.requestedRef !== "string"
    || typeof value.expectedSha !== "string"
    || typeof value.actualSha !== "string"
    || typeof value.preparedFingerprint !== "string"
    || typeof value.dependenciesInstalled !== "boolean"
    || typeof value.verifiedAt !== "string") {
    throw new Error("Sandbox source receipt is missing required provenance fields.");
  }
  const requestedRef = assertSafeRef(value.requestedRef);
  if (expectedRef !== undefined && requestedRef !== assertSafeRef(expectedRef)) {
    throw new Error(`Sandbox source receipt requested ref mismatch: expected ${expectedRef}, received ${requestedRef}.`);
  }
  const expectedSha = parseFullGitSha(value.expectedSha, "Sandbox source receipt expected SHA");
  const actualSha = parseFullGitSha(value.actualSha, "Sandbox source receipt actual SHA");
  if (actualSha !== expectedSha) {
    throw new Error(`Sandbox source receipt mismatch: expected ${expectedSha}, received ${actualSha}.`);
  }
  if (!/^[0-9a-f]{64}$/.test(value.preparedFingerprint)) {
    throw new Error("Sandbox source receipt has an invalid prepared fingerprint.");
  }
  return {
    requestedRef,
    expectedSha,
    actualSha,
    preparedFingerprint: value.preparedFingerprint,
    dependenciesInstalled: value.dependenciesInstalled,
    verifiedAt: value.verifiedAt,
  };
}

async function sandboxHeadAfterCleanGate(exec: DaytonaExec, sandbox: string, context: string): Promise<string> {
  const result = await execInSandbox(
    exec,
    sandbox,
    "set -e; cd /workspace; dirty=\"$(git status --porcelain=v1 --untracked-files=all -- . \":(exclude).openwork-daytona\" \":(exclude).openwork-daytona/**\")\"; if [ -n \"$dirty\" ]; then echo \"Refusing source preparation because /workspace is dirty:\" >&2; echo \"$dirty\" >&2; exit 42; fi; git rev-parse --verify HEAD",
    { timeoutMs: 30_000, context },
  );
  return parseFullGitSha(result.stdout, context);
}

/**
 * Resolve and prepare one immutable checkout before any process may consume it.
 * The gate refuses dirty source, never resets files, and records the exact HEAD
 * that a later app launcher is allowed to use.
 */
export async function prepareSandboxRepo(options: PrepareSandboxRepoOptions): Promise<SandboxRepoSourceReceipt> {
  const exec = options.exec ?? defaultDaytonaExec;
  const log = options.log ?? console.error;
  const ref = assertSafeRef(options.ref);

  const initialSha = await timedStep(log, "source clean gate", () => sandboxHeadAfterCleanGate(
    exec,
    options.sandbox,
    `source clean gate for ${options.sandbox}`,
  ));
  const immutableRef = /^[0-9a-f]{7,64}$/.test(ref);
  const expectedResult = await timedStep(log, "source resolve gate", () => execInSandbox(
    exec,
    options.sandbox,
    immutableRef
      ? `set -e; cd /workspace; git fetch --quiet --no-tags origin \"${ref}\" 2>/dev/null || git fetch --quiet --no-tags origin; git rev-parse --verify \"${ref}^{commit}\"`
      : `set -e; cd /workspace; git fetch --quiet --no-tags origin \"${ref}\"; git rev-parse --verify FETCH_HEAD^{commit}`,
    { timeoutMs: 120_000, context: `source resolve gate for ${options.sandbox}` },
  ));
  const expectedSha = parseFullGitSha(expectedResult.stdout, `Source resolve gate for ${options.sandbox}`);

  if (initialSha !== expectedSha) {
    await timedStep(log, "source checkout gate", () => execInSandbox(
      exec,
      options.sandbox,
      `set -e; cd /workspace; git checkout --detach \"${expectedSha}\"`,
      { timeoutMs: 120_000, context: `source checkout gate for ${options.sandbox}` },
    ));
  }

  let actualSha = await timedStep(log, "source verification gate", () => sandboxHeadAfterCleanGate(
    exec,
    options.sandbox,
    `source verification gate for ${options.sandbox}`,
  ));
  if (actualSha !== expectedSha) {
    throw new Error(`Source verification gate failed for ${options.sandbox}: expected ${expectedSha}, received ${actualSha}.`);
  }

  const dependencyResult = await execInSandbox(
    exec,
    options.sandbox,
    "set -e; cd /workspace; git ls-tree -r --full-tree HEAD -- package.json \"*/package.json\" pnpm-lock.yaml pnpm-workspace.yaml .npmrc pnpmfile.cjs patches | sha256sum | cut -d \" \" -f 1",
    { timeoutMs: 30_000, context: `source dependency fingerprint for ${options.sandbox}` },
  );
  const dependencyFingerprint = lastNonemptyLine(dependencyResult.stdout);
  if (!/^[0-9a-f]{64}$/.test(dependencyFingerprint)) {
    throw new Error(`Source dependency fingerprint failed for ${options.sandbox}: received ${JSON.stringify(dependencyFingerprint)}.`);
  }
  const preparedFingerprint = createHash("sha256")
    .update(`${actualSha}\n${dependencyFingerprint}\n`)
    .digest("hex");
  const preparedResult = await execInSandbox(
    exec,
    options.sandbox,
    `if [ -d /workspace/node_modules ] && [ -f ${SANDBOX_PREPARED_FINGERPRINT_PATH} ] && [ \"$(cat ${SANDBOX_PREPARED_FINGERPRINT_PATH})\" = \"${preparedFingerprint}\" ]; then echo SOURCE_PREPARED; else echo SOURCE_STALE; fi`,
    { timeoutMs: 30_000, context: `source prepared fingerprint gate for ${options.sandbox}` },
  );
  const dependenciesInstalled = lastNonemptyLine(preparedResult.stdout) !== "SOURCE_PREPARED";
  if (dependenciesInstalled) {
    await timedStep(log, "source dependency install gate", () => execInSandbox(
      exec,
      options.sandbox,
      "set -e; cd /workspace; pnpm install --frozen-lockfile --store-dir /workspace/.openwork-daytona/pnpm-store",
      { timeoutMs: INSTALL_TIMEOUT_MS, context: `source dependency install gate for ${options.sandbox}` },
    ));
    await execInSandbox(
      exec,
      options.sandbox,
      `mkdir -p /workspace/.openwork-daytona; printf %s ${preparedFingerprint} > ${SANDBOX_PREPARED_FINGERPRINT_PATH}`,
      { timeoutMs: 30_000, context: `source prepared fingerprint write for ${options.sandbox}` },
    );
  }

  actualSha = await timedStep(log, "source post-prepare gate", () => sandboxHeadAfterCleanGate(
    exec,
    options.sandbox,
    `source post-prepare gate for ${options.sandbox}`,
  ));
  if (actualSha !== expectedSha) {
    throw new Error(`Source post-prepare gate failed for ${options.sandbox}: expected ${expectedSha}, received ${actualSha}.`);
  }

  const receipt: SandboxRepoSourceReceipt = {
    requestedRef: ref,
    expectedSha,
    actualSha,
    preparedFingerprint,
    dependenciesInstalled,
    verifiedAt: new Date().toISOString(),
  };
  const encodedReceipt = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`, "utf8").toString("base64");
  await execInSandbox(
    exec,
    options.sandbox,
    `mkdir -p /workspace/.openwork-daytona; printf %s ${encodedReceipt} | base64 -d > ${SANDBOX_SOURCE_RECEIPT_PATH}`,
    { timeoutMs: 30_000, context: `source receipt write for ${options.sandbox}` },
  );
  log(`==> source verified ${actualSha}`);
  return receipt;
}

export async function readSandboxRepoSourceReceipt(options: {
  sandbox: string;
  expectedRef?: string;
  exec?: DaytonaExec;
}): Promise<SandboxRepoSourceReceipt> {
  const result = await execInSandbox(
    options.exec ?? defaultDaytonaExec,
    options.sandbox,
    `cat ${SANDBOX_SOURCE_RECEIPT_PATH}`,
    { timeoutMs: 30_000, context: `source receipt read for ${options.sandbox}` },
  );
  return parseSandboxRepoSourceReceipt(result.stdout, options.expectedRef);
}

export interface PublishedDesktopReleaseInstallCommand {
  command: string;
  archivePath: string;
  appRoot: string;
  installRoot: string;
  manifestPath: string;
}

function safeInstallRoot(value: string): string {
  if (!/^\/[A-Za-z0-9._/-]+$/.test(value) || value.split("/").includes("..")) {
    throw new Error(`Published desktop release install root must be a safe absolute path; received ${JSON.stringify(value)}.`);
  }
  return value.replace(/\/+$/, "");
}

/** Complete fail-closed download, verification, and extraction command. */
export function publishedDesktopReleaseInstallCommand(
  release: PublishedDesktopRelease,
  requestedInstallRoot = `/workspace/.openwork-daytona/releases/${release.distribution}-${release.version}`,
): PublishedDesktopReleaseInstallCommand {
  const installRoot = safeInstallRoot(requestedInstallRoot);
  const archivePath = `${installRoot}/${release.assetName}`;
  const appRoot = `${installRoot}/app`;
  const manifestPath = `${installRoot}/release.json`;
  const installerPath = `${installRoot}/install.py`;
  const installer = Buffer.from(`${DESKTOP_RELEASE_ARCHIVE_INSTALLER}\n`, "utf8").toString("base64");
  const manifest = Buffer.from(`${JSON.stringify(release, null, 2)}\n`, "utf8").toString("base64");
  const digest = release.digest.slice("sha256:".length);
  const command = [
    "set -euo pipefail",
    "umask 077",
    `rm -rf ${installRoot}`,
    `mkdir -p ${installRoot}`,
    `curl --fail --location --retry 3 --retry-all-errors --connect-timeout 30 --max-time 900 --max-filesize ${release.size} --proto =https --tlsv1.2 --output ${archivePath} ${release.browserDownloadUrl}`,
    `printf %s ${installer} | base64 -d > ${installerPath}`,
    `printf %s ${manifest} | base64 -d > ${manifestPath}`,
    `python3 ${installerPath} ${archivePath} ${appRoot} ${release.binaryName} ${digest} ${release.size}`,
    `rm -f ${installerPath}`,
  ].join("; ");
  return { command, archivePath, appRoot, installRoot, manifestPath };
}

async function installPublishedDesktopRelease(
  exec: DaytonaExec,
  sandbox: string,
  release: PublishedDesktopRelease,
): Promise<InstalledDesktopRelease> {
  const install = publishedDesktopReleaseInstallCommand(release);
  const installed = await execInSandbox(exec, sandbox, install.command, {
    timeoutMs: INSTALL_TIMEOUT_MS,
    context: `published desktop release install for ${sandbox}`,
  });
  const binaryLine = installed.stdout.split(/\r?\n/).find((line) => line.startsWith("OPENWORK_RELEASE_BINARY="));
  const binaryPath = binaryLine?.slice("OPENWORK_RELEASE_BINARY=".length).trim();
  if (!binaryPath || !binaryPath.startsWith(`${install.appRoot}/`)) {
    throw new Error(`Published desktop release installer did not return a binary below ${install.appRoot}. Output tail: ${outputTail(installed)}`);
  }
  return { ...release, archivePath: install.archivePath, binaryPath, installRoot: install.installRoot, manifestPath: install.manifestPath };
}

function autoStopMinutes(value: number | undefined): string {
  const minutes = value ?? 60;
  if (!Number.isInteger(minutes) || minutes < 0 || minutes > 1440) {
    throw new Error(`Daytona auto-stop must be a whole number from 0 through 1440; received ${JSON.stringify(value)}.`);
  }
  return String(minutes);
}

export async function provisionDesktopSandbox(options: DesktopSandboxOptions & ProvisionExecOptions): Promise<DesktopSandbox> {
  return provisionSandbox(options, "desktop");
}

export async function provisionWebSandbox(options: WebSandboxOptions & ProvisionExecOptions): Promise<WebSandbox> {
  return provisionSandbox(options, "web");
}

async function provisionSandbox(
  options: DesktopSandboxOptions & ProvisionExecOptions,
  surface: "desktop" | "web",
): Promise<DesktopSandbox> {
  const exec = options.exec ?? defaultDaytonaExec;
  const log = options.log ?? console.error;
  if (surface === "desktop" && options.release && options.secrets === true) {
    throw new Error("Published desktop release sandboxes cannot mount the shared eval secrets volume.");
  }
  const release = surface === "desktop" && options.release
    ? await resolvePublishedDesktopRelease(options.release, options.releaseFetch)
    : undefined;
  const ref = release ? "" : assertSafeRef(options.ref);
  const reused = options.reuse?.trim() || "";
  let sandbox = reused;
  let created = false;
  let ownedSandbox = "";
  let installedRelease: InstalledDesktopRelease | undefined;
  let source: SandboxRepoSourceReceipt | undefined;
  try {
    await timedStep(log, "sandbox gate", async () => {
      if (reused) {
        await exec(["sandbox", "start", reused], { timeoutMs: 60_000 });
      } else {
        const snapshot = options.snapshot ?? "openwork-eval-vnc";
        const listed = await checkedExec(exec, ["snapshot", "list", "-f", "json"], "snapshot gate", { timeoutMs: 60_000 });
        const id = snapshotId(listed.stdout, snapshot);
        if (!id) {
          throw new Error(`Snapshot gate failed: snapshot ${snapshot} is missing. Output tail: ${outputTail(listed)}`);
        }
        sandbox = desktopSandboxName(options.name);
        const requestedAutoStop = autoStopMinutes(options.autoStopMinutes);
        ownedSandbox = sandbox;
        await checkedExec(
          exec,
          [
            "create",
            "--name", sandbox,
            "--snapshot", id,
            ...(options.secrets === true ? ["--volume", "openwork-eval-secrets:/daytona-secrets"] : []),
            "--auto-stop", requestedAutoStop,
            "--public",
            "--target", "us",
          ],
          `sandbox creation gate for ${sandbox}`,
          { timeoutMs: 300_000 },
        );
        created = true;
        log(`==> ${surface} sandbox created: ${sandbox}`);
      }
      await waitForExecReady(exec, sandbox, options.sandboxReadyTimeoutMs);
    });

    if (release) {
      installedRelease = await timedStep(log, "published release gate", () => installPublishedDesktopRelease(exec, sandbox, release));
    } else {
      source = await prepareSandboxRepo({ sandbox, ref, exec, log });

      await timedStep(log, "cleanup and disk gate", async () => {
        const result = await execInSandbox(
          exec,
          sandbox,
          surface === "desktop"
            ? "rm -rf /workspace/.openwork-daytona/profiles /tmp/openwork-* 2>/dev/null; df -P /workspace | tail -1"
            : "df -P /workspace | tail -1",
          { timeoutMs: 60_000, context: `cleanup and disk gate for ${sandbox}` },
        );
        const dfLine = lastNonemptyLine(result.stdout);
        const useField = dfLine.split(/\s+/).find((field) => /^\d+%$/.test(field));
        if (!useField) {
          throw new Error(`Cleanup and disk gate failed for ${sandbox}: could not parse Use% from ${JSON.stringify(dfLine)}.`);
        }
        const used = Number.parseInt(useField, 10);
        if (used <= 85) return;
        const sizes = await execInSandbox(
          exec,
          sandbox,
          "du -sh /workspace/node_modules /workspace/.openwork-daytona/pnpm-store 2>&1 || true",
          { timeoutMs: 60_000, context: `disk usage detail for ${sandbox}` },
        );
        throw new Error(`Cleanup and disk gate failed for ${sandbox}: workspace is ${useField} used. df: ${dfLine}\n${outputTail(sizes)}`);
      });
    }

    if (surface === "web") return { sandbox, created, source };

    await timedStep(log, "display gate", async () => {
      const result = await execInSandbox(
        exec,
        sandbox,
        "bash /workspace/.devcontainer/start-daytona-vnc.sh >/tmp/vnc.log 2>&1; sleep 2; pgrep -f Xvfb >/dev/null && echo XVFB_OK || echo XVFB_FAIL",
        { timeoutMs: 60_000, context: `display gate for ${sandbox}` },
      );
      if (!result.stdout.includes("XVFB_OK")) {
        throw new Error(`Display gate failed for ${sandbox}: expected XVFB_OK. Output tail: ${outputTail(result)}`);
      }
    });

    await timedStep(log, "browser hop gate", async () => {
    // Chromium launched inside a pipe-stdin exec session TERMs the whole
    // session as it starts (exit 143 at ~2.5s; the same script survives under
    // a TTY). So nothing may run as a child of the session: both halves are
    // fully detached the way the mock and Vite gates are, and the proof is
    // read back by clean, childless polls.
    const detachScript = `rm -f /tmp/xdgtest.log; python3 - <<PYEOF
import subprocess
log = open("/tmp/xdgtest.log", "ab", buffering=0)
subprocess.Popen(["python3", "-m", "http.server", "18099", "--bind", "127.0.0.1"], stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT, start_new_session=True, close_fds=True)
subprocess.Popen(["bash", "-lc", "sleep 1; export DISPLAY=:99; xdg-open http://127.0.0.1:18099/xdg-open-proof"], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True, close_fds=True)
PYEOF
echo detached`;
    await execInSandbox(exec, sandbox, detachScript, { timeoutMs: 30_000, context: `browser hop detach for ${sandbox}` });

    const deadline = Date.now() + 60_000;
    let seen = false;
    while (Date.now() < deadline) {
      const probe = await execInSandbox(
        exec,
        sandbox,
        "grep -q xdg-open-proof /tmp/xdgtest.log 2>/dev/null && echo XDG_OPEN_WORKS || echo XDG_WAITING",
        { timeoutMs: 15_000, context: `browser hop probe for ${sandbox}` },
      );
      if (probe.stdout.includes("XDG_OPEN_WORKS")) {
        seen = true;
        break;
      }
      await delay(3_000);
    }
    await execInSandbox(
      exec,
      sandbox,
      "pkill -f \"[h]ttp.server 18099\" >/dev/null 2>&1; pkill -f \"[c]hromium\" >/dev/null 2>&1; rm -f /tmp/xdgtest.log; true",
      { timeoutMs: 15_000, context: `browser hop cleanup for ${sandbox}` },
    ).catch(() => undefined);
    if (!seen) {
      throw new Error(`Browser hop gate failed for ${sandbox}: xdg-open never delivered a request (no browser reachable from the OAuth connect flow).`);
    }
    });

    if (installedRelease) {
      return { sandbox, created, release: installedRelease };
    }

    await timedStep(log, "first boot gate", async () => {
    // A sandbox's first Electron boot pays sidecar prepare, the
    // openwork-server tsc build, and the engine cold start. Paid INSIDE a
    // spec, that bill starved the tool-call phase past its window while every
    // UI assertion still passed. Boot once into a throwaway profile, wait for
    // CDP, tear it down — after this the room behaves like a warm machine.
    const detachScript = `python3 - <<PYEOF
import subprocess
log = open("/tmp/warmup-electron.log", "ab", buffering=0)
subprocess.Popen(["bash", "-lc", "cd /workspace && env OPENWORK_ELECTRON_USERDATA=/tmp/warmup-profile OPENWORK_ELECTRON_REMOTE_DEBUG_PORT=9825 bash .devcontainer/start-daytona-electron.sh"], stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT, start_new_session=True, close_fds=True)
PYEOF
echo detached`;
    await execInSandbox(exec, sandbox, detachScript, { timeoutMs: 30_000, context: `first boot detach for ${sandbox}` });
    const deadline = Date.now() + 420_000;
    let last = "not attempted";
    let ready = false;
    while (Date.now() < deadline) {
      const probe = await execInSandbox(
        exec,
        sandbox,
        "curl -s --max-time 5 http://127.0.0.1:9825/json/version || echo CDP_DOWN",
        { timeoutMs: 15_000, context: `first boot probe for ${sandbox}` },
      ).catch((error) => ({ stdout: messageText(error), stderr: "", code: 1 }));
      last = probe.stdout.trim().slice(0, 200);
      if (last.includes("Browser")) {
        ready = true;
        break;
      }
      await delay(5_000);
    }
    await execInSandbox(
      exec,
      sandbox,
      "pkill -f \"[e]lectron\" >/dev/null 2>&1; pkill -f \"[o]pencode\" >/dev/null 2>&1; sleep 1; rm -rf /tmp/warmup-profile; true",
      { timeoutMs: 30_000, context: `first boot cleanup for ${sandbox}` },
    ).catch(() => undefined);
    if (!ready) {
      const bootLog = await execInSandbox(
        exec,
        sandbox,
        "tail -60 /tmp/warmup-electron.log 2>&1 || true",
        { timeoutMs: 30_000, context: `first boot log for ${sandbox}` },
      ).catch(() => null);
      throw new Error(`First boot gate failed for ${sandbox}: CDP never answered on 9825. Last probe: ${last}. Log tail:\n${bootLog ? outputTail(bootLog) : "unavailable"}`);
    }
    });

    await timedStep(log, "Vite prewarm gate", async () => {
    const detachScript = `cd /workspace; python3 - <<PYEOF
import subprocess
log = open("/tmp/vite-prewarm.log", "ab", buffering=0)
subprocess.Popen(["bash", "-lc", "cd /workspace && pnpm -w dev:ui"], stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT, start_new_session=True, close_fds=True)
PYEOF
echo detached`;
    const deadline = Date.now() + VITE_PREWARM_TIMEOUT_MS;
    let last = "not attempted";
    let detached = false;
    while (Date.now() < deadline) {
      if (!detached) {
        try {
          await execInSandbox(exec, sandbox, detachScript, {
            timeoutMs: Math.min(30_000, Math.max(1, deadline - Date.now())),
            context: `Vite prewarm detach for ${sandbox}`,
          });
          detached = true;
        } catch (error) {
          if (!isInfrastructureReadinessError(error)) throw error;
          last = messageText(error);
          await delay(Math.min(READINESS_POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())));
          continue;
        }
      }
      try {
        const result = await execInSandbox(
          exec,
          sandbox,
          "curl -s -o /dev/null -w %{http_code} --max-time 5 http://localhost:5173/",
          { timeoutMs: 10_000, context: `Vite prewarm probe for ${sandbox}` },
        );
        last = result.stdout.trim();
        if (last === "200") return;
      } catch (error) {
        last = messageText(error);
      }
      await delay(Math.min(READINESS_POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())));
    }
    const viteLog = await execInSandbox(
      exec,
      sandbox,
      "tail -80 /tmp/vite-prewarm.log 2>&1 || true",
      { timeoutMs: 30_000, context: `Vite prewarm log for ${sandbox}` },
    );
    const phase = detached ? "Vite to answer on port 5173" : "the Daytona exec tunnel to accept the detach command";
    throw new Error(`Vite prewarm gate timed out after ${VITE_PREWARM_TIMEOUT_MS}ms waiting for ${phase} in ${sandbox}. Last readiness error: ${last}. Log tail:\n${outputTail(viteLog)}`);
    });

    return { sandbox, created, source };
  } catch (error) {
    if (ownedSandbox) {
      await deleteSandboxes([ownedSandbox], { exec, log }).catch((cleanupError: unknown) => {
        log(`==> ${surface} sandbox cleanup failed: ${messageText(cleanupError)}`);
      });
    }
    throw error;
  }
}

interface LocalProcessResult {
  output: string;
  code: number;
}

interface LineWriter {
  push(text: string): void;
  flush(): void;
}

function lineWriter(log: (line: string) => void): LineWriter {
  let pending = "";
  return {
    push(text) {
      pending += text;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? "";
      for (const line of lines) log(line);
    },
    flush() {
      if (pending) log(pending);
      pending = "";
    },
  };
}

/**
 * Extra Den env travels to the sandbox as base64 `KEY=VALUE` lines, so values
 * are never interpolated into the `daytona exec` command line. Keys must be
 * plain environment names; the start script exports each line verbatim.
 */
export function encodeDenExtraEnv(env: Record<string, string>): string {
  const lines = Object.entries(env).map(([key, value]) => {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) throw new Error(`Unsafe Den environment name ${JSON.stringify(key)}.`);
    if (value.includes("\n")) throw new Error(`Den environment value for ${key} may not contain a newline.`);
    return `${key}=${value}`;
  });
  return Buffer.from(lines.join("\n"), "utf8").toString("base64");
}

export function denProvisionScriptArgs(ref: string, name: string, requestedAutoStopMinutes?: number): string[] {
  return [".devcontainer/test-server-on-daytona.sh", ref, "--seed", "--name", name, "--auto-stop", autoStopMinutes(requestedAutoStopMinutes)];
}

function runDenProvisionScript(ref: string, repoRoot: string, bootstrapAdminEmail: string | undefined, extraEnv: Record<string, string> | undefined, log: (line: string) => void, urlsFile: string, requestedAutoStopMinutes?: number): Promise<LocalProcessResult> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env, OPENWORK_DEN_URLS_FILE: urlsFile };
    if (bootstrapAdminEmail) env.DEN_BOOTSTRAP_ADMIN_EMAILS = bootstrapAdminEmail;
    if (extraEnv && Object.keys(extraEnv).length > 0) env.OPENWORK_DEN_EXTRA_ENV_B64 = encodeDenExtraEnv(extraEnv);
    const child = spawn("bash", denProvisionScriptArgs(ref, serverSandboxName(), requestedAutoStopMinutes), {
      cwd: repoRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdoutLines = lineWriter(log);
    const stderrLines = lineWriter(log);
    let output = "";
    let timedOut = false;
    let settled = false;
    const timer = globalThis.setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, SERVER_SCRIPT_TIMEOUT_MS);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      const text = String(chunk);
      output += text;
      stdoutLines.push(text);
    });
    child.stderr.on("data", (chunk) => {
      const text = String(chunk);
      output += text;
      stderrLines.push(text);
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stdoutLines.flush();
      stderrLines.flush();
      if (timedOut) output += `\nTimed out after ${SERVER_SCRIPT_TIMEOUT_MS}ms.`;
      resolve({ output, code: timedOut ? 124 : code ?? 1 });
    });
  });
}

function sandboxFromServerOutput(output: string): string | null {
  let fallback: string | null = null;
  for (const line of output.split(/\r?\n/)) {
    const ready = /Server sandbox ready:\s*(\S+)/.exec(line);
    if (ready?.[1]) return ready[1];
    const creating = /Creating server sandbox:\s*(\S+)/.exec(line);
    if (creating?.[1]) fallback = creating[1];
  }
  return fallback;
}

function parsedPublicUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash || !url.hostname) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function parseDenUrlsFile(content: string): { webUrl: string; apiUrl: string } | null {
  const entries = new Map<string, string>();
  for (const line of content.split(/\r?\n/)) {
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    entries.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
  }
  const webUrl = parsedPublicUrl(entries.get("DEN_WEB_URL"));
  const apiUrl = parsedPublicUrl(entries.get("DEN_API_URL"));
  return webUrl && apiUrl ? { webUrl, apiUrl } : null;
}


async function previewUrl(exec: DaytonaExec, sandbox: string, port: number): Promise<string> {
  let lastError = "not attempted";
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const result = await checkedExec(
        exec,
        ["preview-url", sandbox, "-p", String(port), "--expires", "86400"],
        `preview URL gate for ${sandbox}:${port}`,
        { timeoutMs: 60_000 },
      );
      const url = firstHttpsUrl(result.stdout);
      if (url) return url;
      lastError = `no https URL in output tail: ${outputTail(result)}`;
    } catch (error) {
      lastError = messageText(error);
    }
    if (attempt < 4) await delay(attempt * 1_000);
  }
  throw new Error(`Preview URL gate failed for ${sandbox}:${port} after 4 attempts: ${lastError}`);
}

async function proveDenSeed(apiUrl: string, webUrl: string, sandbox: string, reused: boolean): Promise<void> {
  const email = process.env.OPENWORK_EVAL_DEMO_EMAIL?.trim() || "alex@acme.test";
  const password = process.env.OPENWORK_EVAL_DEMO_PASSWORD ?? "OpenWorkDemo123!";
  const url = `${apiUrl.replace(/\/+$/, "")}/api/auth/sign-in/email`;
  // A freshly-booted stack was observed answering public sign-in with bare
  // 403s for its first ~minute, then recovering on its own — so the window is
  // generous, and a failing status keeps its body so the failure names itself.
  // (That body once read MISSING_OR_NULL_ORIGIN: early boot rejects
  // origin-less POSTs, and every real client sends Origin — so must we.)
  const deadline = Date.now() + 120_000;
  let last = "not attempted";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", origin: webUrl },
        body: JSON.stringify({ email, password }),
        signal: AbortSignal.timeout(5_000),
      });
      if (response.status === 200) return;
      const body = await response.text().catch(() => "");
      last = `HTTP ${response.status} ${body.slice(0, 300)}`.trim();
    } catch (error) {
      last = messageText(error);
    }
    await delay(2_000);
  }
  if (reused) {
    throw new Error(`Den seed proof failed for reused sandbox ${sandbox}: the Den has no seeded org. Omit --reuse-den to provision a seeded Den sandbox. Last: ${last}`);
  }
  throw new Error(`Den seed proof failed for ${sandbox}: ${email} could not sign in at ${apiUrl}. Last: ${last}`);
}

export async function provisionDenSandbox(options: DenSandboxOptions & ProvisionExecOptions): Promise<DenSandbox> {
  const exec = options.exec ?? defaultDaytonaExec;
  const log = options.log ?? console.error;
  const ref = assertSafeRef(options.ref);
  const reused = options.reuse?.trim() || "";
  let sandbox: string;
  let webUrl: string;
  let apiUrl: string;

  if (reused) {
    sandbox = reused;
    // Reused sandboxes only get fresh signed aliases: their baked
    // DEN_*_PUBLIC_URL identity is unknown here, so RFC 9728 validating MCP
    // clients (opencode OAuth) cannot connect to a reused Den sandbox.
    [webUrl, apiUrl] = await timedStep(log, "Den preview URL gate", () => Promise.all([
      previewUrl(exec, sandbox, DEN_WEB_PORT),
      previewUrl(exec, sandbox, DEN_API_PORT),
    ]));
  } else {
    // URLs come from the trusted runner-side URLs file the provisioning
    // script writes from daytona CLI output, never from the script's stdout:
    // the ref being provisioned controls that stream, so a spoofed
    // "DEN_API_URL=https://attacker" line would receive the demo credentials
    // the sign-in proof posts moments later. Re-deriving fresh preview URLs
    // here is not an option either — every `daytona preview-url` call signs a
    // different hostname, while the sandbox's baked DEN_*_PUBLIC_URL is the
    // Den's OAuth issuer and MCP resource identity. RFC 9728 validating MCP
    // clients (opencode) refuse a Den reached through a mismatched host.
    const urlsDir = await mkdtemp(path.join(os.tmpdir(), "openwork-den-urls-"));
    const urlsFile = path.join(urlsDir, "den-urls.env");
    try {
      const result = await timedStep(log, "Den provisioning script", () => runDenProvisionScript(
        ref,
        options.repoRoot ?? REPO_ROOT,
        options.bootstrapAdminEmail,
        options.env,
        log,
        urlsFile,
        options.autoStopMinutes,
      ));
      if (result.code !== 0) {
        throw new Error(`Den provisioning script gate failed with exit ${result.code}. Output tail:\n${textTail(result.output)}`);
      }
      const parsedSandbox = sandboxFromServerOutput(result.output);
      if (!parsedSandbox) throw new Error(`Den provisioning script output is missing sandbox. Output tail:\n${textTail(result.output)}`);
      sandbox = parsedSandbox;
      const urls = parseDenUrlsFile(await readFile(urlsFile, "utf8").catch(() => ""));
      if (!urls) {
        throw new Error(
          `Den provisioning script did not hand back the sandbox's public URLs through ${urlsFile}. `
          + "The baked DEN_*_PUBLIC_URL identity must be reused verbatim; check .devcontainer/test-server-on-daytona.sh.",
        );
      }
      webUrl = urls.webUrl;
      apiUrl = urls.apiUrl;
    } finally {
      await rm(urlsDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  await timedStep(log, "Den seeded-org proof", () => proveDenSeed(apiUrl, webUrl, sandbox, Boolean(reused)));
  return { sandbox, apiUrl, webUrl, created: !reused };
}

export async function startMockOnSandbox(options: MockOnSandboxOptions & ProvisionExecOptions): Promise<MockOnSandbox> {
  const exec = options.exec ?? defaultDaytonaExec;
  const log = options.log ?? console.error;
  const fetchImpl = options.fetchImpl ?? fetch;
  const port = options.port ?? 3979;
  const url = await timedStep(log, "mock preview URL gate", () => previewUrl(exec, options.sandbox, port));
  const loopbackUrl = `http://127.0.0.1:${port}`;
  if ((options.scriptSource === undefined) !== (options.sourceFingerprint === undefined)) {
    throw new Error("Mock scriptSource and sourceFingerprint must be provided together.");
  }
  if (options.sourceFingerprint !== undefined && !/^[a-f0-9]{64}$/.test(options.sourceFingerprint)) {
    throw new Error("Mock sourceFingerprint must be a lowercase SHA-256 hex digest.");
  }
  if (options.scriptSource !== undefined
    && createHash("sha256").update(options.scriptSource).digest("hex") !== options.sourceFingerprint) {
    throw new Error("Mock sourceFingerprint does not match scriptSource.");
  }
  const sourceFingerprint = options.sourceFingerprint ?? "workspace-checkout";
  const scriptPath = options.scriptSource === undefined
    ? "/workspace/scripts/mock-oauth-mcp-server.mjs"
    : `/tmp/openwork-mock-oauth-mcp-${sourceFingerprint.slice(0, 16)}.mjs`;

  await timedStep(log, "mock process cleanup", async () => {
    await execInSandbox(
      exec,
      options.sandbox,
      "pkill -f \"[m]ock-oauth-mcp-server\" || true",
      { timeoutMs: 30_000, context: `mock process cleanup for ${options.sandbox}` },
    ).catch(() => undefined);
  });

  const scriptSource = options.scriptSource;
  if (scriptSource !== undefined) {
    await timedStep(log, "mock source upload", async () => {
      const encoded = Buffer.from(scriptSource, "utf8").toString("base64");
      const encodedPath = `${scriptPath}.b64`;
      await execInSandbox(exec, options.sandbox, `rm -f ${scriptPath} ${encodedPath}`, {
        timeoutMs: 30_000,
        context: `mock source reset for ${options.sandbox}`,
      });
      for (let offset = 0; offset < encoded.length; offset += 8 * 1024) {
        await execInSandbox(exec, options.sandbox, `printf %s ${encoded.slice(offset, offset + 8 * 1024)} >> ${encodedPath}`, {
          timeoutMs: 30_000,
          context: `mock source chunk upload for ${options.sandbox}`,
        });
      }
      await execInSandbox(exec, options.sandbox, `base64 -d ${encodedPath} > ${scriptPath}; rm -f ${encodedPath}`, {
        timeoutMs: 30_000,
        context: `mock source finalize for ${options.sandbox}`,
      });
    });
  }

  await timedStep(log, "mock process detach", async () => {
    const unauthenticatedMcpEnv = options.allowUnauthenticatedMcp ? " MOCK_ALLOW_UNAUTHENTICATED_MCP=1" : "";
    const appToolEnv = options.appToolName ? ` MOCK_APP_TOOL_NAME=${assertSafeRef(options.appToolName)}` : "";
    const command = `cd /workspace && env HOST=0.0.0.0 PORT=${port} ISSUER=${url} AUTO_APPROVE=1${unauthenticatedMcpEnv}${appToolEnv} node ${scriptPath}`;
    const detachScript = `cd /workspace; python3 - <<PYEOF
import subprocess
log = open("/tmp/mock-mcp.log", "ab", buffering=0)
subprocess.Popen(["bash", "-lc", ${JSON.stringify(command)}], stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT, start_new_session=True, close_fds=True)
PYEOF
echo detached`;
    await execInSandbox(exec, options.sandbox, detachScript, { timeoutMs: 30_000, context: `mock process detach for ${options.sandbox}` });
  });

  await timedStep(log, "mock health gate", async () => {
    const deadline = Date.now() + 60_000;
    let last = "not attempted";
    while (Date.now() < deadline) {
      let body: unknown = null;
      let responseOk = false;
      try {
        const response = await fetchImpl(`${url}/health`, { signal: AbortSignal.timeout(5_000) });
        body = await response.json();
        responseOk = response.ok;
        if (!response.ok) last = `HTTP ${response.status}`;
      } catch (error) {
        last = messageText(error);
      }
      if (responseOk && isRecord(body) && body.ok === true) {
        const issuer = typeof body.issuer === "string" ? body.issuer : JSON.stringify(body.issuer);
        if (issuer !== url) throw new Error(`Mock issuer gate failed: health reported ${issuer}, expected ${url}.`);
        return;
      }
      await delay(2_000);
    }
    const mockLog = await execInSandbox(
      exec,
      options.sandbox,
      "tail -80 /tmp/mock-mcp.log 2>&1 || true",
      { timeoutMs: 30_000, context: `mock health log for ${options.sandbox}` },
    );
    throw new Error(`Mock health gate failed at ${url}. Last: ${last}. Log tail:\n${outputTail(mockLog)}`);
  });

  const processPattern = scriptPath.replace("/", "[/]");
  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    await execInSandbox(exec, options.sandbox, `pkill -f ${processPattern} || true`, {
      timeoutMs: 30_000,
      context: `mock process stop for ${options.sandbox}`,
    });
    if (options.scriptSource !== undefined) {
      await execInSandbox(exec, options.sandbox, `rm -f ${scriptPath}`, {
        timeoutMs: 30_000,
        context: `mock source cleanup for ${options.sandbox}`,
      });
    }
  };
  return { url, loopbackUrl, sourceFingerprint, stop };
}

export async function startFaultProxyOnSandbox(options: FaultProxyOnSandboxOptions & ProvisionExecOptions): Promise<FaultProxyOnSandbox> {
  const exec = options.exec ?? defaultDaytonaExec;
  const log = options.log ?? console.error;
  const fetchImpl = options.fetchImpl ?? fetch;
  const port = options.port ?? 3985;
  const upstreamPort = options.upstreamPort ?? DEN_WEB_PORT;
  const token = randomBytes(16).toString("hex");
  const url = await timedStep(log, "fault proxy preview URL gate", () => previewUrl(exec, options.sandbox, port));

  await timedStep(log, "fault proxy process cleanup", async () => {
    await execInSandbox(
      exec,
      options.sandbox,
      "pkill -f openwork-fault-proxy || true",
      { timeoutMs: 30_000, context: `fault proxy process cleanup for ${options.sandbox}` },
    ).catch(() => undefined);
  });

  await timedStep(log, "fault proxy script upload", async () => {
    const encoded = Buffer.from(FAULT_PROXY_SCRIPT).toString("base64");
    await execInSandbox(
      exec,
      options.sandbox,
      `printf %s ${encoded} | base64 -d > /tmp/openwork-fault-proxy.mjs`,
      { timeoutMs: 30_000, context: `fault proxy script upload for ${options.sandbox}` },
    );
  });

  await timedStep(log, "fault proxy process detach", async () => {
    const detachScript = `python3 - <<PYEOF
import subprocess
log = open("/tmp/openwork-fault-proxy.log", "ab", buffering=0)
subprocess.Popen(["bash", "-lc", "env PORT=${port} UPSTREAM=http://127.0.0.1:${upstreamPort} ISSUER=${url} CONTROL_TOKEN=${token} node /tmp/openwork-fault-proxy.mjs"], stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT, start_new_session=True, close_fds=True)
PYEOF
echo detached`;
    await execInSandbox(exec, options.sandbox, detachScript, { timeoutMs: 30_000, context: `fault proxy process detach for ${options.sandbox}` });
  });

  await timedStep(log, "fault proxy health gate", async () => {
    const deadline = Date.now() + 60_000;
    let last = "not attempted";
    while (Date.now() < deadline) {
      let body: unknown = null;
      let responseOk = false;
      try {
        const response = await fetchImpl(`${url}/__openwork_faults/health`, { signal: AbortSignal.timeout(5_000) });
        body = await response.json();
        responseOk = response.ok;
        if (!response.ok) last = `HTTP ${response.status}`;
      } catch (error) {
        last = messageText(error);
      }
      if (responseOk && isRecord(body) && body.ok === true) {
        const reportedIssuer = typeof body.issuer === "string" ? body.issuer : JSON.stringify(body.issuer);
        if (reportedIssuer !== url) throw new Error(`Fault proxy issuer gate failed: health reported ${reportedIssuer}, expected ${url}.`);
        return;
      }
      await delay(2_000);
    }
    const proxyLog = await execInSandbox(
      exec,
      options.sandbox,
      "tail -80 /tmp/openwork-fault-proxy.log 2>&1 || true",
      { timeoutMs: 30_000, context: `fault proxy health log for ${options.sandbox}` },
    );
    throw new Error(`Fault proxy health gate failed at ${url}. Last: ${last}. Log tail:\n${outputTail(proxyLog)}`);
  });

  return {
    url,
    token,
    async stop(): Promise<void> {
      await execInSandbox(
        exec,
        options.sandbox,
        "pkill -f openwork-fault-proxy.mjs || true",
        { timeoutMs: 30_000, context: `fault proxy stop for ${options.sandbox}` },
      ).catch(() => undefined);
    },
  };
}

function deletionOutput(result: DaytonaExecResult): string {
  return `${result.stderr}\n${result.stdout}`.trim();
}

function deletionNotFound(text: string): boolean {
  return /not found|does not exist|no sandbox/i.test(text);
}

export async function deleteSandboxes(
  ids: string[],
  options: ProvisionExecOptions & { log?: (line: string) => void } = {},
): Promise<void> {
  const exec = options.exec ?? defaultDaytonaExec;
  const log = options.log ?? console.error;
  for (const id of ids) {
    log(`==> deleting sandbox ${id}...`);
    // The CLI has no --yes; answering its confirmation prompt on stdin works,
    // and a promptless future CLI would simply ignore the input.
    const result = await exec(["delete", id], { timeoutMs: 60_000, input: "y\n" });
    const output = deletionOutput(result);
    if (result.code !== 0 && deletionNotFound(output)) {
      log(`==> sandbox ${id} not found; continuing`);
      continue;
    }
    if (result.code !== 0) throw new Error(`Sandbox deletion gate failed for ${id} with exit ${result.code}. Output tail: ${textTail(output)}`);
    log(`==> deleted sandbox ${id}`);
  }
}

const ENV_HEADER_PREFIX = "# provisioned for org-connector-two-members";
const ENV_REF_MARKER = "; ref=";
const ENV_CREATED_PREFIX = "# provision-created=";

/** First line starting with prefix, minus the prefix. Linear, no backtracking. */
function commentLine(content: string, prefix: string): string | null {
  for (const line of content.split(/\r?\n/)) {
    if (line.startsWith(prefix)) return line.slice(prefix.length);
  }
  return null;
}

/** POSIX single-quoting: the generated file is `source`d, so an unquoted
 * value like `$(cmd)` would execute on the operator's machine. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replaceAll(`'"'"'`, "'");
  }
  return value;
}

export function renderConnectorE2eTestEnv(facts: ConnectorE2eTestEnv): string {
  assertSafeRef(facts.ref);
  return [
    `${ENV_HEADER_PREFIX} — generated ${new Date().toISOString()}${ENV_REF_MARKER}${facts.ref}`,
    `${ENV_CREATED_PREFIX}${facts.created.join(",")}`,
    "OPENWORK_EVAL_E2E_TESTS=1",
    "OPENWORK_EVAL_CONNECTOR_E2E_TEST=1",
    `OPENWORK_EVAL_DEN_API_URL=${shellQuote(facts.denApiUrl)}`,
    `OPENWORK_EVAL_DEN_WEB_URL=${shellQuote(facts.denWebUrl)}`,
    `OPENWORK_EVAL_DAYTONA_SANDBOX_A=${shellQuote(facts.sandboxA)}`,
    `OPENWORK_EVAL_DAYTONA_SANDBOX_B=${shellQuote(facts.sandboxB)}`,
    `OPENWORK_EVAL_CONNECTOR_MOCK_PUBLIC_URL=${shellQuote(facts.mockUrl)}`,
    "OPENWORK_EVAL_MODEL=big-pickle",
    "",
  ].join("\n");
}

export function parseConnectorE2eTestEnv(content: string): ConnectorE2eTestEnv {
  const values = new Map<string, string>();
  for (const line of content.split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator > 0) values.set(line.slice(0, separator), unquote(line.slice(separator + 1)));
  }
  function required(name: string): string {
    const value = values.get(name);
    if (value === undefined || value.length === 0) throw new Error(`Missing ${name} in connector spec env.`);
    return value;
  }

  required("OPENWORK_EVAL_E2E_TESTS");
  required("OPENWORK_EVAL_CONNECTOR_E2E_TEST");
  required("OPENWORK_EVAL_MODEL");
  // Header comments are read by line scan, not regex: `.*` before a literal
  // backtracks polynomially on adversarial input (CodeQL js/polynomial-redos).
  const header = commentLine(content, ENV_HEADER_PREFIX);
  const refAt = header ? header.lastIndexOf(ENV_REF_MARKER) : -1;
  if (refAt < 0) throw new Error("Missing ref in connector spec env header.");
  const ref = header?.slice(refAt + ENV_REF_MARKER.length) ?? "";
  if (!ref) throw new Error("Missing ref in connector spec env header.");
  const createdText = commentLine(content, ENV_CREATED_PREFIX);
  if (createdText === null) throw new Error("Missing provision-created in connector spec env header.");

  return {
    denApiUrl: required("OPENWORK_EVAL_DEN_API_URL"),
    denWebUrl: required("OPENWORK_EVAL_DEN_WEB_URL"),
    sandboxA: required("OPENWORK_EVAL_DAYTONA_SANDBOX_A"),
    sandboxB: required("OPENWORK_EVAL_DAYTONA_SANDBOX_B"),
    mockUrl: required("OPENWORK_EVAL_CONNECTOR_MOCK_PUBLIC_URL"),
    ref,
    created: createdText.split(",").map((id) => id.trim()).filter(Boolean),
  };
}
