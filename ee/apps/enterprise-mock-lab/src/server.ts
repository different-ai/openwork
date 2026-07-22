import { serve } from "@hono/node-server"
import { createEnterpriseMockLabApp } from "./app.js"
import { PackageBackedEnterpriseMockLab } from "./control-plane.js"
import { controlPlaneOrigin, parseEnterpriseMockLabEnv } from "./env.js"
import { SecurityService } from "./security.js"

const env = parseEnterpriseMockLabEnv(process.env)
const origin = controlPlaneOrigin(env)
const controlPlane = new PackageBackedEnterpriseMockLab({ reservedPorts: [env.ENTERPRISE_MOCK_LAB_PORT] })
const security = new SecurityService({
  adminSecret: env.ENTERPRISE_MOCK_LAB_ADMIN_SECRET,
  expectedOrigin: origin,
  sessionTtlSeconds: env.ENTERPRISE_MOCK_LAB_SESSION_TTL_SECONDS,
})
const app = createEnterpriseMockLabApp({ controlPlane, security })

const server = serve(
  {
    fetch: app.fetch,
    hostname: env.ENTERPRISE_MOCK_LAB_HOST,
    port: env.ENTERPRISE_MOCK_LAB_PORT,
  },
  () => {
    console.log(`[enterprise-mock-lab] control plane listening at ${origin}`)
    console.log("[enterprise-mock-lab] provider data planes use separate loopback listeners")
  },
)

let shuttingDown = false

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`[enterprise-mock-lab] received ${signal}; stopping mock instances`)
  for (const instance of controlPlane.list()) {
    try {
      await controlPlane.remove(instance.id)
    } catch (error) {
      console.error(`[enterprise-mock-lab] could not stop instance ${instance.id}`, {
        errorType: error instanceof Error ? error.name : typeof error,
      })
    }
  }
  server.close(() => process.exit(0))
}

process.once("SIGINT", () => void shutdown("SIGINT"))
process.once("SIGTERM", () => void shutdown("SIGTERM"))
