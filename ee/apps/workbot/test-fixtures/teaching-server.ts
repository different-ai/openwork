import { Hono } from "hono"
import { createDen } from "../src/server/den.js"
import { registerWorkbotRoutes } from "../src/server/routes.js"
import { loadConfig } from "../src/server/config.js"
import type { AppEnv, Member } from "../src/server/auth.js"

/** Test-only host: real routes, Den membership, audit and skill storage; a deterministic runner. */
export async function teachingServer(input: { denUrl: string; publicUrl: string; runnerUrl: string; token: string }) {
  const config = loadConfig({ WORKBOT_PUBLIC_URL: input.publicUrl, WORKBOT_DEN_API_URL: input.denUrl, WORKBOT_RUNNER_URL: input.runnerUrl, WORKBOT_RUNNER_TOKEN: "r".repeat(32), WORKBOT_SESSION_SECRET: "s".repeat(32) })
  const den = createDen({ apiUrl: config.denApiUrl, publicUrl: config.publicUrl })
  const who = await den.session(input.token)
  const member: Member = { accessToken: input.token, den: { ...who, verifyModel: false, gatewayModels: false, sessionCells: false, stepTurns: false, model: null }, session: { id: "fixture", userId: who.user.id, organizationId: who.organization.id, createdAt: Date.now(), tokens: { accessToken: input.token, refreshToken: null, expiresAt: Date.now() + 3600_000 } } }
  const app = new Hono<AppEnv>()
  registerWorkbotRoutes(app, { config, den: { ...den, runToken: async () => ({ token: input.token }) },
    member: async (c, next) => { c.set("member", member); await next() },
    sameOrigin: async (c, next) => { if (c.req.method !== "GET" && c.req.header("origin") && c.req.header("origin") !== new URL(input.publicUrl).origin) return c.json({ error: "wrong_origin" }, 403); await next() },
  })
  return app
}
