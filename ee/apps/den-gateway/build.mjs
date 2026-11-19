import { execFileSync } from "node:child_process"
import { writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { buildWorkspaceDependencies } from "../../../scripts/build-workspace-dependencies.mjs"

buildWorkspaceDependencies("@openwork-ee/den-gateway")
execFileSync(process.execPath, [fileURLToPath(import.meta.resolve("typescript/bin/tsc")), "-p", "tsconfig.build.json"], { stdio: "inherit" })
await writeFile(new URL("./dist/server.js", import.meta.url), 'import "./ee/apps/den-gateway/src/server.js"\n')
