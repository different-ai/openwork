import { StrictMode, useState, type ReactNode } from "react"
import { createRoot } from "react-dom/client"
import { useApp, useHostStyles } from "@modelcontextprotocol/ext-apps/react"
import type { App } from "@modelcontextprotocol/ext-apps"
import type { z } from "zod"
import { StatusCard } from "./ui"

/**
 * Standard bootstrap for every first-party OpenWork MCP App: connect to the
 * host over the MCP Apps bridge, validate the tool's structuredContent
 * against the app's zod contract, and hand a typed payload to the view.
 */
export function mountMcpApp<Schema extends z.ZodType>(config: {
  name: string
  waitingLabel: string
  schema: Schema
  render: (payload: z.infer<Schema>, app: App | null) => ReactNode
}) {
  function AppRoot() {
    const [payload, setPayload] = useState<z.infer<Schema> | null>(null)
    const [resultError, setResultError] = useState<string | null>(null)
    const { app, error } = useApp({
      appInfo: { name: config.name, version: "1.0.0" },
      capabilities: {},
      onAppCreated: (createdApp) => {
        createdApp.ontoolresult = (result) => {
          const parsed = config.schema.safeParse(result.structuredContent)
          if (!parsed.success) {
            setResultError("The result did not match the expected data contract.")
            return
          }
          setResultError(null)
          setPayload(parsed.data)
        }
        createdApp.ontoolcancelled = ({ reason }) => {
          setResultError(reason ?? "The tool call was cancelled.")
        }
      },
    })
    useHostStyles(app, app?.getHostContext())

    if (error || resultError) {
      return <StatusCard>{error?.message ?? resultError}</StatusCard>
    }
    if (!payload) {
      return <StatusCard>{config.waitingLabel}</StatusCard>
    }
    return <>{config.render(payload, app)}</>
  }

  const root = document.getElementById("root")
  if (!root) throw new Error(`${config.name} root element is missing.`)
  createRoot(root).render(
    <StrictMode>
      <AppRoot />
    </StrictMode>,
  )
}
