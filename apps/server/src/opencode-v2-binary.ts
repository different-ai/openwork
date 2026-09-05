import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, chmod, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import artifacts from "./opencode-v2-artifacts.json" with { type: "json" };

const exec = promisify(execFile);

/** Install only the pinned native executable; never run registry lifecycle scripts. */
export async function installOpencodeV2Binary(cacheRoot: string, version: string): Promise<string> {
  if (version !== artifacts.version) throw new Error(`No verified OpenCode v2 artifacts for ${version}`);
  const platform = process.platform === "win32" ? "windows" : process.platform;
  const report = process.platform === "linux" ? process.report?.getReport() : undefined;
  const glibc = typeof report === "object" && report !== null && "header" in report
    && typeof report.header === "object" && report.header !== null && "glibcVersionRuntime" in report.header;
  const key = `${platform}-${process.arch}${process.arch === "x64" ? "-baseline" : ""}${platform === "linux" && !glibc ? "-musl" : ""}`;
  const artifact = Object.entries(artifacts.platforms).find(([name]) => name === key)?.[1];
  if (!artifact) throw new Error(`OpenCode v2 does not support ${key}`);
  const directory = join(cacheRoot, version, key);
  const name = platform === "windows" ? "opencode2.exe" : "opencode2";
  const binary = join(directory, name);
  try { await access(binary); return binary; } catch { /* First installation. */ }
  await mkdir(cacheRoot, { recursive: true, mode: 0o700 });
  await chmod(cacheRoot, 0o700);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const staging = await mkdtemp(join(directory, ".install-"));
  try {
    const response = await fetch(artifact.url, { redirect: "error", signal: AbortSignal.timeout(180_000) });
    if (!response.ok) throw new Error(`OpenCode v2 download returned HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
    if (integrity !== artifact.integrity) throw new Error("OpenCode v2 archive integrity mismatch");
    const archive = join(staging, "binary.tgz");
    await writeFile(archive, bytes, { mode: 0o600 });
    await exec("tar", ["-xzf", archive, "-C", staging, `package/bin/${name}`], { timeout: 60_000 });
    const extracted = join(staging, "package", "bin", name);
    await chmod(extracted, 0o755);
    await rename(extracted, binary);
    return binary;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
