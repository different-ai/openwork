import { createServer } from "node:http"
import { Hono } from "hono"
import type { AppEnv } from "../src/server/auth.js"
import { loadConfig } from "../src/server/config.js"
import { createDen, denSessionSchema } from "../src/server/den.js"
import { registerWorkbotRoutes } from "../src/server/routes.js"

/** Fault envelopes observed at the shipped HTTP route/client/service boundary, not invented UI responses. */
export async function workbotActivityFaultResponses() {
  const requests: string[] = []
  const runner = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`)
    res.statusCode = 503
    res.setHeader("content-type", "application/json")
    res.end(JSON.stringify({ error: "runner_unavailable" }))
  })
  await new Promise<void>(resolve => runner.listen(0, "127.0.0.1", resolve))
  const address = runner.address()
  if (!address || typeof address === "string") throw new Error("No runner fixture address")
  try {
    const config = loadConfig({ WORKBOT_PUBLIC_URL: "http://localhost:3090", WORKBOT_DEN_API_URL: "http://localhost:3091", WORKBOT_RUNNER_URL: `http://127.0.0.1:${address.port}`, WORKBOT_RUNNER_TOKEN: "fixture-runner-token-not-a-real-secret", WORKBOT_SESSION_SECRET: "fixture-session-secret-not-a-real-secret" })
    const den = { ...createDen({ apiUrl: config.denApiUrl, publicUrl: config.publicUrl }), runToken: async () => "fixture-run-token", webUrl: async () => "https://example.test" }
    const app = new Hono<AppEnv>()
    const who = denSessionSchema.parse({ user: { id: "user_example", name: "Alex", email: "alex@example.test" }, organization: { id: "org_example", name: "Example", brandAppName: null }, memberId: "member_example", enabled: true, calendar: false, canSchedule: false, documents: false, workspaceAssistant: false })
    registerWorkbotRoutes(app, { config, den, sameOrigin: async (_c, next) => next(), member: async (c, next) => {
      c.set("member", { session: { id: "fixture-session", userId: who.user.id, organizationId: who.organization.id, tokens: { accessToken: "fixture-member-token", expiresAt: Date.now() + 60000 }, createdAt: Date.now() }, accessToken: "fixture-member-token", den: who })
      await next()
    } })
    const read = await app.request("http://localhost:3090/v1/workbot")
    const stop = await app.request("http://localhost:3090/v1/workbot/stop", { method: "POST" })
    const taskStop = await app.request("http://localhost:3090/v1/workbot/tasks/example.t1/stop", { method: "POST" })
    return {
      unavailable: { status: read.status, payload: await read.json() },
      stop: { status: stop.status, payload: await stop.json() },
      taskStop: { status: taskStop.status, payload: await taskStop.json() },
      runnerRequests: requests,
    }
  } finally {
    await new Promise<void>((resolve, reject) => runner.close(error => error ? reject(error) : resolve()))
  }
}
