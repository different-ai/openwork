import { spawn } from "node:child_process"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import { createServer } from "node:http"
import { mkdir } from "node:fs/promises"
import { basename } from "node:path"
import { Readable } from "node:stream"

const root = process.env.LABS_WORKSPACE_DIR || "/workspace/repo"
const state = process.env.LABS_STATE_DIR || "/persist/openwork"
const port = Number(process.env.LABS_SERVER_PORT || "8787")
const opencodePort = Number(process.env.LABS_OPENCODE_PORT || "4096")
const host = process.env.LABS_REMOTE_ACCESS === "0" ? "127.0.0.1" : "0.0.0.0"
const token = (process.env.LABS_OPENWORK_TOKEN || "").trim()
const workspaceId = process.env.LABS_WORKSPACE_ID || "default"
const opencodeBin = process.env.LABS_OPENCODE_BIN || "/usr/local/bin/opencode"
const xdgDataHome = `${state}/.local/share`
const xdgConfigHome = `${state}/.config`

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" })
  res.end(JSON.stringify(body))
}

function unauthorized(res) {
  json(res, 401, { ok: false, error: "Unauthorized" })
}

function allowed(req) {
  if (!token) return true
  const value = req.headers.authorization || ""
  return value === `Bearer ${token}`
}

async function proxy(req, res, base, prefix) {
  const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`)
  const next = url.pathname.slice(prefix.length) || "/"
  const target = new URL(`${next}${url.search}`, base)
  const headers = new Headers()
  for (const [key, value] of Object.entries(req.headers)) {
    if (!value) continue
    if (key === "host") continue
    if (key === "authorization") continue
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item)
      continue
    }
    headers.set(key, value)
  }

  const init = {
    method: req.method,
    headers,
    body: req.method === "GET" || req.method === "HEAD" ? undefined : req,
    duplex: req.method === "GET" || req.method === "HEAD" ? undefined : "half",
  }

  const upstream = await fetch(target, init)
  const out = {}
  upstream.headers.forEach((value, key) => {
    if (key === "content-encoding") return
    out[key] = value
  })
  res.writeHead(upstream.status, out)
  if (!upstream.body) {
    res.end()
    return
  }
  Readable.fromWeb(upstream.body).pipe(res)
}

async function startOpencode() {
  const proc = spawn(
    opencodeBin,
    ["serve", `--hostname=127.0.0.1`, `--port=${opencodePort}`],
    {
      cwd: root,
      env: {
        ...process.env,
        HOME: state,
        XDG_DATA_HOME: xdgDataHome,
        XDG_CONFIG_HOME: xdgConfigHome,
        OPENCODE_CONFIG_CONTENT: JSON.stringify({}),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  )

  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("Timed out waiting for opencode server"))
    }, 30_000)
    let output = ""

    const fail = (err) => {
      clearTimeout(timer)
      reject(err)
    }

    proc.stdout?.on("data", (chunk) => {
      output += chunk.toString()
      for (const line of output.split("\n")) {
        if (!line.startsWith("opencode server listening")) continue
        const match = line.match(/on\s+(https?:\/\/[^\s]+)/)
        if (!match) {
          fail(new Error(`Failed to parse opencode url from: ${line}`))
          return
        }
        clearTimeout(timer)
        resolve(match[1])
        return
      }
    })

    proc.stderr?.on("data", (chunk) => {
      output += chunk.toString()
    })

    proc.once("error", fail)
    proc.once("exit", (code) => {
      fail(new Error(`opencode exited with code ${code}\n${output}`))
    })
  })

  return {
    proc,
    url,
    client: createOpencodeClient({ baseUrl: url }),
    close() {
      proc.kill()
    },
  }
}

async function main() {
  process.chdir(root)
  process.env.HOME = state
  await mkdir(state, { recursive: true })

  const opencode = await startOpencode()

  const base = new URL(opencode.url)
  const proxyBase = `${base.origin}`
  const server = createServer(async (req, res) => {
    if (!allowed(req)) {
      unauthorized(res)
      return
    }

    const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`)

    if (url.pathname === "/health") {
      json(res, 200, {
        ok: true,
        type: "labs-openwork-server",
        workspace: {
          id: workspaceId,
          name: basename(root) || "Workspace",
          path: root,
        },
      })
      return
    }

    if (url.pathname === "/workspaces") {
      json(res, 200, {
        items: [
          {
            id: workspaceId,
            name: basename(root) || "Workspace",
            path: root,
          },
        ],
      })
      return
    }

    if (url.pathname === `/w/${workspaceId}/opencode` || url.pathname.startsWith(`/w/${workspaceId}/opencode/`)) {
      await proxy(req, res, proxyBase, `/w/${workspaceId}/opencode`)
      return
    }

    if (url.pathname === "/opencode" || url.pathname.startsWith("/opencode/")) {
      await proxy(req, res, proxyBase, "/opencode")
      return
    }

    json(res, 404, { ok: false, error: "Not found" })
  })

  const close = () => {
    server.close()
    opencode.close()
  }

  process.on("SIGINT", close)
  process.on("SIGTERM", close)

  server.listen(port, host, () => {
    console.log(`labs-openwork-server listening on http://${host}:${port}`)
  })
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
