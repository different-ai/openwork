import { spawn } from "node:child_process"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, "..")
const composeFile = path.join(rootDir, "packaging", "docker", "docker-compose.web-local.yml")
const composeProject = "openwork-den-local"

const apiPort = process.env.DEN_API_PORT?.trim() || process.env.DEN_CONTROLLER_PORT?.trim() || "8788"
const workerProxyPort = process.env.DEN_WORKER_PROXY_PORT?.trim() || "8789"
const webPort = process.env.DEN_WEB_PORT?.trim() || "3005"
const databaseUrl = process.env.DATABASE_URL?.trim() || "mysql://root:password@127.0.0.1:3306/openwork_den"
const dbEncryptionKey =
  process.env.DEN_DB_ENCRYPTION_KEY?.trim() ||
  "local-dev-db-encryption-key-please-change-1234567890"

function detectWebOrigins() {
  const origins = new Set([
    `http://localhost:${webPort}`,
    `http://127.0.0.1:${webPort}`,
    `http://0.0.0.0:${webPort}`,
  ])

  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (!entry || entry.internal || entry.family !== "IPv4") {
        continue
      }

      origins.add(`http://${entry.address}:${webPort}`)
    }
  }

  return Array.from(origins).join(",")
}

function parseDatabaseEndpoint(value) {
  const parsed = new URL(value)
  return {
    host: parsed.hostname,
    port: Number(parsed.port || "3306"),
  }
}

function canReachMysql(host, port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port })

    const finalize = (result) => {
      socket.destroy()
      resolve(result)
    }

    socket.setTimeout(1500)
    socket.once("connect", () => finalize(true))
    socket.once("error", () => finalize(false))
    socket.once("timeout", () => finalize(false))
  })
}

function canListenOnPort(port) {
  return new Promise((resolve) => {
    const server = net.createServer()

    const finalize = (result) => {
      server.close(() => resolve(result))
    }

    server.once("error", () => resolve(false))
    server.once("listening", () => finalize(true))
    server.listen(port, "0.0.0.0")
  })
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: rootDir,
      stdio: "inherit",
      ...options,
    })

    child.once("error", reject)
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve()
        return
      }

      const detail = signal ? `signal ${signal}` : `exit code ${code ?? 1}`
      reject(new Error(`${command} ${args.join(" ")} failed with ${detail}`))
    })
  })
}

let startedMysql = false
let turboChild = null
let cleaningUp = false

function stopTurboChild() {
  if (!turboChild || turboChild.exitCode !== null) {
    return Promise.resolve()
  }

  return new Promise((resolve) => {
    turboChild.once("exit", resolve)

    try {
      if (process.platform !== "win32") {
        process.kill(-turboChild.pid, "SIGINT")
      } else {
        turboChild.kill("SIGINT")
      }
    } catch {
      turboChild.kill("SIGINT")
    }
  })
}

async function cleanup(exitCode = 0) {
  if (cleaningUp) {
    return
  }

  cleaningUp = true

  await stopTurboChild()

  if (startedMysql) {
    await run("docker", ["compose", "-p", composeProject, "-f", composeFile, "down"], {
      stdio: "inherit",
    }).catch(() => {})
  }

  process.exit(exitCode)
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    void cleanup(0)
  })
}

async function main() {
  for (const [name, port] of [["den-web", webPort], ["den-api", apiPort], ["den-worker-proxy", workerProxyPort]]) {
    const available = await canListenOnPort(Number(port))
    if (!available) {
      throw new Error(`${name} local port ${port} is already in use. Stop the existing process or rerun with a different port env override.`)
    }
  }

  const { host, port } = parseDatabaseEndpoint(databaseUrl)
  const mysqlAvailable = await canReachMysql(host, port)

  if (!mysqlAvailable) {
    if (!(host === "127.0.0.1" || host === "localhost")) {
      throw new Error(`MySQL at ${host}:${port} is not reachable, and auto-start only supports localhost`) 
    }

    console.log(`[den] MySQL not reachable at ${host}:${port}; starting Docker MySQL...`)
    await run("docker", ["compose", "-p", composeProject, "-f", composeFile, "up", "-d", "--wait", "mysql"])
    startedMysql = true
  } else {
    console.log(`[den] Using existing MySQL at ${host}:${port}`)
  }

  console.log("[den] Syncing Den schema...")
  await run("bash", ["-lc", "pnpm --filter @openwork-ee/den-db build && pnpm --filter @openwork-ee/den-db exec node --import tsx ./node_modules/drizzle-kit/bin.cjs push --config drizzle.config.ts --force"], {
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
    },
  })

  const webOrigins = detectWebOrigins()
  console.log(`[den] Allowed local web origins: ${webOrigins}`)

  turboChild = spawn(
    "pnpm",
    [
      "exec",
      "turbo",
      "run",
      "dev:local",
      "--output-logs=full",
        "--filter=@openwork-ee/den-api",
        "--filter=@openwork-ee/den-worker-proxy",
        "--filter=@openwork-ee/den-web",
    ],
    {
      cwd: rootDir,
      stdio: "inherit",
      detached: process.platform !== "win32",
      env: {
        ...process.env,
        OPENWORK_DEV_MODE: process.env.OPENWORK_DEV_MODE?.trim() || "1",
        DATABASE_URL: databaseUrl,
        DEN_DB_ENCRYPTION_KEY: dbEncryptionKey,
        BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET?.trim() || "local-dev-secret-not-for-production-use!!",
        BETTER_AUTH_URL: process.env.BETTER_AUTH_URL?.trim() || `http://localhost:${webPort}`,
        DEN_BETTER_AUTH_TRUSTED_ORIGINS: process.env.DEN_BETTER_AUTH_TRUSTED_ORIGINS?.trim() || webOrigins,
        CORS_ORIGINS: process.env.CORS_ORIGINS?.trim() || webOrigins,
        DEN_API_PORT: apiPort,
        DEN_CONTROLLER_PORT: apiPort,
        DEN_WORKER_PROXY_PORT: workerProxyPort,
        DEN_WEB_PORT: webPort,
        DEN_API_BASE: process.env.DEN_API_BASE?.trim() || `http://127.0.0.1:${apiPort}`,
        DEN_AUTH_ORIGIN: process.env.DEN_AUTH_ORIGIN?.trim() || `http://localhost:${webPort}`,
        DEN_AUTH_FALLBACK_BASE: process.env.DEN_AUTH_FALLBACK_BASE?.trim() || `http://127.0.0.1:${apiPort}`,
        PROVISIONER_MODE: process.env.PROVISIONER_MODE?.trim() || "stub",
      },
    },
  )

  turboChild.once("exit", (code, signal) => {
    const exitCode = code ?? (signal ? 1 : 0)
    void cleanup(exitCode)
  })
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  void cleanup(1)
})
