import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(__dirname, "..");

const executable = process.platform === "win32"
  ? path.join(desktopRoot, "dist-electron", "win-unpacked", "OpenWork.exe")
  : process.platform === "darwin"
    ? path.join(desktopRoot, "dist-electron", "mac", "OpenWork.app", "Contents", "MacOS", "OpenWork")
    : path.join(desktopRoot, "dist-electron", "linux-unpacked", "openwork");

if (!existsSync(executable)) {
  console.error(`[packaged-startup] missing packaged executable: ${executable}`);
  process.exit(1);
}

const env = { ...process.env };
// Many agent/test shells set this to use Electron as a Node runtime. A packaged
// desktop startup check must remove it; otherwise Electron exits before loading
// the app's main entrypoint, which is not representative of end-user launches.
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(executable, [], {
  cwd: desktopRoot,
  env,
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});

let stdout = "";
let stderr = "";
child.stdout?.on("data", (chunk) => { stdout += chunk.toString(); });
child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });

const timeout = Number.parseInt(process.env.OPENWORK_PACKAGED_STARTUP_MS ?? "10000", 10);
const startupMs = Number.isFinite(timeout) && timeout > 0 ? timeout : 10_000;

const timer = setTimeout(() => {
  child.kill("SIGTERM");
  console.log(`[packaged-startup] ok: process stayed alive for ${startupMs}ms`);
}, startupMs);

child.on("exit", (code, signal) => {
  clearTimeout(timer);
  if (signal === "SIGTERM") return;
  console.error(`[packaged-startup] failed: process exited early with code=${code} signal=${signal ?? ""}`);
  if (stdout.trim()) console.error(`[packaged-startup] stdout:\n${stdout}`);
  if (stderr.trim()) console.error(`[packaged-startup] stderr:\n${stderr}`);
  process.exit(code ?? 1);
});
