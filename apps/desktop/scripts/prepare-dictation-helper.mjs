import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(__dirname, "..");
const raw = process.argv.slice(2);
const outIndex = raw.indexOf("--outdir");
const outDir = resolve(outIndex >= 0 && raw[outIndex + 1] ? raw[outIndex + 1] : join(desktopRoot, "resources", "helpers"));
const force = raw.includes("--force");
const windows = process.platform === "win32";
const source = resolve(desktopRoot, "native", "dictation", windows ? "windows.cs" : "main.swift");
const executable = join(outDir, windows ? "openwork-dictation.exe" : "openwork-dictation");
const fingerprintPath = join(outDir, "openwork-dictation.sha256");

if (process.platform !== "darwin" && !windows) {
  process.stdout.write(JSON.stringify({ ok: true, skipped: true, reason: "dictation-helper-is-macos-and-windows-only" }) + "\n");
  process.exit(0);
}

const arch = windows ? "anycpu" : process.arch === "x64" ? "x86_64" : "arm64";
const sourceHash = createHash("sha256").update(arch).update(readFileSync(source)).update(readFileSync(fileURLToPath(import.meta.url))).digest("hex");
if (!force && existsSync(executable) && existsSync(fingerprintPath) && readFileSync(fingerprintPath, "utf8").trim() === sourceHash) {
  process.stdout.write(JSON.stringify({ ok: true, skipped: true, executable }) + "\n");
  process.exit(0);
}

/** Every Windows 10/11 install carries the .NET Framework compiler and the
 * WinRT metadata, so the helper needs no SDK. A missing helper is not fatal:
 * the composer falls back to Windows voice typing (Windows + H). */
function windowsCompile() {
  const systemRoot = process.env.SystemRoot || "C:\\Windows";
  const framework = ["Framework64", "Framework"].map(dir => join(systemRoot, "Microsoft.NET", dir, "v4.0.30319"))
    .find(dir => existsSync(join(dir, "csc.exe")));
  const metadata = join(systemRoot, "System32", "WinMetadata");
  if (!framework || !existsSync(metadata)) return { error: "The .NET Framework compiler or WinRT metadata is missing" };
  const references = [
    ...["System.Runtime.dll", "System.Runtime.WindowsRuntime.dll", "System.Runtime.InteropServices.WindowsRuntime.dll", "System.Threading.Tasks.dll"]
      .map(name => join(framework, name)),
    ...["Windows.Foundation.winmd", "Windows.Globalization.winmd", "Windows.Media.winmd"].map(name => join(metadata, name)),
  ].filter(existsSync);
  return spawnSync(join(framework, "csc.exe"), [
    "/nologo", "/optimize+", "/target:exe", "/platform:anycpu", `/out:${executable}`,
    ...references.map(reference => `/reference:${reference}`), source,
  ], { stdio: "inherit" });
}

mkdirSync(outDir, { recursive: true });
// electron-builder signs this binary with OpenWork's identity (and on macOS the
// app's inherited entitlements), so microphone and speech permissions are OpenWork's.
const result = windows
  ? windowsCompile()
  : spawnSync("swiftc", ["-O", "-target", `${arch}-apple-macos14.0`, source, "-o", executable], { stdio: "inherit" });
if (result.error || result.status !== 0) {
  const reason = typeof result.error === "string" ? result.error : result.error?.message ?? `status ${result.status}`;
  if (!windows) throw new Error(`swiftc failed for the dictation helper: ${reason}`);
  const message = `Windows dictation helper was not built (${reason}); dictation falls back to Windows voice typing.`;
  process.stderr.write(process.env.GITHUB_ACTIONS ? `::warning::${message}\n` : `${message}\n`);
  process.exit(0);
}
writeFileSync(fingerprintPath, sourceHash, "utf8");
process.stdout.write(JSON.stringify({ ok: true, executable }) + "\n");
