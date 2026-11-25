import { readFile } from "node:fs/promises"

const root = new URL("../", import.meta.url)
const python = await readFile(new URL("requirements-desktop.lock", root), "utf8")
const node = JSON.parse(await readFile(new URL("desktop-node-packages.lock.json", root), "utf8"))
const queries = []
for (const line of python.split("\n").map((line) => line.trim())) {
  if (!line || line.startsWith("#")) continue
  const pin = /^([\w.-]+)==([^\s]+) --hash=sha256:/.exec(line)
  if (!pin) throw new Error(`Invalid pinned Python requirement: ${line}`)
  queries.push({ package: { ecosystem: "PyPI", name: pin[1] }, version: pin[2] })
}
if (!queries.length || !node.packages || Object.keys(node.packages).length < 2) throw new Error("Empty desktop lock")
for (const [path, entry] of Object.entries(node.packages)) {
  if (!path) continue
  const name = entry.name ?? path.split("node_modules/").at(-1)
  if (!name || !entry.version) throw new Error(`Invalid pinned Node package: ${path}`)
  queries.push({ package: { ecosystem: "npm", name }, version: entry.version })
}

for (let start = 0; start < queries.length; start += 1000) {
  const batch = queries.slice(start, start + 1000)
  const response = await fetch("https://api.osv.dev/v1/querybatch", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ queries: batch }),
    signal: AbortSignal.timeout(60_000),
  })
  if (!response.ok) throw new Error(`OSV lookup failed (${response.status})`)
  const { results } = await response.json()
  if (!Array.isArray(results) || results.length !== batch.length) throw new Error("Incomplete OSV response")
  for (const [index, result] of results.entries()) {
    const { package: pkg, version } = batch[index]
    for (const advisory of result.vulns ?? []) {
      console.error(`${pkg.ecosystem} ${pkg.name}@${version}: ${advisory.id}`)
      process.exitCode = 1
    }
  }
}
console.log(`Audited ${queries.length} locked desktop package entries.`)
