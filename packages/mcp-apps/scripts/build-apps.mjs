import { build } from "vite"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"

// One App bundle for now: the connection App. Add entries here as more
// first-party Apps earn a shared runtime.
const entry = "connection-action"
const exportName = "connectionActionAppHtml"
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
  await build({ root: packageDir, build: { outDir: fileURLToPath(scratch) } })
  const html = await readFile(new URL(`${entry}.html`, scratch), "utf8")
  await publish(`${entry}.js`, `export const ${exportName} = ${JSON.stringify(html)}\nexport default ${exportName}\n`)
  await publish(`${entry}.d.ts`, `export declare const ${exportName}: string\nexport default ${exportName}\n`)
} finally {
  await rm(scratch, { recursive: true, force: true })
}
