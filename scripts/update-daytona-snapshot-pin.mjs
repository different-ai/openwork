import process from "node:process"
import { pathToFileURL } from "node:url"

const RENDER_API_BASE_URL = "https://api.render.com/v1"
const SNAPSHOT_ENV_VAR_KEY = "DAYTONA_SNAPSHOT"

function requiredValue(value, message) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(message)
  }

  return value.trim()
}

function validateSnapshotName(snapshotName) {
  const value = requiredValue(
    snapshotName,
    "Missing snapshot name. Pass --snapshot <name>.",
  )

  if (value !== snapshotName || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
    throw new Error(
      `Invalid snapshot name ${JSON.stringify(snapshotName)}. Use only letters, numbers, dots, underscores, and hyphens, with no whitespace.`,
    )
  }

  return value
}

function envVarUrl(envGroupId) {
  const id = requiredValue(
    envGroupId,
    "Missing env group id. Pass --env-group-id <id>.",
  )
  return `${RENDER_API_BASE_URL}/env-groups/${encodeURIComponent(id)}/env-vars/${SNAPSHOT_ENV_VAR_KEY}`
}

function authorizationHeaders(apiKey) {
  const key = requiredValue(
    apiKey,
    "Missing Render API key. Set RENDER_API_KEY before running this command.",
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
      `Render API request failed with HTTP ${response.status}${statusText}: ${body}`,
    )
  }
  return body
}

export function updateRequest(envGroupId, snapshotName) {
  const value = validateSnapshotName(snapshotName)
  return {
    method: "PUT",
    url: envVarUrl(envGroupId),
    body: JSON.stringify({ value }),
  }
}

export async function readDaytonaSnapshotPin({
  envGroupId,
  apiKey,
  fetchImpl = globalThis.fetch,
}) {
  const url = envVarUrl(envGroupId)
  const response = await fetchImpl(url, {
    method: "GET",
    headers: authorizationHeaders(apiKey),
  })
  const body = await responseBody(response)

  let parsed
  try {
    parsed = JSON.parse(body)
  } catch {
    throw new Error(`Render API returned invalid JSON for ${SNAPSHOT_ENV_VAR_KEY}: ${body}`)
  }

  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    typeof parsed.value !== "string"
  ) {
    throw new Error(
      `Render API response did not contain a string value for ${SNAPSHOT_ENV_VAR_KEY}: ${body}`,
    )
  }

  return parsed.value
}

export async function updateDaytonaSnapshotPin({
  envGroupId,
  snapshotName,
  apiKey,
  dryRun = false,
  fetchImpl = globalThis.fetch,
  log = console.log,
}) {
  const request = updateRequest(envGroupId, snapshotName)
  authorizationHeaders(apiKey)

  if (dryRun) {
    log("dry-run: no request sent")
    log(`method: ${request.method}`)
    log(`url: ${request.url}`)
    log(`body: ${request.body}`)
    return { status: "dry-run", snapshotName }
  }

  const current = await readDaytonaSnapshotPin({
    envGroupId,
    apiKey,
    fetchImpl,
  })
  if (current === snapshotName) {
    const message = `unchanged: ${SNAPSHOT_ENV_VAR_KEY} is already ${snapshotName}`
    log(message)
    return { status: "unchanged", current, snapshotName, message }
  }

  const response = await fetchImpl(request.url, {
    method: request.method,
    headers: {
      ...authorizationHeaders(apiKey),
      "Content-Type": "application/json",
    },
    body: request.body,
  })
  await responseBody(response)

  const message = `updated: ${SNAPSHOT_ENV_VAR_KEY} ${current} -> ${snapshotName}`
  log(message)
  return { status: "updated", current, snapshotName, message }
}

export async function compareDaytonaSnapshotPin({
  envGroupId,
  snapshotName,
  apiKey,
  fetchImpl = globalThis.fetch,
  log = console.log,
}) {
  const expected = validateSnapshotName(snapshotName)
  const current = await readDaytonaSnapshotPin({
    envGroupId,
    apiKey,
    fetchImpl,
  })

  if (current !== expected) {
    throw new Error(
      `Daytona snapshot drift: expected ${SNAPSHOT_ENV_VAR_KEY}=${expected}, found ${SNAPSHOT_ENV_VAR_KEY}=${current}`,
    )
  }

  const message = `agreement: ${SNAPSHOT_ENV_VAR_KEY}=${expected}`
  log(message)
  return { status: "agreement", current, snapshotName: expected, message }
}

function optionValue(args, index, option) {
  const value = args[index + 1]
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${option}.`)
  }
  return value
}

export const USAGE = `Update or check the Daytona sandbox snapshot pin (DAYTONA_SNAPSHOT) in a Render env group.

Usage:
  node scripts/update-daytona-snapshot-pin.mjs --env-group-id <id> --snapshot <name> [--dry-run]
  node scripts/update-daytona-snapshot-pin.mjs --env-group-id <id> --snapshot <name> --compare

Options:
  --env-group-id <id>  Render env group holding DAYTONA_SNAPSHOT (e.g. evg-...).
  --snapshot <name>    Desired snapshot name (e.g. openwork-0.18.11).
  --dry-run            Print the request that would be sent; write nothing.
  --compare            Read-only drift check; exits non-zero when the pin differs.
  -h, --help           Show this help.

Environment:
  RENDER_API_KEY       Required (except with --help).

This mutates which image every cloud sandbox boots. Prefer --dry-run or --compare first.`

export function parseArgs(args) {
  const options = {
    envGroupId: "",
    snapshotName: "",
    dryRun: false,
    compare: false,
    help: false,
  }

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === "--env-group-id") {
      options.envGroupId = optionValue(args, index, argument)
      index += 1
    } else if (argument === "--snapshot") {
      options.snapshotName = optionValue(args, index, argument)
      index += 1
    } else if (argument === "--dry-run") {
      options.dryRun = true
    } else if (argument === "--compare") {
      options.compare = true
    } else if (argument === "--help" || argument === "-h") {
      options.help = true
    } else {
      throw new Error(`Unknown argument: ${argument}`)
    }
  }

  if (options.help) {
    return options
  }

  if (options.dryRun && options.compare) {
    throw new Error("--dry-run and --compare cannot be used together.")
  }

  return options
}

export async function main(args, environment = process.env) {
  const options = parseArgs(args)
  if (options.help) {
    console.log(USAGE)
    return { status: "help" }
  }
  const input = {
    envGroupId: options.envGroupId,
    snapshotName: options.snapshotName,
    apiKey: environment.RENDER_API_KEY,
  }

  if (options.compare) {
    return compareDaytonaSnapshotPin(input)
  }

  return updateDaytonaSnapshotPin({ ...input, dryRun: options.dryRun })
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  main(process.argv.slice(2)).catch((error) => {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`Error: ${message}`)
    process.exitCode = 1
  })
}
