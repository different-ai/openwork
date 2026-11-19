#!/usr/bin/env node
// Fast guard (file reads only, no Docker or pnpm) for the Dockerfiles in
// packaging/docker that copy workspace packages one by one for layer caching.
// A package that gains a dependency on another workspace package must have
// that package copied too:
//
//   1. Every workspace dependency of a copied package.json must have its own
//      package.json copied, or `pnpm install` in the image fails.
//   2. Every runtime workspace dependency (`dependencies`) of a copied source
//      folder must be copied as source too, or the import fails at runtime.
//
// Run directly or through `pnpm features:check`.

import { existsSync, readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const DEPENDENCY_FIELDS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"))
}

/** name -> repo-relative directory, from the simple "dir/*" globs in pnpm-workspace.yaml. */
function workspacePackages(root) {
  const yaml = readFileSync(path.join(root, "pnpm-workspace.yaml"), "utf8")
  const block = /^packages:\n((?:\s+-\s+.+\n)+)/m.exec(yaml)
  if (!block) throw new Error("pnpm-workspace.yaml has no packages list")
  const globs = [...block[1].matchAll(/-\s+["']?([^"'\n]+?)["']?\s*$/gm)].map((match) => match[1])
  const byName = new Map()
  for (const glob of globs) {
    if (!glob.endsWith("/*")) throw new Error(`Unsupported workspace glob "${glob}"; extend scripts/check-docker-workspace-packages.mjs`)
    const parent = glob.slice(0, -2)
    const absolute = path.join(root, parent)
    if (!existsSync(absolute)) continue
    for (const entry of readdirSync(absolute)) {
      const manifest = path.join(absolute, entry, "package.json")
      if (!existsSync(manifest)) continue
      const name = readJson(manifest).name
      if (typeof name === "string") byName.set(name, `${parent}/${entry}`)
    }
  }
  return byName
}

function workspaceDependencies(root, dir, fields) {
  const manifest = readJson(path.join(root, dir, "package.json"))
  const names = []
  for (const field of fields) {
    for (const [name, version] of Object.entries(manifest[field] ?? {})) {
      if (typeof version === "string" && version.startsWith("workspace:")) names.push(name)
    }
  }
  return names
}

export function checkDockerWorkspacePackages(root) {
  const problems = []
  const packages = workspacePackages(root)
  const dirs = new Set(packages.values())
  const dockerDir = path.join(root, "packaging/docker")

  for (const file of readdirSync(dockerDir).filter((entry) => entry.startsWith("Dockerfile")).sort()) {
    const text = readFileSync(path.join(dockerDir, file), "utf8")
    const manifests = new Set()
    const sources = new Set()
    for (const match of text.matchAll(/^COPY\s+(\S+)\s+\/app\/(\S+)\s*$/gm)) {
      const [, from, to] = match
      if (from !== to) continue
      if (from.endsWith("/package.json")) manifests.add(from.slice(0, -"/package.json".length))
      else if (dirs.has(from)) sources.add(from)
    }
    if (manifests.size === 0) continue // builds from the whole repository

    const label = `packaging/docker/${file}`
    for (const dir of manifests) {
      if (!dirs.has(dir)) continue
      for (const name of workspaceDependencies(root, dir, DEPENDENCY_FIELDS)) {
        const needed = packages.get(name)
        if (needed && !manifests.has(needed)) {
          problems.push(`${label}: ${dir} depends on ${name}; add \`COPY ${needed}/package.json /app/${needed}/package.json\` before \`pnpm install\`.`)
        }
      }
    }
    for (const dir of sources) {
      for (const name of workspaceDependencies(root, dir, ["dependencies"])) {
        const needed = packages.get(name)
        if (needed && !sources.has(needed)) {
          problems.push(`${label}: ${dir} imports ${name} at runtime; add \`COPY ${needed} /app/${needed}\`.`)
        }
      }
    }
  }
  return problems
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
  const started = performance.now()
  const problems = checkDockerWorkspacePackages(root)
  for (const problem of problems) console.error(`[docker] ${problem}`)
  console.log(`[docker] ${problems.length === 0 ? "Dockerfiles copy every workspace package they need" : `${problems.length} problem(s)`} (${Math.round(performance.now() - started)} ms)`)
  process.exit(problems.length === 0 ? 0 : 1)
}
