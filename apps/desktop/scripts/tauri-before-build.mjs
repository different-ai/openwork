import { spawnSync } from "node:child_process";

const pnpmCmd = process.platform === "win32" ? "corepack.cmd" : "pnpm";
const pnpmArgs = process.platform === "win32" ? ["pnpm"] : [];

const runPnpm = (args) => {
  const result = spawnSync(pnpmCmd, [...pnpmArgs, ...args], {
    stdio: "inherit",
    shell: process.platform === "win32",
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
};

runPnpm(["-C", "../..", "--filter", "@openwork/desktop", "run", "prepare:sidecar"]);
runPnpm(["--filter", "@openwork/app", "build"]);
