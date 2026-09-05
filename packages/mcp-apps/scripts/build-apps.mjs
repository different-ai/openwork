import { spawnSync } from "node:child_process"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"

const APPS = [
  { entry: "skill-created", exportName: "skillCreatedAppHtml" },
  { entry: "connection-action", exportName: "connectionActionAppHtml" },
  { entry: "plugin-flow", exportName: "pluginFlowAppHtml" },
]

const packageDir = fileURLToPath(new URL("..", import.meta.url))
const distUrl = new URL("../dist/", import.meta.url)
// Concurrent consumers (parallel test files) import from dist while a build
// runs, so never clear dist: stage into a scratch dir and atomically rename
// each artifact into place.
const scratchBase = new URL(`../dist-build-${process.pid}/`, import.meta.url)

await mkdir(distUrl, { recursive: true })

async function writeAtomic(fileName, contents) {
  const finalUrl = new URL(fileName, distUrl)
  const temporaryUrl = new URL(`${fileName}.tmp-${process.pid}`, distUrl)
  await writeFile(temporaryUrl, contents)
  await rename(temporaryUrl, finalUrl)
}

try {
  for (const app of APPS) {
    const scratchDir = new URL(`${app.entry}/`, scratchBase)
    const build = spawnSync("pnpm", ["exec", "vite", "build", "--outDir", fileURLToPath(scratchDir)], {
      cwd: packageDir,
      stdio: "inherit",
      env: { ...process.env, OPENWORK_MCP_APP: app.entry },
    })
    if (build.status !== 0) {
      throw new Error(`vite build failed for ${app.entry}`)
    }
    const html = await readFile(new URL(`${app.entry}.html`, scratchDir), "utf8")
    await writeAtomic(`${app.entry}.js`, [
      `export const ${app.exportName} = ${JSON.stringify(html)}`,
      `export default ${app.exportName}`,
      "",
    ].join("\n"))
    await writeAtomic(`${app.entry}.d.ts`, [
      `export declare const ${app.exportName}: string`,
      `export default ${app.exportName}`,
      "",
    ].join("\n"))
  }
} finally {
  await rm(scratchBase, { recursive: true, force: true })
}
