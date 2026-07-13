import { serve } from "@hono/node-server"
import app from "./app.js"
import { env } from "./env.js"
import { startScimMaintenanceLoop } from "./scim-maintenance.js"
import { startWorkerProvisioningReconcileLoop } from "./workers/reconciler.js"
import { startTelegramUpdateDispatcher } from "./capability-sources/telegram-dispatcher.js"
import { externalMcpClientRuntimeName } from "./capability-sources/external-mcp-client-runtime.js"

startScimMaintenanceLoop()
startWorkerProvisioningReconcileLoop()
startTelegramUpdateDispatcher()

console.log(`[den-api] External MCP implementation: ${externalMcpClientRuntimeName}`)

serve({ fetch: app.fetch, port: env.port }, (info) => {
  console.log(`den-api listening on ${info.port}`)
})
