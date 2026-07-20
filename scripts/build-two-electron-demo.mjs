import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const desktopRoot = path.join(repoRoot, "apps", "desktop");
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const configs = ["electron-builder.demo-a.yml", "electron-builder.demo-b.yml"];

function build(config) {
  return new Promise((resolve, reject) => {
    const child = spawn(pnpm, ["exec", "electron-builder", "--config", config, "--dir"], {
      cwd: desktopRoot,
      env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: "false" },
      shell: process.platform === "win32",
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${config} packaging failed (${signal || `exit ${code ?? 1}`}).`));
    });
  });
}

await Promise.all(configs.map(build));
console.log("Packaged OpenWork Demo A and OpenWork Demo B.");
