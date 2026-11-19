import { Hono } from "hono"
import { createAuth, type AppEnv } from "../src/server/auth.js"

/**
 * Test-only host for the account menu: Workbot's real /auth routes. Den's sign-in is replaced by a page that
 * records whether its workspace chooser was asked for; revoking always succeeds.
 */
export function accountMenuServer(input: { publicUrl: string }) {
  const revoked: string[] = []
  const chooserRequests: boolean[] = []
  const auth = createAuth({
    config: { publicUrl: input.publicUrl, secureCookies: false, sessionSecret: "s".repeat(32) },
    den: {
      authorizeUrl: async ({ chooseWorkspace }) => {
        chooserRequests.push(chooseWorkspace === true)
        return `${input.publicUrl}/fixture-den/authorize${chooseWorkspace ? "?prompt=consent" : ""}`
      },
      exchangeCode: async () => { throw new Error("not used") },
      session: async () => { throw new Error("not used") },
      refresh: async () => { throw new Error("not used") },
      revoke: async (token) => { revoked.push(token) },
    },
  })
  const app = new Hono<AppEnv>()
  auth.register(app)
  app.get("/fixture-den/authorize", (c) => c.html(`<!doctype html><title>OpenWork</title><h1>${c.req.query("prompt") === "consent" ? "Choose a workspace" : "Sign in to OpenWork"}</h1>`))
  return { app, revoked, chooserRequests }
}
