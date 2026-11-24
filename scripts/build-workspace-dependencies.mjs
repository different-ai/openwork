import { spawnSync } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"

export const workspaceBuildEnvFlag = "OPENWORK_WORKSPACE_BUILD"

export function buildWorkspaceDependencies(packageName, cwd = process.cwd()) {
  const command = process.platform === "win32" ? "pnpm.cmd" : "pnpm"
  const result = spawnSync(command, ["--filter", `${packageName}^...`, "--if-present", "run", "build"], {
    cwd,
    env: { ...process.env, [workspaceBuildEnvFlag]: "1" },
    stdio: "inherit",
  })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const packageName = process.argv[2]
  if (!packageName) throw new Error("Pass the workspace package whose dependencies should be built")
  buildWorkspaceDependencies(packageName)
}
