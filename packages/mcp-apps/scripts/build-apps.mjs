import { build } from "vite"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"

const apps = [
  { entry: "connection-action", exportName: "connectionActionAppHtml" },
  { entry: "legacy-confirmation", exportName: "legacyConfirmationAppHtml" },
]
const packageDir = fileURLToPath(new URL("..", import.meta.url))
const dist = new URL("../dist/", import.meta.url)
const scratch = new URL(`../dist-build-${process.pid}/`, import.meta.url)
await mkdir(dist, { recursive: true })

async function publish(name, contents) {
  const temporary = new URL(`${name}.tmp-${process.pid}`, dist)
  await writeFile(temporary, contents)
  await rename(temporary, new URL(name, dist))
}

try {
  for (const { entry, exportName } of apps) {
    const output = new URL(`${entry}/`, scratch)
    process.env.OPENWORK_MCP_APP = entry
    await build({ root: packageDir, build: { outDir: fileURLToPath(output) } })
    const html = await readFile(new URL(`${entry}.html`, output), "utf8")
    await publish(`${entry}.js`, `export const ${exportName} = ${JSON.stringify(html)}\nexport default ${exportName}\n`)
    await publish(`${entry}.d.ts`, `export declare const ${exportName}: string\nexport default ${exportName}\n`)
  }
} finally {
  await rm(scratch, { recursive: true, force: true })
}
