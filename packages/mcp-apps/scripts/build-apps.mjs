import { build } from "vite"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"

const entries = [
  { entry: "connection-action", exportName: "connectionActionAppHtml" },
  { entry: "workflow-runner", exportName: "workflowRunnerAppHtml" },
]
const packageDir = fileURLToPath(new URL("..", import.meta.url))
const dist = new URL("../dist/", import.meta.url)
// Concurrent consumers import from dist while a build runs, so stage into a
// scratch dir and rename each artifact into place instead of clearing dist.
const scratch = new URL(`../dist-build-${process.pid}/`, import.meta.url)
await mkdir(dist, { recursive: true })

async function publish(name, contents) {
  const temporary = new URL(`${name}.tmp-${process.pid}`, dist)
  await writeFile(temporary, contents)
  await rename(temporary, new URL(name, dist))
}

try {
  const bundles = []
  for (const { entry, exportName } of entries) {
    const outDir = new URL(`${entry}/`, scratch)
    await build({
      root: packageDir,
      build: { outDir: fileURLToPath(outDir), rollupOptions: { input: `${entry}.html` } },
    })
    const html = await readFile(new URL(`${entry}.html`, outDir), "utf8")
    bundles.push({ entry, exportName, html })
  }
  for (const { entry, exportName, html } of bundles) {
    await publish(`${entry}.js`, `export const ${exportName} = ${JSON.stringify(html)}\nexport default ${exportName}\n`)
    await publish(`${entry}.d.ts`, `export declare const ${exportName}: string\nexport default ${exportName}\n`)
  }
} finally {
  await rm(scratch, { recursive: true, force: true })
}
