import { randomUUID } from "node:crypto"
import { once } from "node:events"
import { existsSync } from "node:fs"
import net from "node:net"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { setTimeout as delay } from "node:timers/promises"
import { spawn } from "node:child_process"
import dotenv from "dotenv"
import mysql from "mysql2/promise"
import { Daytona } from "@daytonaio/sdk"

const __dirname = dirname(fileURLToPath(import.meta.url))
const serviceDir = resolve(__dirname, "..")
const repoRoot = resolve(serviceDir, "..", "..")

function log(message) {
  process.stdout.write(`${message}\n`)
}

function fail(message, detail) {
  if (detail !== undefined) {
    console.error(message, detail)
  } else {
    console.error(message)
  }
  process.exit(1)
}

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

function slug(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
}

function workerHint(workerId) {
  return workerId.replace(/-/g, "").slice(0, 12)
}

function sandboxLabels(workerId) {
  return {
    "openwork.den.provider": "daytona",
    "openwork.den.worker-id": workerId,
  }
}

function workspaceVolumeName(workerId) {
  const prefix = process.env.DAYTONA_VOLUME_NAME_PREFIX || "den-daytona-worker"
  return slug(`${prefix}-${workerHint(workerId)}-workspace`).slice(0, 63)
}

function dataVolumeName(workerId) {
  const prefix = process.env.DAYTONA_VOLUME_NAME_PREFIX || "den-daytona-worker"
  return slug(`${prefix}-${workerHint(workerId)}-data`).slice(0, 63)
}

async function getFreePort() {
  return await new Promise((resolvePort, reject) => {
    const server = net.createServer()
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (!address || typeof address === "string") {
        reject(new Error("failed_to_resolve_free_port"))
        return
      }
      server.close((error) => (error ? reject(error) : resolvePort(address.port)))
    })
    server.on("error", reject)
  })
}

function spawnCommand(command, args, options = {}) {
  return spawn(command, args, {
    cwd: serviceDir,
    env: process.env,
    stdio: "pipe",
    ...options,
  })
}

