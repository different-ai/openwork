import process from "node:process"
import { pathToFileURL } from "node:url"

const DEFAULT_API_URL = "https://app.daytona.io/api"
const PAGE_LIMIT = 200
const SETTLED_SNAPSHOT_STATES = new Set([
  "active",
  "inactive",
  "error",
  "build_failed",
])
const INACTIVE_SANDBOX_STATES = new Set([
  "stopped",
  "archived",
  "destroyed",
  "error",
])

function requiredValue(value, message) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(message)
  }

  return value.trim()
}

function validateSnapshotName(snapshotName) {
  const value = requiredValue(
    snapshotName,
    "Missing snapshot name. Pass --keep <name>.",
  )

  if (value !== snapshotName || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
    throw new Error(
      `Invalid snapshot name ${JSON.stringify(snapshotName)}. Use only letters, numbers, dots, underscores, and hyphens, with no whitespace.`,
    )
  }

  return value
}

function validateKeepCount(keepCount) {
  if (!Number.isSafeInteger(keepCount) || keepCount < 0) {
    throw new Error("--keep-count must be an integer greater than or equal to 0.")
  }

  return keepCount
}

function authorizationHeaders(apiKey) {
  const key = requiredValue(
    apiKey,
    "Missing Daytona API key. Set DAYTONA_API_KEY before running this command.",
  )
  return {
    Accept: "application/json",
    Authorization: `Bearer ${key}`,
  }
}

async function responseBody(response) {
  const body = await response.text()
  if (!response.ok) {
    const statusText = response.statusText ? ` ${response.statusText}` : ""
    throw new Error(
      `Daytona API request failed with HTTP ${response.status}${statusText}: ${body}`,
    )
  }

  return body
}

async function responseJson(response, description) {
  const body = await responseBody(response)

  try {
    return JSON.parse(body)
  } catch {
    throw new Error(`Daytona API returned invalid JSON for ${description}: ${body}`)
  }
}

function normalizedState(value) {
  return typeof value === "string" ? value.toLowerCase() : ""
}

function compareNewest(left, right) {
  const created = right.createdAt.localeCompare(left.createdAt)
  return created || left.name.localeCompare(right.name)
}

