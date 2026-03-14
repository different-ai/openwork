import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { setTimeout as delay } from "node:timers/promises"
import dotenv from "dotenv"
import { Daytona } from "@daytonaio/sdk"

const __dirname = dirname(fileURLToPath(import.meta.url))
const serviceDir = resolve(__dirname, "..")
const repoRoot = resolve(serviceDir, "..", "..")

function findUpwards(startDir, fileName, maxDepth = 8) {
  let current = startDir
  for (let depth = 0; depth <= maxDepth; depth += 1) {
    const candidate = join(current, fileName)
    if (existsSync(candidate)) {
      return candidate
    }
    const parent = dirname(current)
    if (parent === current) {
      break
    }
    current = parent
  }
  return null
}

const daytonaEnvPath = process.env.OPENWORK_DAYTONA_ENV_PATH?.trim() || findUpwards(repoRoot, ".env.daytona")
if (daytonaEnvPath) {
  dotenv.config({ path: daytonaEnvPath, override: false })
}

process.env.DATABASE_URL ||= "mysql://unused"
process.env.BETTER_AUTH_SECRET ||= "openwork-daytona-local-secret-000000000"
process.env.BETTER_AUTH_URL ||= "http://127.0.0.1"
process.env.CORS_ORIGINS ||= "http://127.0.0.1"
process.env.PROVISIONER_MODE ||= "daytona"

function log(message, detail) {
  if (detail === undefined) {
    console.log(message)
    return
  }
  console.log(message, detail)
}

function fail(message, detail) {
  if (detail !== undefined) {
    console.error(message, detail)
  } else {
    console.error(message)
  }
  process.exit(1)
}

async function waitForCleanup(daytona, workerId, attempts = 24) {
  for (let index = 0; index < attempts; index += 1) {
    const sandboxes = await daytona.list(
      {
        "openwork.den.provider": "daytona",
        "openwork.den.worker-id": workerId,
      },
      1,
      20,
    )
    if (sandboxes.items.length === 0) {
      return
    }
    await delay(5000)
  }
  throw new Error(`cleanup_timeout:${workerId}`)
}

async function main() {
  if (!process.env.DAYTONA_API_KEY) {
    fail("DAYTONA_API_KEY is required. Add it to .env.daytona or export it before running the smoke test.")
  }

  const { provisionWorker, deprovisionWorker } = await import("../dist/workers/provisioner.js")

  const workerId = randomUUID()
  const clientToken = randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", "")
  const hostToken = randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", "")

  const instance = await provisionWorker({
    workerId,
    name: "daytona-smoke",
    hostToken,
    clientToken,
  })

  log("Provisioned Daytona worker", instance)

  const workspacesResponse = await fetch(`${instance.url.replace(/\/$/, "")}/workspaces`, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${clientToken}`,
    },
  })

  const workspacesPayload = await workspacesResponse.text()
  if (!workspacesResponse.ok) {
    fail("Worker /workspaces check failed", {
      status: workspacesResponse.status,
      body: workspacesPayload,
    })
  }

  log("Worker /workspaces responded", workspacesPayload)

  await deprovisionWorker({
    workerId,
    instanceUrl: instance.url,
  })

  const daytona = new Daytona({
    apiKey: process.env.DAYTONA_API_KEY,
    apiUrl: process.env.DAYTONA_API_URL,
    ...(process.env.DAYTONA_TARGET ? { target: process.env.DAYTONA_TARGET } : {}),
  })

  await waitForCleanup(daytona, workerId)
  log("Daytona worker cleanup completed", workerId)
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error))
})