async function runCommand(command, args, options = {}) {
  const child = spawnCommand(command, args, options)
  let stdout = ""
  let stderr = ""
  child.stdout?.on("data", (chunk) => {
    stdout += chunk.toString()
  })
  child.stderr?.on("data", (chunk) => {
    stderr += chunk.toString()
  })
  const [code] = await once(child, "exit")
  if (code !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`)
  }
  return { stdout, stderr }
}

async function waitForMysqlConnection(databaseUrl, attempts = 60) {
  for (let index = 0; index < attempts; index += 1) {
    try {
      const connection = await mysql.createConnection(databaseUrl)
      await connection.query("SELECT 1")
      await connection.end()
      return
    } catch {
      await delay(1000)
    }
  }
  throw new Error("mysql_not_ready")
}

async function waitForHttp(url, attempts = 60, intervalMs = 500) {
  for (let index = 0; index < attempts; index += 1) {
    try {
      const response = await fetch(url)
      if (response.ok) {
        return response
      }
    } catch {
      // ignore until retries are exhausted
    }
    await delay(intervalMs)
  }
  throw new Error(`http_not_ready:${url}`)
}

async function waitForWorkerReady(baseUrl, workerId, auth, attempts = 180) {
  for (let index = 0; index < attempts; index += 1) {
    const result = await requestJson(baseUrl, `/v1/workers/${workerId}`, auth)
    if (result.response.ok && result.payload?.instance?.url && result.payload?.worker?.status === "healthy") {
      return result.payload
    }
    await delay(5000)
  }
  throw new Error(`worker_not_ready:${workerId}`)
}

async function waitForDaytonaCleanup(daytona, workerId, attempts = 60) {
  for (let index = 0; index < attempts; index += 1) {
    const sandboxes = await daytona.list(sandboxLabels(workerId), 1, 20)
    const volumes = await daytona.volume.list()
    const remainingVolumes = volumes.filter((volume) =>
      [workspaceVolumeName(workerId), dataVolumeName(workerId)].includes(volume.name),
    )

    if (sandboxes.items.length === 0 && remainingVolumes.length === 0) {
      return
    }

    await delay(5000)
  }

  throw new Error(`daytona_cleanup_incomplete:${workerId}`)
}

async function forceDeleteDaytonaResources(daytona, workerId) {
  const sandboxes = await daytona.list(sandboxLabels(workerId), 1, 20)
  for (const sandbox of sandboxes.items) {
    await sandbox.delete(120).catch(() => {})
  }

  const volumes = await daytona.volume.list()
  for (const volumeName of [workspaceVolumeName(workerId), dataVolumeName(workerId)]) {
    const volume = volumes.find((entry) => entry.name === volumeName)
    if (volume) {
      await daytona.volume.delete(volume).catch(() => {})
    }
  }
}

function extractAuthToken(payload) {
  if (!payload || typeof payload !== "object") {
    return null
  }
  if (typeof payload.token === "string" && payload.token.trim()) {
    return payload.token
  }
  if (payload.session && typeof payload.session === "object" && typeof payload.session.token === "string") {
    return payload.session.token
  }
  return null
}

async function requestJson(baseUrl, path, { method = "GET", body, token, cookie } = {}) {
  const headers = new Headers()
  const origin = process.env.DEN_BROWSER_ORIGIN?.trim() || new URL(baseUrl).origin
  headers.set("Accept", "application/json")
  headers.set("Origin", origin)
  headers.set("Referer", `${origin}/`)
  if (body !== undefined) {
    headers.set("Content-Type", "application/json")
  }
  if (token) {
    headers.set("Authorization", `Bearer ${token}`)
  }
  if (cookie) {
    headers.set("Cookie", cookie)
  }

  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })

  const text = await response.text()
  let payload = null
  if (text) {
    try {
      payload = JSON.parse(text)
    } catch {
      payload = text
    }
  }

  return {
    response,
    payload,
    cookie: response.headers.get("set-cookie"),
  }
}

async function main() {
  if (!process.env.DAYTONA_API_KEY) {
    fail("DAYTONA_API_KEY is required. Add it to .env.daytona or export it before running the test.")
  }

  const existingBaseUrl = process.env.DEN_BASE_URL?.trim() || process.env.DEN_API_URL?.trim() || ""
  const mysqlPort = existingBaseUrl ? null : await getFreePort()
  const appPort = existingBaseUrl ? null : await getFreePort()
  const containerName = existingBaseUrl
    ? null
    : `openwork-den-daytona-${randomUUID().slice(0, 8)}`
  const dbName = "openwork_den_daytona_e2e"
  const dbPassword = "openwork-root"
  const baseUrl = existingBaseUrl || `http://127.0.0.1:${appPort}`
  const databaseUrl = mysqlPort
    ? `mysql://root:${dbPassword}@127.0.0.1:${mysqlPort}/${dbName}`
    : null
  const runtimeEnv = {
    ...process.env,
    ...(databaseUrl ? { DATABASE_URL: databaseUrl } : {}),
    BETTER_AUTH_SECRET: "openwork-den-daytona-secret-0000000000",
    BETTER_AUTH_URL: baseUrl,
    ...(appPort ? { PORT: String(appPort) } : {}),
    CORS_ORIGINS: baseUrl,
    PROVISIONER_MODE: "daytona",
    POLAR_FEATURE_GATE_ENABLED: "false",
    OPENWORK_DAYTONA_ENV_PATH: daytonaEnvPath || process.env.OPENWORK_DAYTONA_ENV_PATH || "",
  }

  const daytona = new Daytona({
    apiKey: runtimeEnv.DAYTONA_API_KEY,
    apiUrl: runtimeEnv.DAYTONA_API_URL,
    ...(runtimeEnv.DAYTONA_TARGET ? { target: runtimeEnv.DAYTONA_TARGET } : {}),
  })

  let serviceProcess = null
  let workerId = null

  const cleanup = async () => {
    if (workerId) {
      try {
        await forceDeleteDaytonaResources(daytona, workerId)
      } catch {
        // cleanup best effort only
      }
    }

    if (serviceProcess && !serviceProcess.killed) {
      serviceProcess.kill("SIGINT")
      await once(serviceProcess, "exit").catch(() => {})
    }

    if (containerName) {
      await runCommand("docker", ["rm", "-f", containerName], { cwd: serviceDir }).catch(() => {})
    }
  }

  process.on("SIGINT", async () => {
    await cleanup()
    process.exit(130)
  })

  try {
    if (containerName && mysqlPort && databaseUrl && appPort) {
      log("Starting disposable MySQL container...")
      await runCommand("docker", [
        "run",
        "-d",
        "--rm",
        "--name",
        containerName,
        "-e",
        `MYSQL_ROOT_PASSWORD=${dbPassword}`,
        "-e",
        `MYSQL_DATABASE=${dbName}`,
        "-p",
        `${mysqlPort}:3306`,
        "mysql:8.4",
      ])

      log("Waiting for MySQL...")
      await waitForMysqlConnection(databaseUrl)

      log("Running Den migrations...")
      await runCommand("pnpm", ["db:migrate"], { cwd: serviceDir, env: runtimeEnv })

      log("Starting Den service with Daytona provisioner...")
      serviceProcess = spawn("pnpm", ["exec", "tsx", "src/index.ts"], {
        cwd: serviceDir,
        env: runtimeEnv,
        stdio: "pipe",
      })

      let serviceOutput = ""
      serviceProcess.stdout?.on("data", (chunk) => {
        serviceOutput += chunk.toString()
      })
      serviceProcess.stderr?.on("data", (chunk) => {
        serviceOutput += chunk.toString()
      })

      serviceProcess.on("exit", (code) => {
        if (code !== 0) {
          console.error(serviceOutput)
        }
      })
    } else {
      log(`Using existing Den API at ${baseUrl}`)
    }

    await waitForHttp(`${baseUrl}/health`)

    const email = `den-daytona-${Date.now()}@example.com`
    const password = "TestPass123!"

    log("Creating account...")
    const signup = await requestJson(baseUrl, "/api/auth/sign-up/email", {
      method: "POST",
      body: {
        name: "Den Daytona E2E",
        email,
        password,
      },
    })

    if (!signup.response.ok) {
      fail("Signup failed", signup.payload)
    }

    const token = extractAuthToken(signup.payload)
    const cookie = signup.cookie
    if (!token && !cookie) {
      fail("Signup did not return a bearer token or session cookie", signup.payload)
    }

    const auth = { token, cookie }

    log("Validating authenticated session...")
    const me = await requestJson(baseUrl, "/v1/me", auth)
    if (!me.response.ok) {
      fail("Session lookup failed", me.payload)
    }

    log("Creating Daytona-backed cloud worker...")
    const createWorker = await requestJson(baseUrl, "/v1/workers", {
      method: "POST",
      ...auth,
      body: {
        name: "daytona-worker",
        destination: "cloud",
      },
    })

    if (createWorker.response.status !== 202) {
      fail("Worker creation did not return async launch", {
        status: createWorker.response.status,
        payload: createWorker.payload,
      })
    }

    workerId = createWorker.payload?.worker?.id || null
    if (!workerId) {
      fail("Worker response did not include an id", createWorker.payload)
    }

    log("Waiting for worker provisioning to finish...")
    const workerPayload = await waitForWorkerReady(baseUrl, workerId, auth)
    if (workerPayload.instance.provider !== "daytona") {
      fail("Worker instance did not report the Daytona provider", workerPayload)
    }

    log("Checking worker health endpoint...")
    await waitForHttp(`${workerPayload.instance.url.replace(/\/$/, "")}/health`, 120, 5000)

    log("Checking OpenWork connect metadata...")
    const tokensResponse = await requestJson(baseUrl, `/v1/workers/${workerId}/tokens`, {
      method: "POST",
      ...auth,
    })
    if (!tokensResponse.response.ok || !tokensResponse.payload?.connect?.openworkUrl) {
      fail("Worker tokens/connect payload missing", tokensResponse.payload)
    }

    const clientToken = tokensResponse.payload.tokens?.client
    if (!clientToken) {
      fail("Client token missing from worker token payload", tokensResponse.payload)
    }

    const connectHeaders = {
      Accept: "application/json",
      Authorization: `Bearer ${clientToken}`,
    }
    const statusResponse = await fetch(`${tokensResponse.payload.connect.openworkUrl}/status`, {
      headers: connectHeaders,
    })
    if (!statusResponse.ok) {
      fail("Connected worker /status failed", await statusResponse.text())
    }

    const capabilitiesResponse = await fetch(`${tokensResponse.payload.connect.openworkUrl}/capabilities`, {
      headers: connectHeaders,
    })
    if (!capabilitiesResponse.ok) {
      fail("Connected worker /capabilities failed", await capabilitiesResponse.text())
    }

    log("Verifying Daytona resources exist...")
    const sandboxes = await daytona.list(sandboxLabels(workerId), 1, 20)
    if (sandboxes.items.length === 0) {
      fail("Expected a Daytona sandbox for the worker but none were found")
    }
    const volumes = await daytona.volume.list()
    const expectedVolumeNames = [workspaceVolumeName(workerId), dataVolumeName(workerId)]
    const missingVolumes = expectedVolumeNames.filter(
      (name) => !volumes.some((volume) => volume.name === name),
    )
    if (missingVolumes.length > 0) {
      fail("Expected Daytona volumes were not created", missingVolumes)
    }

    log("Deleting worker and waiting for Daytona cleanup...")
    const deleteResponse = await requestJson(baseUrl, `/v1/workers/${workerId}`, {
      method: "DELETE",
      ...auth,
    })
    if (deleteResponse.response.status !== 204) {
      fail("Worker deletion failed", {
        status: deleteResponse.response.status,
        payload: deleteResponse.payload,
      })
    }

    await waitForDaytonaCleanup(daytona, workerId)
    workerId = null

    log("Daytona worker flow passed.")
  } finally {
    await cleanup()
  }
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error))
})
