"use client"

import { useState } from "react"
import type { DynamicToolUIPart } from "ai"
import type { ConnectionActionPayload } from "@openwork/types/connection-action-app"
import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { connectionCardPayloadFromChatToolResult, connectionResultFromChatToolPart, reconnectActionFromChatToolResult, type ChatToolReconnectAction } from "@/components/tools/error-attribution"
import { useChatToolReconnect, type ChatToolReconnectCallbacks } from "@/components/tools/use-chat-tool-reconnect"
import type { ConnectorToolIdentity } from "@/react-app/domains/connections/connector-tool-identity"
import { useOptionalMessageList } from "./message-list-provider"

const ACTION_OWNER = {
  member: "You",
  organization_admin: "Your organization admin",
  provider_admin: "The provider admin",
  network_admin: "Your network admin",
  openwork: "OpenWork support",
}

export function ConnectionCard({ part, callbacks, reconnectCallbacks, reconnectScope, connectorIdentities }: {
  callbacks?: ChatToolReconnectCallbacks
  part: DynamicToolUIPart
  action: ChatToolReconnectAction | null
  connection: ConnectionActionPayload | null
  reconnectCallbacks?: ChatToolReconnectCallbacks
  reconnectScope?: string
  connectorIdentities?: ConnectorToolIdentity[]
}) {
  const messageList = useOptionalMessageList()
  const result = connectionResultFromChatToolPart(part)
  const candidateAction = reconnectActionFromChatToolResult(part.toolName, result, part.input)
  const connection = connectionCardPayloadFromChatToolResult(part.toolName, result, part.input)
  const action = connection && (connection.actor !== "member" || (connection.action?.type !== "connect" && connection.action?.type !== "reconnect")) ? null : candidateAction
  const identity = connection ?? action
  const {
    reconnectState, reconnectError, reconnectBlocked, reconnectPresentation, decisionAvailable,
    responseSubmitted, handleReconnect, handleSkip, handleContinue, handleDismiss,
  } = useChatToolReconnect(part, reconnectCallbacks ?? {
    ...callbacks,
    onReconnect: callbacks?.onReconnect ?? messageList?.onMcpReconnect,
    onReopenAuthorization: callbacks?.onReopenAuthorization ?? messageList?.onMcpReopenAuthorization,
  }, action, reconnectScope, identity?.connectionId)
  const [failedIcon, setFailedIcon] = useState<string | null>(null)
  if (!identity) return null
  const icon = (connectorIdentities ?? messageList?.connectorIdentities ?? []).find(entry => entry.connectionId === identity.connectionId)?.iconUrl
  const skipped = reconnectState === "skipped"
  const connected = connection?.state === "connected" || reconnectState === "connected"
  const opening = reconnectState === "opening"
  const waiting = reconnectState === "authorization_opened"
  const status = skipped ? `Skipped ${identity.connectionName}` : connected ? `${identity.connectionName} connected`
    : action ? opening || waiting || reconnectState === "failed" ? reconnectPresentation?.badgeLabel : `Connect ${identity.connectionName}`
    : `${connection?.actor ? ACTION_OWNER[connection.actor] : "The connection owner"} must ${connection?.action?.type === "update_credentials" ? "update credentials for" : connection?.action?.type === "fix_network" ? "restore network access for" : connection?.action?.type === "fix_provider" ? "restore provider access for" : "configure"} ${identity.connectionName}`
  const readOnly = messageList?.readOnly ?? false

  return (
    <section data-testid="desktop-connection-card" aria-label={`${identity.connectionName} connection`} aria-live="polite"
      className="w-full max-w-full self-start px-3 py-3 text-sm text-foreground">
      <div className="flex min-h-10 min-w-0 flex-wrap items-center gap-3">
        <span aria-hidden="true" className={cn("flex size-7 shrink-0 items-center justify-center overflow-hidden rounded-md", !icon && "bg-muted text-xs font-medium")}>
          {icon && icon !== failedIcon ? <img src={icon} alt="" className="size-5 object-contain" onError={() => setFailedIcon(icon)} /> : identity.connectionName.charAt(0).toUpperCase()}
        </span>
        <p role={reconnectError ? "alert" : "status"} title={reconnectError ?? undefined} className="min-w-0 flex-1 font-medium">{status}</p>
        {!readOnly && decisionAvailable && (connected || skipped) ? <Button size="sm" disabled={responseSubmitted} onClick={() => void handleContinue()}>Continue</Button> : null}
        {!readOnly && !connected && !skipped ? (
          <div className="flex shrink-0 items-center gap-2">
            {action ? <>
              {decisionAvailable ? <Button variant="ghost" size="sm" disabled={responseSubmitted} onClick={() => void handleSkip()}>Skip</Button> : null}
              <Button variant={decisionAvailable ? "default" : "ghost"} size="sm" disabled={reconnectBlocked || opening} onClick={() => void handleReconnect()}>
                {opening ? <><Loader2 data-icon="inline-start" className="animate-spin" />Opening…</> : waiting ? "Open sign-in again" : decisionAvailable ? "Authenticate" : "Connect"}
              </Button>
            </> : <Button variant="ghost" size="sm" disabled={reconnectBlocked} onClick={() => decisionAvailable ? void handleSkip() : handleDismiss()}>Dismiss</Button>}
          </div>
        ) : null}
      </div>
    </section>
  )
}
