import { useState } from "react"
import type { App } from "@modelcontextprotocol/ext-apps"
import { z } from "zod"
import { connectionActionPayloadSchema, connectionActionToolName, type ConnectionActionPayload } from "@openwork/types/connection-action-app"
import { mountMcpApp } from "./shared/bridge"
import { AlertIcon, AppHeader, ArrowIcon, CardBody, CardFooter, CheckIcon, KeyValueGrid, PlugIcon, type Tone } from "./shared/ui"
import "./shared/theme.css"

const STATE_PRESENTATION: Record<ConnectionActionPayload["state"], {
  tone: Tone
  badge: string
  title: string
}> = {
  connected: { tone: "success", badge: "Connected", title: "Connection ready" },
  needs_connection: { tone: "warning", badge: "Not connected", title: "Connection needed" },
  reauth_required: { tone: "warning", badge: "Sign-in required", title: "Reconnect needed" },
  provider_error: { tone: "danger", badge: "Provider error", title: "Connection error" },
}

const ACTOR_LABEL: Record<NonNullable<ConnectionActionPayload["actor"]>, string> = {
  member: "You",
  organization_admin: "An organization admin",
  provider_admin: "The provider admin",
  network_admin: "A network admin",
  openwork: "OpenWork support",
}

const SURFACE_LABEL: Record<NonNullable<ConnectionActionPayload["action"]>["surface"], string> = {
  openwork_your_connections: "Your Connections",
  openwork_organization_connections: "Organization Connections",
  provider_admin_console: "Provider admin console",
  network_infrastructure: "Network infrastructure",
  openwork_support: "OpenWork support",
}

function ConnectionActionCard({ initialPayload, app }: { initialPayload: ConnectionActionPayload; app: App | null }) {
  const [payload, setPayload] = useState(initialPayload)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const checkConnection = async () => {
    if (!app || busy) return
    setBusy(true)
    setError(null)
    try {
      const result = await app.callServerTool({ name: connectionActionToolName, arguments: { connectionId: payload.connectionId } })
      const parsed = connectionActionPayloadSchema.safeParse(result.structuredContent)
      if (result.isError || !parsed.success || parsed.data.connectionId !== payload.connectionId) {
        throw new Error("Could not check this connection. Please try again.")
      }
      setPayload(parsed.data)
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not check this connection.")
    } finally {
      setBusy(false)
    }
  }
  const presentation = STATE_PRESENTATION[payload.state]
  const actionUrl = payload.action?.url
  const openAction = async () => {
    if (!actionUrl || !app) return
    setError(null)
    try {
      const result = await app.openLink({ url: actionUrl })
      if (result.isError) setError("Could not open sign-in. Please try again.")
    } catch {
      setError("Could not open sign-in. Please try again.")
    }
  }
  return (
    <main className="card" aria-live="polite" aria-busy={busy}>
      <AppHeader
        tone={presentation.tone}
        icon={payload.state === "connected" ? <CheckIcon /> : payload.state === "provider_error" ? <AlertIcon /> : <PlugIcon />}
        title={presentation.title}
        subtitle={payload.connectionName}
        badge={{ tone: presentation.tone, label: presentation.badge }}
      />
      <CardBody>
        <p className="name">{payload.connectionName}</p>
        <p className="description">{payload.message}</p>
        {payload.action ? (
          <KeyValueGrid
            items={[
              ...(payload.actor ? [{ label: "Who acts", value: ACTOR_LABEL[payload.actor] }] : []),
              { label: "Where", value: SURFACE_LABEL[payload.action.surface] },
            ]}
          />
        ) : null}
        {error ? <p role="alert" className="description">{error}</p> : null}
        {payload.state !== "connected" ? (
          <button className="action-primary" type="button" disabled={!app || busy} onClick={() => void checkConnection()}>
            {busy ? "Checking…" : "Check connection"}
          </button>
        ) : null}
      </CardBody>
      <CardFooter
        footnote={payload.state === "connected"
          ? "Tools from this connection are available in chat right now."
          : "Finish connecting, then check the connection here."}
        action={payload.action ? (
          actionUrl ? (
            <button className="action-primary" type="button" disabled={!app} onClick={() => void openAction()}>
              {payload.action.label} <ArrowIcon />
            </button>
          ) : (
            <span className="badge" data-tone={presentation.tone}>{payload.action.label}</span>
          )
        ) : undefined}
      />
    </main>
  )
}

mountMcpApp({
  name: "OpenWork Connection Action",
  waitingLabel: "Checking the connection...",
  schema: z.union([
    connectionActionPayloadSchema,
    z.object({ connectionAction: connectionActionPayloadSchema }).transform((result) => result.connectionAction),
  ]),
  render: (payload, app) => <ConnectionActionCard key={JSON.stringify(payload)} initialPayload={payload} app={app} />,
})
