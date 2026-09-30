import { spawnSync } from "node:child_process"
import { workspaceBuildEnvFlag } from "../../../../scripts/build-workspace-dependencies.mjs"

const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm"

function run(args) {
  const result = spawnSync(pnpmCommand, args, { stdio: "inherit" })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

// A recursive workspace build has already built utils in dependency order.
// Standalone database builds still prepare it for the Node bootstrap runtime.
if (process.env[workspaceBuildEnvFlag] !== "1") run(["run", "build:utils"])
run(["exec", "tsup"])
run(["exec", "tsc", "-p", "tsconfig.build.json"])
run(["exec", "tsup", "--config", "tsup.scripts.config.ts"])
run(["exec", "node", "scripts/build-assets.mjs"])
