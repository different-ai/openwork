import { useState } from "react"
import { z } from "zod"
import type { App } from "@modelcontextprotocol/ext-apps"
import { connectionActionIntentSchema, connectionActionPayloadSchema } from "@openwork/types/connection-action-app"
import type { AppViewProps } from "./shared/bridge"
import { callTool, openLink, safeLinkSchema } from "./shared/result"

export const connectionResultSchema = z.union([
  connectionActionPayloadSchema,
  z.object({ connectionAction: connectionActionPayloadSchema }).transform(value => value.connectionAction),
  z.object({ connectionStatus: connectionActionPayloadSchema }).transform(value => value.connectionStatus),
])
const outcomeSchema = connectionActionIntentSchema.extend({ outcome: z.enum(["connected", "skipped"]) })
const logos = new Map([
  ["slack", "slack"], ["notion", "notion"], ["github", "github"], ["linear", "linear"], ["gmail", "gmail"],
])

export async function requestConnectionAction(app: Pick<App, "callServerTool">, connectionId: string, action: "authenticate" | "skip") {
  const result = await callTool(app, "connection_action_intent", { connectionId, action })
  const parsed = outcomeSchema.safeParse(result.structuredContent)
  if (!parsed.success || parsed.data.action !== action || parsed.data.connection.connectionId !== connectionId
    || parsed.data.outcome !== (action === "authenticate" ? "connected" : "skipped")) {
    throw new Error("The connection action was not confirmed. Check connections before trying again.")
  }
  return parsed.data.outcome
}

export function ConnectionView({ payload, app, hostContext }: AppViewProps<z.infer<typeof connectionResultSchema>>) {
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState("")
  const [outcome, setOutcome] = useState<"connected" | "skipped" | "dismissed" | null>(null)
  const [logoFailed, setLogoFailed] = useState(false)
  const member = payload.actor === "member" && payload.action?.surface === "openwork_your_connections"
    && ((payload.state === "needs_connection" && payload.action.type === "connect")
      || (payload.state === "reauth_required" && payload.action.type === "reconnect"))
  const native = z.object({ "openwork/connection-actions": z.literal(true) }).safeParse(hostContext?.experimental).success
  const link = safeLinkSchema.safeParse(payload.action?.url)
  const connected = payload.state === "connected" || outcome === "connected"
  const finished = connected || outcome !== null
  const slug = logos.get(payload.connectionName.toLowerCase())

  async function act(action: "authenticate" | "skip") {
    if (busy || finished) return
    setBusy(true)
    setStatus("")
    try {
      if (!native || !member) {
        if (action === "skip") {
          setOutcome("dismissed")
        } else {
          if (!link.success) throw new Error(payload.message)
          await openLink(app, link.data)
          setStatus("Complete setup in connections, then check again.")
        }
        return
      }
      setOutcome(await requestConnectionAction(app, payload.connectionId, action))
    } catch (cause) {
      setStatus(cause instanceof Error ? cause.message : "The connection action did not complete.")
    } finally {
      setBusy(false)
    }
  }

  const title = connected ? `${payload.connectionName} connected`
    : outcome === "skipped" ? `Skipped ${payload.connectionName}`
      : outcome === "dismissed" ? `Dismissed ${payload.connectionName}`
        : member ? `Connect ${payload.connectionName} for account access` : `${payload.connectionName} needs setup`
  return <>
    <main className="connection" aria-busy={busy}>
      <span className="logo" aria-hidden="true">{slug && !logoFailed
        ? <img src={`https://cdn.simpleicons.org/${slug}`} alt="" onError={() => setLogoFailed(true)} />
        : payload.connectionName.charAt(0)}</span>
      <h1>{title}</h1>
      {!finished && <div className="actions">
        <button disabled={busy} onClick={() => void act("skip")}>Skip</button>
        <button className="primary" disabled={busy || (!(native && member) && !link.success)} onClick={() => void act("authenticate")}>
          {native && member ? "Authenticate" : "Open connections"}
        </button>
      </div>}
    </main>
    {!finished && <details>
      <summary>Access details</summary>
      {member && <>
        <p>Review the requested permissions on the provider’s sign-in screen.</p>
        <p>You can disconnect this connection in settings.</p>
      </>}
      {native && member && <p>Skip continues without connecting.</p>}
      {(!member || (!native && !link.success)) && <p>{payload.message}</p>}
    </details>}
    {status && <p className="status" role="status">{status}</p>}
  </>
}
