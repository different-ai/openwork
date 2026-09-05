import { useCallback, useEffect, useRef, useState } from "react"
import type { App } from "@modelcontextprotocol/ext-apps"
import { z } from "zod"
import { connectionActionPayloadSchema, connectionActionToolName, type ConnectionActionPayload } from "@openwork/types/connection-action-app"
import { ConnectorMark } from "./shared/connector-mark"
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
  const [waiting, setWaiting] = useState(false)
  const [opening, setOpening] = useState(false)
  const inFlight = useRef(false)
  const checkConnection = useCallback(async () => {
    if (!app || inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setError(null)
    try {
      const result = await app.callServerTool({ name: connectionActionToolName, arguments: { connectionId: payload.connectionId } })
      const parsed = connectionActionPayloadSchema.safeParse(result.structuredContent)
      if (result.isError || !parsed.success || parsed.data.connectionId !== payload.connectionId) {
        throw new Error("Could not check this connection. Please try again.")
      }
      setPayload(parsed.data)
      if (parsed.data.state === "connected") setWaiting(false)
    } catch (error) {
      setWaiting(false)
      setError(error instanceof Error ? error.message : "Could not check this connection.")
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }, [app, payload.connectionId])
  useEffect(() => {
    if (!waiting) return
    const deadline = Date.now() + 120_000
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      if (Date.now() >= deadline) {
        setWaiting(false)
        setError("Still waiting for sign-in. You can check again whenever you’re ready.")
        return
      }
      await checkConnection()
      if (!cancelled) timer = setTimeout(() => void poll(), 3_000)
    }
    timer = setTimeout(() => void poll(), 3_000)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [waiting, checkConnection])
  const presentation = STATE_PRESENTATION[payload.state]
  const actionUrl = payload.action?.url
  const openAction = async () => {
    if (!actionUrl || !app || opening) return
    setOpening(true)
    setError(null)
    try {
      const result = await app.openLink({ url: actionUrl })
      if (result.isError) setError("Could not open sign-in. Please try again.")
      else setWaiting(true)
    } catch {
      setError("Could not open sign-in. Please try again.")
    } finally {
      setOpening(false)
    }
  }
  const memberSignIn = payload.actor === "member" && (payload.action?.type === "connect" || payload.action?.type === "reconnect")
  const connected = payload.state === "connected"
  return (
    <main className="card connection-guide" aria-live="polite" aria-busy={busy}>
      <AppHeader
        tone={presentation.tone}
        icon={payload.state === "connected" ? <CheckIcon /> : payload.state === "provider_error" ? <AlertIcon /> : <PlugIcon />}
        title={presentation.title}
        subtitle={payload.connectionName}
        badge={{ tone: presentation.tone, label: presentation.badge }}
      />
      <CardBody>
        <div className="connection-identity" aria-hidden="true">
          <span className="connection-logo"><ConnectorMark name={payload.connectionName} /></span>
          <span className="connection-link">···</span>
          <span className="connection-logo connection-openwork"><PlugIcon /></span>
        </div>
        <h2 className="connection-title">{connected ? `${payload.connectionName} is ready` : `${payload.state === "reauth_required" ? "Reconnect" : "Connect"} ${payload.connectionName}`}</h2>
        <p className="description">{payload.message}</p>
        {memberSignIn ? (
          <ol className="connection-steps" aria-label="Connection progress">
            <li data-active={!waiting}><span>1</span><div><strong>Continue to sign-in</strong><p>Open the guided setup for your account.</p></div></li>
            <li data-active={waiting}><span>2</span><div><strong>{waiting ? "Waiting for you to finish…" : "Review and authorize"}</strong><p>Choose your account and review access with the provider.</p></div></li>
            <li><span>3</span><div><strong>Continue in chat</strong><p>This card updates automatically when your connection is ready.</p></div></li>
          </ol>
        ) : payload.action ? (
          <KeyValueGrid
            items={[
              ...(payload.actor ? [{ label: "Who acts", value: ACTOR_LABEL[payload.actor] }] : []),
              { label: "Where", value: SURFACE_LABEL[payload.action.surface] },
            ]}
          />
        ) : null}
        {error ? <p role="alert" className="description">{error}</p> : null}
        {payload.state !== "connected" ? (
          <button className="action-primary action-secondary" type="button" disabled={!app || busy} onClick={() => void checkConnection()}>
            {busy ? "Checking…" : "Check connection"}
          </button>
        ) : null}
      </CardBody>
      <CardFooter
        footnote={payload.state === "connected"
          ? "Tools from this connection are available in chat right now."
          : waiting ? "Waiting for sign-in. You can return here at any time." : memberSignIn ? "Your provider handles sign-in. Keep this chat open." : "Complete the requested setup, then check the connection here."}
        action={payload.action ? (
          actionUrl ? (
            <button className="action-primary" type="button" disabled={!app || opening} onClick={() => void openAction()}>
              {opening ? "Opening…" : waiting ? "Open setup again" : payload.action.label} <ArrowIcon />
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
