import { createHash } from "node:crypto"

export const GITHUB_CLI_DEMO_CATALOG_KEY = "github-cli-demo"
export const GITHUB_CLI_DEMO_MANIFEST_VERSION = "1.0.0"

export type CliConnectorCommand = {
  id: "version"
  title: string
  description: string
  risk: "read"
  executable: "gh"
  argv: readonly ["--version"]
  timeoutMs: number
  stdoutLimitBytes: number
  stderrLimitBytes: number
}

export type CliConnectorManifest = {
  schemaVersion: 1
  catalogKey: typeof GITHUB_CLI_DEMO_CATALOG_KEY
  displayName: "GitHub CLI Demo"
  manifestVersion: typeof GITHUB_CLI_DEMO_MANIFEST_VERSION
  runtime: {
    baseImage: "docker.io/library/debian:bookworm-slim@sha256:7b140f374b289a7c2befc338f42ebe6441b7ea838a042bbd5acbfca6ec875818"
    ghVersion: "2.93.0"
    releaseAssets: {
      amd64: { url: string; sha256: string }
      arm64: { url: string; sha256: string }
    }
  }
  commands: { version: CliConnectorCommand }
}

export type ResolvedCliConnectorManifest = CliConnectorManifest & {
  digest: string
}

const githubCliDemoManifest: CliConnectorManifest = {
  schemaVersion: 1,
  catalogKey: GITHUB_CLI_DEMO_CATALOG_KEY,
  displayName: "GitHub CLI Demo",
  manifestVersion: GITHUB_CLI_DEMO_MANIFEST_VERSION,
  runtime: {
    baseImage: "docker.io/library/debian:bookworm-slim@sha256:7b140f374b289a7c2befc338f42ebe6441b7ea838a042bbd5acbfca6ec875818",
    ghVersion: "2.93.0",
    releaseAssets: {
      amd64: {
        url: "https://github.com/cli/cli/releases/download/v2.93.0/gh_2.93.0_linux_amd64.tar.gz",
        sha256: "02d1290eba130e0b896f3709ffff22e1c75a51475ddb70476a85abc6b5807af0",
      },
      arm64: {
        url: "https://github.com/cli/cli/releases/download/v2.93.0/gh_2.93.0_linux_arm64.tar.gz",
        sha256: "c55feb33684abba57e9909737340d5b39282257c0363e1edde6785ac4a413be7",
      },
    },
  },
  commands: {
    version: {
      id: "version",
      title: "Show GitHub CLI version",
      description: "Report the pinned GitHub CLI version running in OpenWork's hosted sandbox.",
      risk: "read",
      executable: "gh",
      argv: ["--version"],
      timeoutMs: 10_000,
      stdoutLimitBytes: 16_384,
      stderrLimitBytes: 16_384,
    },
  },
}

function manifestDigest(manifest: CliConnectorManifest): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(manifest)).digest("hex")}`
}

const resolvedGithubCliDemoManifest: ResolvedCliConnectorManifest = {
  ...githubCliDemoManifest,
  digest: manifestDigest(githubCliDemoManifest),
}

export function listCliConnectorManifests(): ResolvedCliConnectorManifest[] {
  return [resolvedGithubCliDemoManifest]
}

export function getCliConnectorManifest(
  catalogKey: string,
  manifestVersion?: string,
): ResolvedCliConnectorManifest | null {
  if (catalogKey !== resolvedGithubCliDemoManifest.catalogKey) return null
  if (manifestVersion && manifestVersion !== resolvedGithubCliDemoManifest.manifestVersion) return null
  return resolvedGithubCliDemoManifest
}
