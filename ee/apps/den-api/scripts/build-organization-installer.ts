import { buildOrganizationInstaller } from "../src/utils/organization-installer-command.js"

const args = process.argv.slice(2)

function has(name: string) {
  return args.includes(name)
}

function value(name: string, fallback = "") {
  const inline = args.find((entry) => entry.startsWith(`${name}=`))
  if (inline) return inline.slice(name.length + 1).trim()
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1]?.trim() || fallback : fallback
}

function usage() {
  console.log(`Build a deterministic OpenWork organization installer bundle.

Usage:
  pnpm enterprise-installer:build -- \\
    --config ./openwork-installer.json \\
    --platform mac-arm64 \\
    --output ./dist

Options:
  --config <path>          Organization installer JSON (appVersion required)
  --platform <platform>    mac-arm64, mac-x64, or win-x64
  --output <path>          Output directory or explicit .zip path
  --artifacts-dir <path>   Use exact local release artifacts; never access GitHub
  --release-repo <repo>    Release repository (default: different-ai/openwork)
  --dry-run                Validate config and artifacts without writing output
  --allow-insecure-http    Permit non-loopback HTTP for controlled development
  --help                   Show this help
`)
}

if (has("--help")) {
  usage()
  process.exit(0)
}

const configPath = value("--config")
const platform = value("--platform")
const output = value("--output", "dist/enterprise-installer")
if (!configPath || !platform) {
  usage()
  process.exit(2)
}

try {
  const result = await buildOrganizationInstaller({
    configPath,
    platform,
    output,
    artifactsDir: value("--artifacts-dir") || undefined,
    releaseRepo: value("--release-repo") || undefined,
    allowInsecureHttp: has("--allow-insecure-http"),
    dryRun: has("--dry-run"),
  })
  console.log(`Validated ${result.platform} organization bundle for ${result.releaseTag}.`)
  for (const artifact of result.artifacts) {
    console.log(`  ${artifact.fileName}  sha256:${artifact.sha256}`)
    console.log(`    source: ${artifact.source}`)
  }
  if (result.bundleSha256 && result.checksumPath) {
    console.log(`Created ${result.outputPath}`)
    console.log(`  sha256:${result.bundleSha256}`)
    console.log(`Checksum ${result.checksumPath}`)
  } else {
    console.log(`Dry run complete; no files written. Planned output: ${result.outputPath}`)
  }
} catch (error) {
  console.error(`Enterprise installer build failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
