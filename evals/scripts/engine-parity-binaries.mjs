import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

/** Retry interrupted archive transfers; callers verify the pinned hash before extraction. */
export async function downloadEngineArchive(url, archive) {
  await exec(process.platform === "win32" ? "curl.exe" : "curl", [
    "--fail", "--silent", "--show-error", "--connect-timeout", "20", "--max-time", "300",
    "--retry", "2", "--retry-all-errors", "--retry-delay", "1", "--retry-max-time", "600",
    "--output", archive, url,
  ], { timeout: 610_000 });
}

export async function binaryVersion(binary) {
  const { stdout } = await exec(binary, ["--version"], { timeout: 15_000 });
  const version = stdout.trim().match(/(?:^|\s)v?(\d+\.\d+\.\d+(?:-[\w.-]+)?)$/)?.[1];
  if (!version) throw new Error(`Unrecognized engine version from ${binary}`);
  return version;
}

async function json(url) {
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`Engine metadata returned HTTP ${response.status}`);
  return response.json();
}

/** Download native archives only; no registry package lifecycle scripts run. */
export async function prepareParityBinaries(root, overrides = process.env) {
  const pins = JSON.parse(await readFile(join(root, "constants.json"), "utf8"));
  const v2 = JSON.parse(await readFile(join(root, "apps/server/src/opencode-v2-artifacts.json"), "utf8"));
  if (v2.version !== pins.opencodeV2Version) throw new Error("V2 artifact manifest does not match the repository pin");
  const platform = process.platform === "win32" ? "windows" : process.platform;
  const musl = process.platform === "linux" && !process.report.getReport().header.glibcVersionRuntime;
  const key = `${platform}-${process.arch}${process.arch === "x64" ? "-baseline" : ""}${musl ? "-musl" : ""}`;
  const resolved = {};
  for (const engine of ["v1", "v2"]) {
    const variable = engine === "v1" ? "OPENWORK_OPENCODE_BIN" : "OPENWORK_OPENCODE2_BIN";
    const version = (engine === "v1" ? pins.opencodeVersion : pins.opencodeV2Version).replace(/^v/, "");
    const archiveName = `opencode${platform === "windows" ? ".exe" : ""}`;
    const name = `${engine === "v1" ? "opencode" : "opencode2"}${platform === "windows" ? ".exe" : ""}`;
    const directory = join(root, "evals/results/engine-parity/binaries", engine, version, key);
    const binary = overrides[variable] || join(directory, name);
    if (await binaryVersion(binary).catch(() => null) === version) { resolved[variable] = binary; continue; }
    if (overrides[variable]) throw new Error(`${variable} must report pinned version ${version}`);
    const artifact = engine === "v2" ? v2.platforms[key] : (await json(`https://registry.npmjs.org/opencode-${key}/${version}`)).dist;
    const url = artifact?.url ?? artifact?.tarball;
    if (!url || !artifact.integrity?.startsWith("sha512-") || new URL(url).origin !== "https://registry.npmjs.org") throw new Error(`No verified native archive for ${engine} ${key}`);
    await mkdir(directory, { recursive: true });
    const staging = await mkdtemp(join(directory, ".install-"));
    try {
      const archive = join(staging, "binary.tgz");
      await downloadEngineArchive(url, archive);
      const bytes = await readFile(archive);
      if (`sha512-${createHash("sha512").update(bytes).digest("base64")}` !== artifact.integrity) throw new Error("Engine archive integrity mismatch");
      await exec("tar", ["-xzf", archive, "-C", staging, `package/bin/${archiveName}`], { timeout: 60_000 });
      const extracted = join(staging, "package/bin", archiveName);
      await chmod(extracted, 0o755);
      if (await binaryVersion(extracted) !== version) throw new Error("Downloaded engine version does not match the pin");
      await rename(extracted, binary);
    } finally { await rm(staging, { recursive: true, force: true }); }
    resolved[variable] = binary;
  }
  return resolved;
}
