import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { auth } from "../../auth.js"
import { emptyResponse } from "../../openapi.js"
import type { AuthContextVariables } from "../../session.js"
import { registerDesktopAuthRoutes } from "./desktop-handoff.js"

export function registerAuthRoutes<T extends { Variables: AuthContextVariables }>(app: Hono<T>) {
  app.on(
    ["GET", "POST"],
    "/api/auth/*",
    describeRoute({
      hide: true,
      tags: ["Authentication"],
      summary: "Handle Better Auth flow",
      description: "Proxies Better Auth sign-in, sign-out, session, and verification flows under the Den API auth namespace.",
      responses: {
        200: emptyResponse("Better Auth handled the request successfully."),
        302: emptyResponse("Better Auth redirected the user to continue the auth flow."),
        400: emptyResponse("Better Auth rejected the request as invalid."),
        401: emptyResponse("Better Auth rejected the request because authentication failed."),
      },
    }),
    (c) => auth.handler(c.req.raw),
  )
  registerDesktopAuthRoutes(app)
}
