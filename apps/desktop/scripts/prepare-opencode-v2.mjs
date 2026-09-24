import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import artifacts from "../../server/src/opencode-v2-artifacts.json" with { type: "json" };
import constants from "../../../constants.json" with { type: "json" };

export function opencodeV2ArtifactKey(target) {
  const platform = target?.includes("apple-darwin") ? "darwin" : target?.includes("linux") ? "linux" : target?.includes("windows") ? "windows" : null;
  const arch = target?.startsWith("aarch64-") ? "arm64" : target?.startsWith("x86_64-") ? "x64-baseline" : null;
  if (!platform || !arch) throw new Error(`Unsupported OpenCode v2 target: ${target}`);
  return `${platform}-${arch}${platform === "linux" && target.includes("musl") ? "-musl" : ""}`;
}

export async function prepareOpencodeV2(sidecarDir, target) {
  if (artifacts.version !== constants.opencodeV2Version) throw new Error("OpenCode v2 artifact pin does not match constants.json");
  const key = opencodeV2ArtifactKey(target);
  const artifact = artifacts.platforms[key];
  if (!artifact) throw new Error(`No verified OpenCode v2 artifact for ${key}`);
  const name = key.startsWith("windows-") ? "opencode2.exe" : "opencode2";
  const binary = join(sidecarDir, name);
  const receipt = join(sidecarDir, "opencode2-integrity.json");
  await mkdir(sidecarDir, { recursive: true });
  try {
    const cached = JSON.parse(await readFile(receipt, "utf8"));
    const bytes = await readFile(binary);
    if (cached.integrity === artifact.integrity && cached.sha256 === createHash("sha256").update(bytes).digest("hex")) return binary;
  } catch { /* Download and verify the pinned archive. */ }
  const staging = await mkdtemp(join(sidecarDir, ".opencode2-"));
  try {
    const archive = join(staging, "binary.tgz");
    // Use the same system download transport as the v1 sidecar preparation.
    execFileSync(process.platform === "win32" ? "curl.exe" : "curl", ["--fail", "--silent", "--show-error", "--max-time", "180", "--output", archive, artifact.url]);
    const bytes = await readFile(archive);
    if (`sha512-${createHash("sha512").update(bytes).digest("base64")}` !== artifact.integrity) throw new Error("OpenCode v2 archive integrity mismatch");
    execFileSync("tar", ["-xzf", archive, "-C", staging, `package/bin/${name}`]);
    await copyFile(join(staging, "package", "bin", name), binary);
    await chmod(binary, 0o755);
    if (process.platform === "darwin" && key.startsWith("darwin-")) {
      execFileSync("codesign", ["--force", "--sign", "-", binary]);
    }
    await writeFile(receipt, JSON.stringify({ integrity: artifact.integrity, sha256: createHash("sha256").update(await readFile(binary)).digest("hex") }));
    return binary;
  } finally { await rm(staging, { recursive: true, force: true }); }
}