function compareOldest(left, right) {
  const created = left.createdAt.localeCompare(right.createdAt)
  return created || left.name.localeCompare(right.name)
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

// Release snapshots are named `<base>-<version>` from validated release tags
// (see release-daytona-snapshot.yml), so scope on that exact shape. Per-push
// dev snapshots (`<base>-dev-<sha>`) can never match because "dev" is not a
// version number.
function releaseSnapshotPattern(nameBase) {
  return new RegExp(
    `^${escapeRegExp(nameBase)}-\\d+\\.\\d+\\.\\d+([.-][0-9A-Za-z.-]+)?$`,
  )
}

function selectSnapshotPrunes({
  snapshots,
  sandboxes,
  inScope,
  keepNames,
  keepCount,
}) {
  const scoped = snapshots.filter((snapshot) => inScope(snapshot.name))
  const recentNames = new Set(
    [...scoped].sort(compareNewest).slice(0, keepCount).map((snapshot) => snapshot.name),
  )
  const explicitNames = new Set(keepNames)
  const activeReferences = new Set(
    sandboxes
      .filter((sandbox) => !INACTIVE_SANDBOX_STATES.has(normalizedState(sandbox.state)))
      .map((sandbox) => sandbox.snapshot)
      .filter((snapshotName) => typeof snapshotName === "string"),
  )
  const prune = []
  const keep = []

  for (const snapshot of [...scoped].sort(compareOldest)) {
    let reason
    if (explicitNames.has(snapshot.name)) {
      reason = "explicit"
    } else if (recentNames.has(snapshot.name)) {
      reason = "recent"
    } else if (!SETTLED_SNAPSHOT_STATES.has(normalizedState(snapshot.state))) {
      reason = "in-flight"
    } else if (activeReferences.has(snapshot.name)) {
      reason = "active-ref"
    }

    if (reason) {
      keep.push({ ...snapshot, reason })
    } else {
      prune.push(snapshot)
    }
  }

  return { prune, keep }
}

export function selectDevSnapshotPrunes({
  snapshots,
  sandboxes,
  nameBase,
  keepNames,
  keepCount,
}) {
  const prefix = `${nameBase}-dev-`
  return selectSnapshotPrunes({
    snapshots,
    sandboxes,
    keepNames,
    keepCount,
    inScope: (name) => name.startsWith(prefix),
  })
}

export function selectReleaseSnapshotPrunes({
  snapshots,
  sandboxes,
  nameBase,
  keepNames,
  keepCount,
}) {
  const pattern = releaseSnapshotPattern(nameBase)
  return selectSnapshotPrunes({
    snapshots,
    sandboxes,
    keepNames,
    keepCount,
    inScope: (name) => pattern.test(name),
  })
}

const CHANNELS = {
  dev: { select: selectDevSnapshotPrunes, defaultKeepCount: 5 },
  release: { select: selectReleaseSnapshotPrunes, defaultKeepCount: 20 },
}

function validateChannel(channel) {
  if (!Object.hasOwn(CHANNELS, channel)) {
    throw new Error(`Invalid channel ${JSON.stringify(channel)}. Use dev or release.`)
  }

  return channel
}

async function readSnapshots({ apiUrl, apiKey, fetchImpl }) {
  const snapshots = []
  for (let page = 1; ; page += 1) {
    const response = await fetchImpl(
      `${apiUrl}/snapshots?limit=${PAGE_LIMIT}&page=${page}`,
      { method: "GET", headers: authorizationHeaders(apiKey) },
    )
    const parsed = await responseJson(response, "snapshots")
    if (
      !parsed ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      !Array.isArray(parsed.items) ||
      typeof parsed.total !== "number"
    ) {
      throw new Error("Daytona API snapshots response did not contain items and total.")
    }
    snapshots.push(...parsed.items)
    if (snapshots.length >= parsed.total || parsed.items.length < PAGE_LIMIT) {
      return snapshots
    }
  }
}

async function readSandboxes({ apiUrl, apiKey, fetchImpl }) {
  const sandboxes = []
  let nextCursor = ""
  for (let page = 1; page <= 100; page += 1) {
    const pagination = nextCursor
      ? `&cursor=${encodeURIComponent(nextCursor)}`
      : page > 1
        ? `&page=${page}`
        : ""
    const response = await fetchImpl(
      `${apiUrl}/sandbox?limit=${PAGE_LIMIT}${pagination}`,
      { method: "GET", headers: authorizationHeaders(apiKey) },
    )
    const parsed = await responseJson(response, "sandboxes")
    if (Array.isArray(parsed)) {
      sandboxes.push(...parsed)
      if (parsed.length < PAGE_LIMIT) {
        return sandboxes
      }
      continue
    }

    if (
      !parsed ||
      typeof parsed !== "object" ||
      !Array.isArray(parsed.items)
    ) {
      throw new Error("Daytona API sandbox response did not contain a sandbox list.")
    }
    sandboxes.push(...parsed.items)
    nextCursor =
      typeof parsed.nextCursor === "string" && parsed.nextCursor.length > 0
        ? parsed.nextCursor
        : ""
    if (!nextCursor) {
      return sandboxes
    }
  }

  throw new Error("Daytona API sandbox pagination exceeded 100 pages.")
}

export async function pruneDaytonaSnapshots({
  apiUrl = DEFAULT_API_URL,
  channel = "dev",
  nameBase = "openwork",
  keepNames,
  keepCount,
  dryRun = false,
  apiKey,
  fetchImpl = globalThis.fetch,
  log = console.log,
}) {
  const baseUrl = requiredValue(apiUrl, "Missing Daytona API URL.").replace(/\/+$/, "")
  const scope = CHANNELS[validateChannel(channel)]
  const base = requiredValue(nameBase, "Missing snapshot name base.")
  const protectedNames = keepNames.map(validateSnapshotName)
  const recentCount = validateKeepCount(keepCount ?? scope.defaultKeepCount)
  authorizationHeaders(apiKey)

  const snapshots = await readSnapshots({ apiUrl: baseUrl, apiKey, fetchImpl })
  const sandboxes = await readSandboxes({ apiUrl: baseUrl, apiKey, fetchImpl })
  const selection = scope.select({
    snapshots,
    sandboxes,
    nameBase: base,
    keepNames: protectedNames,
    keepCount: recentCount,
  })
  const failures = []
  let prunedCount = 0

  for (const snapshot of selection.keep) {
    log(`${dryRun ? "dry-run: " : ""}keep: ${snapshot.name} (${snapshot.reason})`)
  }

  for (const snapshot of selection.prune) {
    if (dryRun) {
      log(`dry-run: pruned: ${snapshot.name} (${snapshot.id})`)
      prunedCount += 1
      continue
    }

    try {
      const response = await fetchImpl(
        `${baseUrl}/snapshots/${encodeURIComponent(snapshot.id)}`,
        { method: "DELETE", headers: authorizationHeaders(apiKey) },
      )
      await responseBody(response)
      log(`pruned: ${snapshot.name} (${snapshot.id})`)
      prunedCount += 1
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      failures.push({ snapshot, message })
      log(`failed: ${snapshot.name} (${snapshot.id}): ${message}`)
    }
  }

  const outOfScope = snapshots.length - selection.prune.length - selection.keep.length
  const summary = `summary: pruned=${prunedCount} kept=${selection.keep.length} out-of-scope=${outOfScope} failed=${failures.length}`
  log(summary)
  const result = { ...selection, failures, summary }

  if (failures.length > 0) {
    const error = new Error(`${failures.length} Daytona snapshot deletion(s) failed.`)
    error.result = result
    throw error
  }

  return result
}

// Compatibility alias for callers that predate the release channel.
export const pruneDaytonaDevSnapshots = pruneDaytonaSnapshots

function optionValue(args, index, option) {
  const value = args[index + 1]
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${option}.`)
  }
  return value
}

export const USAGE = `Prune old Daytona engine snapshots.

Usage:
  node scripts/prune-daytona-dev-snapshots.mjs [--api-url <url>] [--channel dev|release] [--name-base <base>] --keep <name> [--keep <name> ...] [--keep-count <n>] [--dry-run]

Options:
  --api-url <url>       Daytona API base URL (default: https://app.daytona.io/api).
  --channel <channel>   Snapshot family to prune: dev scopes to per-push
                        <base>-dev-* snapshots, release scopes to tagged
                        <base>-<version> snapshots (default: dev).
  --name-base <base>    Snapshot name base (default: openwork).
  --keep <name>         Snapshot name to protect; may be repeated.
  --keep-count <n>      Protect the newest n in-scope snapshots
                        (default: 5 for dev, 20 for release).
  --dry-run             Fetch and report without deleting snapshots.
  -h, --help            Show this help.

Environment:
  DAYTONA_API_KEY       Required (except with --help).`

export function parseArgs(args) {
  const options = {
    apiUrl: DEFAULT_API_URL,
    channel: "dev",
    nameBase: "openwork",
    keepNames: [],
    keepCount: undefined,
    dryRun: false,
    help: false,
  }

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === "--api-url") {
      options.apiUrl = optionValue(args, index, argument)
      index += 1
    } else if (argument === "--channel") {
      options.channel = validateChannel(optionValue(args, index, argument))
      index += 1
    } else if (argument === "--name-base") {
      options.nameBase = optionValue(args, index, argument)
      index += 1
    } else if (argument === "--keep") {
      options.keepNames.push(validateSnapshotName(optionValue(args, index, argument)))
      index += 1
    } else if (argument === "--keep-count") {
      const value = optionValue(args, index, argument)
      if (!/^\d+$/.test(value)) {
        throw new Error("--keep-count must be an integer greater than or equal to 0.")
      }
      options.keepCount = validateKeepCount(Number(value))
      index += 1
    } else if (argument === "--dry-run") {
      options.dryRun = true
    } else if (argument === "--help" || argument === "-h") {
      options.help = true
    } else {
      throw new Error(`Unknown argument: ${argument}`)
    }
  }

  if (options.help) {
    return options
  }
  if (options.keepNames.length === 0) {
    throw new Error("Missing snapshot name. Pass --keep <name>.")
  }

  return options
}

export async function main(args, environment = process.env) {
  const options = parseArgs(args)
  if (options.help) {
    console.log(USAGE)
    return { status: "help" }
  }

  return pruneDaytonaSnapshots({
    ...options,
    apiKey: environment.DAYTONA_API_KEY,
  })
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  main(process.argv.slice(2)).catch((error) => {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`Error: ${message}`)
    process.exitCode = 1
  })
}
