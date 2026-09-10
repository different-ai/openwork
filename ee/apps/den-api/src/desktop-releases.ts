import { z } from "zod"
import { env } from "./env.js"
import { MIN_SUPPORTED_DESKTOP_VERSION, PUBLISHED_DESKTOP_VERSIONS } from "./generated/desktop-versions.js"
import { denApiAppVersion } from "./version.js"

const GITHUB_API_BASE_URL = "https://api.github.com"
const RELEASE_CACHE_TTL_MS = 5 * 60 * 1000
const RELEASE_FETCH_TIMEOUT_MS = 3000
const DESKTOP_RELEASE_TAG_PATTERN = /^v(\d+)\.(\d+)\.(\d+)$/

const githubReleaseSchema = z.object({
  draft: z.boolean(),
  prerelease: z.boolean(),
  tag_name: z.string(),
})

const githubReleasesSchema = z.array(githubReleaseSchema)

export type DesktopReleaseMetadata = {
  minAppVersion: string
  latestAppVersion: string
  publishedDesktopVersions: string[]
}

function parseStableVersion(value: string): [number, number, number] | null {
  const match = DESKTOP_RELEASE_TAG_PATTERN.exec(`v${value.replace(/^v/, "")}`)
  if (!match) {
    return null
  }

  const major = Number(match[1])
  const minor = Number(match[2])
  const patch = Number(match[3])
  return [major, minor, patch]
}

function compareStableVersions(left: string, right: string) {
  const leftParts = parseStableVersion(left)
  const rightParts = parseStableVersion(right)
  if (!leftParts || !rightParts) {
    return 0
  }

  for (let index = 0; index < 3; index += 1) {
    const leftPart = leftParts[index]
    const rightPart = rightParts[index]
    if (leftPart !== rightPart) {
      return leftPart < rightPart ? -1 : 1
    }
  }
  return 0
}

function staticReleaseMetadata(): DesktopReleaseMetadata {
  return {
    ...denApiAppVersion,
    publishedDesktopVersions: [...PUBLISHED_DESKTOP_VERSIONS],
  }
}

function copyReleaseMetadata(metadata: DesktopReleaseMetadata): DesktopReleaseMetadata {
  return {
    ...metadata,
    publishedDesktopVersions: [...metadata.publishedDesktopVersions],
  }
}

function metadataFromReleases(releases: z.infer<typeof githubReleasesSchema>): DesktopReleaseMetadata {
  const publishedDesktopVersions = Array.from(new Set(
    releases.flatMap((release) => {
      const match = DESKTOP_RELEASE_TAG_PATTERN.exec(release.tag_name)
      if (release.draft || release.prerelease || !match) {
        return []
      }

      const version = release.tag_name.slice(1)
      return compareStableVersions(version, MIN_SUPPORTED_DESKTOP_VERSION) >= 0 ? [version] : []
    }),
  )).sort((left, right) => compareStableVersions(right, left))

  if (!publishedDesktopVersions.length) {
    throw new Error("GitHub returned no eligible stable desktop releases")
  }

  return {
    minAppVersion: MIN_SUPPORTED_DESKTOP_VERSION,
    latestAppVersion: publishedDesktopVersions[0],
    publishedDesktopVersions,
  }
}

function releasesUrl() {
  const baseUrl = (env.desktopReleasesBaseUrl ?? GITHUB_API_BASE_URL).replace(/\/+$/, "")
  const repositoryPath = env.installerReleaseRepo
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/")
  return `${baseUrl}/repos/${repositoryPath}/releases?per_page=100`
}

// A self-hosted (single-org) Den must never hand out a desktop newer than
// itself by default, so it installs its own release instead of GitHub latest.
// Dev and commit builds have no stable release tag and keep runtime discovery.
function singleOrgDenReleaseTag() {
  if (env.orgMode === "multi_org") {
    return null
  }
  const releaseTag = `v${env.serviceVersion}`
  return DESKTOP_RELEASE_TAG_PATTERN.test(releaseTag) ? releaseTag : null
}

export function createDesktopReleaseSource() {
  let lastSuccessfulMetadata: DesktopReleaseMetadata | null = null
  let refreshAfter = 0
  let refreshPromise: Promise<DesktopReleaseMetadata> | null = null

  async function refresh(): Promise<DesktopReleaseMetadata> {
    try {
      const response = await fetch(releasesUrl(), {
        headers: {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        signal: AbortSignal.timeout(RELEASE_FETCH_TIMEOUT_MS),
      })
      if (!response.ok) {
        throw new Error(`GitHub releases request failed with status ${response.status}`)
      }

      const payload: unknown = await response.json()
      const metadata = metadataFromReleases(githubReleasesSchema.parse(payload))
      lastSuccessfulMetadata = metadata
      return copyReleaseMetadata(metadata)
    } catch (error) {
      console.warn("failed to refresh published desktop releases", {
        error,
        releaseRepo: env.installerReleaseRepo,
      })
      return copyReleaseMetadata(lastSuccessfulMetadata ?? staticReleaseMetadata())
    } finally {
      refreshAfter = Date.now() + RELEASE_CACHE_TTL_MS
    }
  }

  async function getDesktopReleaseMetadata(): Promise<DesktopReleaseMetadata> {
    if (env.desktopReleasesMode === "static") {
      return staticReleaseMetadata()
    }

    if (Date.now() < refreshAfter) {
      return copyReleaseMetadata(lastSuccessfulMetadata ?? staticReleaseMetadata())
    }

    if (!refreshPromise) {
      refreshPromise = refresh()
    }

    try {
      return await refreshPromise
    } finally {
      refreshPromise = null
    }
  }

  async function resolveInstallerReleaseTag() {
    if (env.installerReleaseTagExplicit) {
      return env.installerReleaseTag
    }
    if (env.desktopReleasesMode === "static") {
      return env.installerReleaseTag
    }
    const denReleaseTag = singleOrgDenReleaseTag()
    if (denReleaseTag) {
      return denReleaseTag
    }

    const metadata = await getDesktopReleaseMetadata()
    return `v${metadata.latestAppVersion}`
  }

  return {
    getDesktopReleaseMetadata,
    resolveInstallerReleaseTag,
  }
}

const desktopReleaseSource = createDesktopReleaseSource()

export const getDesktopReleaseMetadata = desktopReleaseSource.getDesktopReleaseMetadata
export const resolveInstallerReleaseTag = desktopReleaseSource.resolveInstallerReleaseTag
