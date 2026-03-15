import "dotenv/config"
import cors from "cors"
import express from "express"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { fromNodeHeaders, toNodeHandler } from "better-auth/node"
import { auth } from "./auth.js"
import { getLatestDevVerification } from "./email-verification.js"
import { env } from "./env.js"
import { adminRouter } from "./http/admin.js"
import { asyncRoute, errorMiddleware } from "./http/errors.js"
import { workersRouter } from "./http/workers.js"

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
  const session = await auth.api.getSession({
    headers: fromNodeHeaders(req.headers),
  })
  if (!session?.user?.id) {
    res.status(401).json({ error: "unauthorized" })
    return
  }
  res.json({
    user: {
      id: session.user.id,
      name: session.user.name,
      email: session.user.email,
      emailVerified: session.user.emailVerified,
      image: session.user.image,
      createdAt: session.user.createdAt,
      updatedAt: session.user.updatedAt,
    },
  })
}))

app.get("/v1/dev/email-verification", asyncRoute(async (req, res) => {
  if (!env.openworkDevMode) {
    res.status(404).json({ error: "not_found" })
    return
  }

  const email = typeof req.query.email === "string" ? req.query.email.trim().toLowerCase() : ""
  if (!email) {
    res.status(400).json({ error: "email_required" })
    return
  }

  const verification = getLatestDevVerification(email)
  if (!verification) {
    res.status(404).json({ error: "verification_not_found" })
    return
  }

  res.json(verification)
}))

app.use("/v1/admin", adminRouter)
app.use("/v1/workers", workersRouter)
app.use(errorMiddleware)

app.listen(env.port, () => {
  console.log(`den listening on ${env.port} (provisioner=${env.provisionerMode})`)
})
