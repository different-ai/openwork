import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { expect } from "vitest"
import { eventually, localMysqlIsRunning, localRedisIsRunning, needs, server, test } from "@openwork/testkit"

// A real token-runtime HTTP surface and testkit-owned MySQL. Never start local
// infrastructure or send assertions to Google; the child injects a token witness.
const local = process.env.OPENWORK_EVAL_DAYTONA !== "1" && !process.env.OPENWORK_EVAL_DEN_API_URL
const mysql = await localMysqlIsRunning()
const redis = await localRedisIsRunning()
const title = !local ? "token lifecycle skipped - needs isolated local scratch placement"
  : !mysql ? "token lifecycle skipped - needs existing scratch MySQL on 127.0.0.1:3306"
  : !redis ? "token lifecycle skipped - needs existing Redis on 127.0.0.1:6379"
    : "token refresh fences concurrent revoke, client rotation, replacement, stale callers and access removal"

test.skipIf(!local || !mysql || !redis)(title, { timeout: 600_000 }, async ({ place }) => {
  needs({ placement: "local", commands: ["pnpm"] })
  await using den = await server({ place, web: false, org: { name: "Credential token lifecycle" } })
  const databaseUrl = den.database?.url
  if (!databaseUrl || !new URL(databaseUrl).pathname.startsWith("/openwork_eval_")) throw new Error("Testkit scratch DB required")
  const child = spawn("pnpm", ["exec", "tsx", "test/google-oauth-refresh-server.ts"], {
    cwd: `${fileURLToPath(new URL("../..", import.meta.url))}/ee/apps/gateway`,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, DATABASE_URL: databaseUrl, DB_MODE: "mysql",
      DEN_DB_ENCRYPTION_KEY: "local-dev-db-encryption-key-please-change-1234567890", OPENWORK_DEV_MODE: "1",
      NODE_OPTIONS: "--conditions=development", SENTRY_DSN: "", SENTRY_LOG_LEVEL: "off" },
    stdio: ["ignore", "pipe", "pipe"], detached: true,
  })
  let output = ""
  child.stdout.on("data", (chunk) => { output += String(chunk) })
  child.stderr.on("data", (chunk) => { output += String(chunk) })
  try {
    const url = await eventually(async () => {
      const url = /TOKEN_FIXTURE_URL=(http:\/\/127\.0\.0\.1:\d+)/.exec(output)?.[1]
      if (!url) throw new Error(`Token fixture not ready (exit=${child.exitCode})`)
      return url
    }, { within: 30_000 })
    const request = async (path: string, method = "POST"): Promise<Record<string, unknown>> => {
      const response = await fetch(`${url}${path}`, { method, signal: AbortSignal.timeout(10_000) })
      expect(response.status).toBe(200)
      const body: unknown = await response.json()
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Expected runtime response")
      return { ...body }
    }
    const state = () => request("/state", "GET")
    const waitForToken = () => eventually(async () => { expect(await state()).toMatchObject({ waiting: true }); return true }, { within: 5000, intervalMs: 20 })

    const first = request("/refresh")
    await waitForToken()
    const second = request("/refresh")
    await request("/release")
    expect(await first).toMatchObject({ kind: "refreshed" })
    expect(await second).toMatchObject({ kind: "refreshed" })
    expect(await request("/refresh")).toMatchObject({ kind: "refreshed" })
    expect(await state()).toMatchObject({ calls: 1, status: "active", locked: false, error: null, secret: '{"accessToken":"fresh","refreshToken":"rotated-refresh"}' })

    for (const response of ["success", "invalid_grant", "temporarily_unavailable"]) {
      for (const change of ["revoke", "client-rotation", "replace"]) {
        await request("/change/reset")
        await request(`/change/${response}`)
        const pending = request("/refresh")
        await waitForToken()
        // Bounded HTTP mutation completes before releasing Google: no DB locks
        // may be held while the refresher is waiting for its external response.
        await request(`/change/${change}`)
        const before = await state()
        await request("/release")
        expect(await pending).toMatchObject({ kind: change === "replace" ? "refreshed" : "auth_required" })
        const after = await state()
        expect(after).toMatchObject({ status: before.status, secret: before.secret, error: null, locked: false })
        expect(JSON.stringify(after)).not.toContain("SECRET_MARKER")
      }
    }
    await request("/change/reset")
    await request("/change/busy")
    expect(await request("/resolve")).toMatchObject({ kind: "retry", reason: "refresh_busy" })
    expect(await state()).toMatchObject({ status: "active" })
    await request("/change/reset")
    await request("/change/temporarily_unavailable")
    const outage = request("/resolve")
    await waitForToken()
    await request("/release")
    expect(await outage).toMatchObject({ kind: "retry", reason: "refresh_unavailable" })
    expect(await state()).toMatchObject({ status: "active", locked: false, error: "token_endpoint_unavailable" })
    await request("/change/reset")
    const accessRevoked = request("/resolve")
    await waitForToken()
    await request("/change/remove-access")
    await request("/release")
    expect(await accessRevoked).toMatchObject({ kind: "auth_required" })
    expect((await state()).secret).toBe('{"accessToken":"old","refreshToken":"old-refresh"}')
  } finally {
    if (child.pid) { try { process.kill(-child.pid, "SIGTERM") } catch { /* already stopped */ } }
  }
})
