import { timingSafeEqual } from "node:crypto"
import type { WorkbotServiceHealth } from "@openwork/types/den/service-health"
import type { Hono } from "hono"
import type { AppEnv } from "./auth.js"
import type { Config } from "./config.js"

/** Only a single HTTPS origin (or HTTP loopback), never credentials, paths or forwarded-header lists. */
function expectedOrigin(value: string) {
  if (!/^https?:\/\/[^/?#]+\/?$/i.test(value) || /[\s\\,@%]/u.test(value)) return null
  try {
    const url = new URL(value)
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null
    if (url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) return url.origin
  } catch {
    // Malformed input is a mismatch, never an error or a reflected value.
  }
  return null
}

/** Internal deployment facts only; no member auth, runner request or Den discovery is needed. */
export function registerReadinessRoute(app: Hono<AppEnv>, config: Pick<Config, "runner" | "denApiUrl">) {
  const expected = Buffer.from(config.runner.token)
  app.get("/internal/readiness", (c) => {
    c.header("Cache-Control", "no-store")
    const match = /^Bearer\s+(\S+)$/i.exec(c.req.header("authorization") ?? "")
    const actual = Buffer.from(match?.[1] ?? "")
    // Reuse the runner service token and Node's constant-time comparison; never accept an unset token.
    if (!match || expected.length === 0 || actual.length !== expected.length || !timingSafeEqual(actual, expected)) return c.json({ error: "unauthorized" }, 401)
    const rawOrigin = c.req.header("X-OpenWork-Den-Origin")
    const origin = rawOrigin === undefined ? null : expectedOrigin(rawOrigin)
    const body: WorkbotServiceHealth = {
      version: 1,
      service: "workbot",
      runnerConfigured: Boolean(config.runner.url && config.runner.token),
      denOriginMatches: rawOrigin === undefined ? null : origin !== null && origin === expectedOrigin(config.denApiUrl),
    }
    return c.json(body)
  })
}
