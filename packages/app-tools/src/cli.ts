import { readFile, writeFile } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"

import {
  formatDiagnostic,
  validateManifest,
  type Diagnostic,
  type HostEnvironment,
} from "@openwork/app-contract"

import { collectAppDirectory, CollectError } from "./collect.js"
import { checksumFileContents, packApp } from "./pack.js"
import { verifyPackage } from "./verify.js"

// `openwork-app` — the tool an app author runs, and the tool CI runs.
//
// It shares one validator and one verifier with the OpenWork host, so a package
// that passes here is a package the host will accept, and a package rejected
// here would have been rejected on a user's machine.

const USAGE = `openwork-app — OpenWork Apps packaging tools

Usage:
  openwork-app validate <path/to/openwork.app.json>
  openwork-app pack --root <app-dir> --out <file.owapp>
                    --repository <https://github.com/owner/name>
                    --tag <release-tag> --commit <40-hex-sha>
  openwork-app verify <file.owapp> [--expect-digest sha256:...]
                                   [--os darwin|linux|win32] [--arch x64|arm64]
                                   [--openwork-version <semver>]

Exit codes: 0 ok, 1 rejected, 2 usage error.
`

type Args = { positional: string[]; flags: Map<string, string> }

function parseArgs(argv: readonly string[]): Args {
  const positional: string[] = []
  const flags = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string
    if (token.startsWith("--")) {
      const [name, inline] = token.slice(2).split("=", 2)
      if (!name) continue
      if (inline !== undefined) {
        flags.set(name, inline)
        continue
      }
      const next = argv[index + 1]
      if (next === undefined || next.startsWith("--")) {
        flags.set(name, "true")
        continue
      }
      flags.set(name, next)
      index += 1
      continue
    }
    positional.push(token)
  }
  return { positional, flags }
}

function report(diagnostics: readonly Diagnostic[]): void {
  for (const diagnostic of diagnostics) {
    const stream = diagnostic.severity === "error" ? process.stderr : process.stdout
    stream.write(`${formatDiagnostic(diagnostic)}\n`)
  }
}

function requireFlag(args: Args, name: string): string {
  const value = args.flags.get(name)
  if (value === undefined || value === "true") {
    process.stderr.write(`missing required --${name}\n`)
    process.exit(2)
  }
  return value
}

async function runValidate(args: Args): Promise<number> {
  const target = args.positional[0]
  if (!target) {
    process.stderr.write(USAGE)
    return 2
  }
  const text = await readFile(resolve(target), "utf8")
  const result = validateManifest(text)
  report(result.diagnostics)
  if (!result.ok) {
    process.stderr.write("manifest rejected\n")
    return 1
  }
  process.stdout.write(
    `ok: ${result.manifest.id} ${result.manifest.version} — ${result.manifest.permissions.length} permission(s), ${result.manifest.contributions.length} contribution(s)\n`,
  )
  return 0
}

async function runPack(args: Args): Promise<number> {
  const root = resolve(requireFlag(args, "root"))
  const out = resolve(requireFlag(args, "out"))
  const repository = requireFlag(args, "repository")
  const releaseTag = requireFlag(args, "tag")
  const commit = requireFlag(args, "commit")

  let collected
  try {
    collected = await collectAppDirectory(root)
  } catch (thrown) {
    if (thrown instanceof CollectError) {
      process.stderr.write(`error: ${thrown.message} [collect.${thrown.code}]\n`)
      return 1
    }
    throw thrown
  }

  const result = packApp({
    manifestText: collected.manifestText,
    files: collected.files,
    source: { repository, release_tag: releaseTag, commit },
  })
  report(result.diagnostics)
  if (!result.ok) {
    process.stderr.write("package rejected\n")
    return 1
  }

  await writeFile(out, result.archive)
  const checksumPath = `${out}.sha256`
  await writeFile(checksumPath, checksumFileContents(result.archiveDigest, basename(out)), "utf8")

  process.stdout.write(
    [
      `packed ${result.manifest.id} ${result.manifest.version}`,
      `  archive:  ${out} (${result.archive.length} bytes)`,
      `  digest:   ${result.archiveDigest}`,
      `  checksum: ${checksumPath}`,
      `  expected release asset name: ${result.assetName}`,
      `  files:    ${result.metadata.files.length}`,
      "",
    ].join("\n"),
  )
  if (basename(out) !== result.assetName) {
    process.stdout.write(
      `warning: the manifest expects the release asset to be named ${result.assetName}\n`,
    )
  }
  return 0
}

async function runVerify(args: Args): Promise<number> {
  const target = args.positional[0]
  if (!target) {
    process.stderr.write(USAGE)
    return 2
  }
  const archivePath = resolve(target)
  const archive = await readFile(archivePath)

  let expected = args.flags.get("expect-digest")
  if (expected === undefined) {
    // Fall back to a sibling .sha256, which is what a release publishes.
    const sidecar = join(dirname(archivePath), `${basename(archivePath)}.sha256`)
    const text = await readFile(sidecar, "utf8").catch(() => null)
    if (text) {
      const hex = text.trim().split(/\s+/, 1)[0]
      if (hex) expected = `sha256:${hex}`
    }
  }

  const os = args.flags.get("os")
  const arch = args.flags.get("arch")
  const openworkVersion = args.flags.get("openwork-version")
  const host: HostEnvironment | undefined =
    os && arch && openworkVersion
      ? {
          openworkVersion,
          os: os as HostEnvironment["os"],
          arch: arch as HostEnvironment["arch"],
        }
      : undefined

  const result = verifyPackage(archive, {
    ...(expected === undefined ? {} : { expectedArchiveDigest: expected }),
    ...(host === undefined ? {} : { host }),
  })
  report(result.diagnostics)
  if (!result.ok) {
    process.stderr.write("package rejected\n")
    return 1
  }

  const { manifest, metadata, archiveDigest } = result.package
  process.stdout.write(
    [
      `verified ${manifest.id} ${manifest.version}`,
      `  digest:     ${archiveDigest}`,
      `  repository: ${metadata.source.repository}`,
      `  release:    ${metadata.source.release_tag}`,
      `  commit:     ${metadata.source.commit}`,
      `  files:      ${metadata.files.length}`,
      `  permissions:`,
      ...manifest.permissions.map((permission) => `    - ${permission.id}`),
      "",
      "Provenance is a GitHub release binding plus content hashing. It is not a",
      "publisher signature and does not attest who built these bytes.",
      "",
    ].join("\n"),
  )
  return 0
}

export async function main(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv
  const args = parseArgs(rest)
  switch (command) {
    case "validate":
      return runValidate(args)
    case "pack":
      return runPack(args)
    case "verify":
      return runVerify(args)
    case "--help":
    case "-h":
    case "help":
    case undefined:
      process.stdout.write(USAGE)
      return 0
    default:
      process.stderr.write(`unknown command: ${command}\n\n${USAGE}`)
      return 2
  }
}
