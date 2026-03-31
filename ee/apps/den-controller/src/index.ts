import "./load-env.js"
import cors from "cors"
import express from "express"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { toNodeHandler } from "better-auth/node"
import { auth } from "./auth.js"
import { env } from "./env.js"
import { adminRouter } from "./http/admin.js"
import { desktopAuthRouter } from "./http/desktop-auth.js"
import { asyncRoute, errorMiddleware } from "./http/errors.js"
import { orgsRouter } from "./http/orgs.js"
import { getRequestSession } from "./http/session.js"
import { workersRouter } from "./http/workers.js"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { resolveUserOrganizationsForSession } from "./orgs.js"

const app = express()
const currentFile = fileURLToPath(import.meta.url)
const publicDir = path.resolve(path.dirname(currentFile), "../public")

if (env.corsOrigins.length > 0) {
  app.use(
    cors({
      origin: env.corsOrigins,
      credentials: true,
      methods: ["GET", "POST", "PATCH", "DELETE"],
    }),
  )
}

app.use(express.json())
app.all("/api/auth/*", toNodeHandler(auth))
app.use(express.static(publicDir))

app.get("/health", (_, res) => {
  res.json({ ok: true })
})

app.get("/v1/me", asyncRoute(async (req, res) => {
  const session = await getRequestSession(req)
  if (!session?.user?.id) {
    res.status(401).json({ error: "unauthorized" })
    return
  }
  res.json(session)
}))

app.get("/v1/me/orgs", asyncRoute(async (req, res) => {
  const session = await getRequestSession(req)
  if (!session?.user?.id) {
    res.status(401).json({ error: "unauthorized" })
    return
  }

  const resolved = await resolveUserOrganizationsForSession({
    sessionId: session.session?.id ? normalizeDenTypeId("session", session.session.id) : null,
    activeOrganizationId: session.session?.activeOrganizationId ?? null,
    userId: normalizeDenTypeId("user", session.user.id),
    email: session.user.email ?? `${session.user.id}@placeholder.local`,
    name: session.user.name,
  })

  res.json({
    orgs: resolved.orgs.map((org) => ({
      ...org,
      isActive: org.id === resolved.activeOrgId,
    })),
    activeOrgId: resolved.activeOrgId,
    activeOrgSlug: resolved.activeOrgSlug,
  })
}))

app.use("/v1/admin", adminRouter)
app.use("/v1/auth", desktopAuthRouter)
app.use("/v1/orgs", orgsRouter)
app.use("/v1/workers", workersRouter)
app.use(errorMiddleware)

app.listen(env.port, () => {
  console.log(`den listening on ${env.port} (provisioner=${env.provisionerMode})`)
})
