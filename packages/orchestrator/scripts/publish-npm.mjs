#!/usr/bin/env node

import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync, copyFileSync } from "node:fs"
import { basename, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(fileURLToPath(new URL("..", import.meta.url)))

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
const version = String(pkg.version || "").trim()
if (!version) {
  throw new Error("openwork-orchestrator version missing in packages/orchestrator/package.json")
}

const outroot = join(root, "dist", "npm")
rmSync(outroot, { recursive: true, force: true })
mkdirSync(outroot, { recursive: true })

const tag = String(process.env.NPM_TAG || "").trim()
const dry = String(process.env.DRY_RUN || "").trim() === "1"

const targets = [
  { id: "darwin-arm64", bun: "bun-darwin-arm64", os: "darwin", cpu: "arm64" },
  { id: "darwin-x64", bun: "bun-darwin-x64", os: "darwin", cpu: "x64" },
  { id: "linux-x64", bun: "bun-linux-x64", os: "linux", cpu: "x64" },
  { id: "linux-arm64", bun: "bun-linux-arm64", os: "linux", cpu: "arm64" },
  { id: "windows-x64", bun: "bun-windows-x64", os: "win32", cpu: "x64" },
]

function run(cmd, args, cwd) {
  const res = spawnSync(cmd, args, { cwd, stdio: "inherit" })
  if (res.status !== 0) {
    process.exit(res.status ?? 1)
  }
}

function writeJson(filepath, data) {
  writeFileSync(filepath, `${JSON.stringify(data, null, 2)}\n`, "utf8")
}

function platformPkgName(target) {
  const platform = target.id.split("-")[0]
  const arch = target.id.split("-").slice(1).join("-")
  return `openwork-orchestrator-${platform}-${arch}`
}

const optionalDependencies = {}
const published = []

for (const target of targets) {
  const name = platformPkgName(target)
  optionalDependencies[name] = version

  const ext = target.id.startsWith("windows") ? ".exe" : ""
  const src = join(root, "dist", "bin", `openwork-${target.bun}${ext}`)
  if (!existsSync(src)) {
    throw new Error(`Missing openwork binary at ${src}. Run: pnpm --filter openwork-orchestrator build:bin:all`)
  }

  const dir = join(outroot, name)
  const bindir = join(dir, "bin")
  mkdirSync(bindir, { recursive: true })

  const dest = join(bindir, `openwork${ext}`)
  copyFileSync(src, dest)
  if (!target.id.startsWith("windows")) {
    chmodSync(dest, 0o755)
  }

  writeJson(join(dir, "package.json"), {
    name,
    version,
    description: "Platform binary for openwork-orchestrator",
    license: "MIT",
    os: [target.os],
    cpu: [target.cpu],
    bin: {
      openwork: `./bin/openwork${ext}`,
      "openwork-orchestrator": `./bin/openwork${ext}`,
    },
    files: ["bin"],
  })

  published.push({ name, dir })
}

const meta = join(outroot, "openwork-orchestrator")
mkdirSync(join(meta, "bin"), { recursive: true })

const wrapperSrc = join(root, "bin", "openwork")
if (!existsSync(wrapperSrc)) {
  throw new Error(`Missing wrapper at ${wrapperSrc}`)
}
copyFileSync(wrapperSrc, join(meta, "bin", "openwork"))
chmodSync(join(meta, "bin", "openwork"), 0o755)

const postinstallSrc = join(root, "scripts", "postinstall.mjs")
if (!existsSync(postinstallSrc)) {
  throw new Error(`Missing postinstall at ${postinstallSrc}`)
}
copyFileSync(postinstallSrc, join(meta, basename(postinstallSrc)))

writeJson(join(meta, "package.json"), {
  name: "openwork-orchestrator",
  version,
  description: "OpenWork host orchestrator for opencode + OpenWork server + opencode-router",
  license: "MIT",
  bin: {
    openwork: "./bin/openwork",
    "openwork-orchestrator": "./bin/openwork",
  },
  scripts: {
    postinstall: "bun ./postinstall.mjs || node ./postinstall.mjs",
  },
  optionalDependencies,
  files: ["bin", "postinstall.mjs"],
})

published.push({ name: "openwork-orchestrator", dir: meta })

for (const item of published) {
  if (dry) {
    console.log(`Packing (dry run) ${item.name} from ${item.dir}`)
    run("npm", ["pack"], item.dir)
    continue
  }

  const args = ["publish", "--access", "public"]
  if (tag) args.push("--tag", tag)
  console.log(`Publishing ${item.name} from ${item.dir}`)
  run("npm", args, item.dir)
}
