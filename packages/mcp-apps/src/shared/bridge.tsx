import { useState, type ReactNode } from "react"
import { createRoot } from "react-dom/client"
import { useApp, useHostStyles } from "@modelcontextprotocol/ext-apps/react"
import type { App, McpUiHostContext } from "@modelcontextprotocol/ext-apps"
import type { z } from "zod"
import { toolResultHandlers } from "./result"
import "./theme.css"

export type AppViewProps<Payload> = {
  payload: Payload
  app: App
  hostContext: McpUiHostContext | undefined
  hostError?: string | null
}

type AppConfig<Schema extends z.ZodType> = {
  name: string
  schema: Schema
  acceptError?: (payload: z.infer<Schema>) => boolean
  preserveState?: boolean
  render: (props: AppViewProps<z.infer<Schema>>) => ReactNode
}

export function McpApp<Schema extends z.ZodType>(config: AppConfig<Schema>) {
  const [received, setReceived] = useState<{ payload: z.infer<Schema>; revision: number } | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [hostContext, setHostContext] = useState<McpUiHostContext>()
  const { app, error } = useApp({
    appInfo: { name: config.name, version: "1.0.0" },
    capabilities: {},
    onAppCreated: created => {
      const handlers = toolResultHandlers(config.schema, payload => {
        setReceived(previous => ({ payload, revision: (previous?.revision ?? 0) + 1 }))
        setFailure(null)
      }, message => {
        if (!config.preserveState) setReceived(null)
        setFailure(message)
      }, config.acceptError)
      created.ontoolresult = handlers.ontoolresult
      created.ontoolcancelled = handlers.ontoolcancelled
      created.onerror = () => setFailure("The host connection failed. Reopen the App to continue.")
      created.onhostcontextchanged = change => setHostContext({ ...created.getHostContext(), ...change })
    },
  })
  const context = hostContext ?? app?.getHostContext()
  useHostStyles(app, context)
  const hostError = error ? "The host connection failed. Reopen the App to continue." : failure
  if (hostError && !(config.preserveState && received && app)) return <p role="status">{hostError}</p>
  if (!received || !app) return <div className="placeholder" role="status" aria-label="Waiting for result" />
  return <div key={config.preserveState ? "app" : received.revision}>{config.render({ payload: received.payload, app, hostContext: context, hostError })}</div>
}

export function mountMcpApp<Schema extends z.ZodType>(config: AppConfig<Schema>) {
  const root = document.getElementById("root")
  if (!root) throw new Error("MCP App root is missing")
  createRoot(root).render(<McpApp {...config} />)
}
