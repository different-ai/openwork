"use client"

import { useState } from "react"
import type { DynamicToolUIPart } from "ai"
import { Braces, Check, Loader2, Lock } from "lucide-react"
import type { ConnectionActionPayload } from "@openwork/types/connection-action-app"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent } from "@/components/ui/collapsible"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { CLOUD_CODING_CONNECTION_ID } from "@openwork/types/den/cloud-coding"
import { CloudCodingConnectionCard } from "@/react-app/domains/cloud-coding/cloud-coding-connection-card"
import { useSessionExtensions } from "@/react-app/kernel/session-extensions"
import { ServiceMark, GITHUB_SERVICE_MARK } from "./service-mark"
import { connectionFromChatToolPart } from "@/components/tools/error-attribution"
import { useChatToolReconnect, type ChatToolReconnectCallbacks } from "@/components/tools/use-chat-tool-reconnect"
import type { ConnectorToolIdentity } from "@/react-app/domains/connections/connector-tool-identity"
import { useOptionalMessageList } from "./message-list-provider"

type ConnectionActionType = NonNullable<ConnectionActionPayload["action"]>["type"]

const ACTION_OWNER = {
  member: "You",
  organization_admin: "Your organization admin",
  provider_admin: "The provider admin",
  network_admin: "Your network admin",
  openwork: "OpenWork support",
}

const BLOCKED_VERB: Partial<Record<ConnectionActionType, string>> = {
  update_credentials: "update credentials for",
  fix_network: "restore network access for",
  fix_provider: "restore provider access for",
}

function blockedTitle(connection: ConnectionActionPayload): string {
  const owner = connection.actor ? ACTION_OWNER[connection.actor] : "The connection owner"
  const verb = (connection.action ? BLOCKED_VERB[connection.action.type] : undefined) ?? "configure"
  return `${owner} must ${verb} ${connection.connectionName}`
}


export function ConnectionCard({ part, callbacks, reconnectCallbacks, reconnectScope, connectorIdentities, allowDiscovery = false, subject }: {
  callbacks?: ChatToolReconnectCallbacks
  part: DynamicToolUIPart
  reconnectCallbacks?: ChatToolReconnectCallbacks
  reconnectScope?: string
  connectorIdentities?: ConnectorToolIdentity[]
  allowDiscovery?: boolean
  subject?: string
}) {
  const messageList = useOptionalMessageList()
  const { cloudCoding } = useSessionExtensions()
  const found = connectionFromChatToolPart(part, { allowDiscovery })
  const connection = found?.connection ?? null
  const isCloudCoding = connection?.connectionId === CLOUD_CODING_CONNECTION_ID
  const action = connection && (!isCloudCoding || cloudCoding?.scope) && connection.actor === "member" && (connection.action?.type === "connect" || connection.action?.type === "reconnect" || connection.action?.type === "update_credentials")
    ? found?.action ?? null
    : null
  const {
    reconnectState, reconnectError, reconnectBlocked, decisionAvailable,
    responseSubmitted, handleReconnect, handleSkip, handleContinue, handleDismiss,
  } = useChatToolReconnect(part, reconnectCallbacks ?? {
    ...callbacks,
    onReconnect: callbacks?.onReconnect ?? messageList?.onMcpReconnect,
    onReopenAuthorization: callbacks?.onReopenAuthorization ?? messageList?.onMcpReopenAuthorization,
  }, action, reconnectScope, connection?.connectionId)
  const [detailsOpen, setDetailsOpen] = useState(false)
  if (!connection || (isCloudCoding && (cloudCoding?.enabled === false || (!cloudCoding && connection.actor === "member")))) return null

  const name = connection.connectionName
  const identity = (connectorIdentities ?? messageList?.connectorIdentities ?? []).find(entry => entry.connectionId === connection.connectionId)
  const iconUrl = isCloudCoding ? GITHUB_SERVICE_MARK : identity?.iconUrl
  const readOnly = messageList?.readOnly ?? false
  const skipped = reconnectState === "skipped"
  const connected = connection.state === "connected" || reconnectState === "connected" || identity?.connectedForMe === true
  const settled = connected || skipped
  const opening = !settled && reconnectState === "opening"
  const waiting = !settled && reconnectState === "authorization_opened"
  const failed = !settled && reconnectState === "failed"
  const blocked = !settled && !action
  const verb = action?.label ?? "Connect"
  const again = connection.state === "reauth_required"
  const idleTitle = subject && action ? `Sign in to ${name}${again ? " again" : ""} to use ${subject}`
    : decisionAvailable ? `${verb} ${name} to continue` : `${verb} ${name}`
  const title = skipped ? `Skipped ${name}`
    : connected ? action?.credentialKind === "personal_key" ? `${name}: key saved` : `${name} connected`
    : blocked ? blockedTitle(connection)
    : opening ? action?.credentialKind === "personal_key" ? `${verb === "Replace key" ? "Replacing" : "Adding"} your key for ${name}…` : `Signing in to ${name}…`
    : waiting ? `Finish signing in to ${name} in your browser`
    : failed ? `${name} sign-in didn't finish`
    : action?.credentialKind === "personal_key" ? `${verb} for ${name}${decisionAvailable ? " to continue" : ""}`
    : idleTitle
  const signIn = subject && action?.credentialKind !== "personal_key"
  const primaryLabel = waiting ? "Open sign-in again" : failed ? "Try again" : decisionAvailable ? "Authenticate"
    : signIn ? again ? "Sign in again" : "Sign in" : verb
  const actionable = !readOnly && (!settled || decisionAvailable)
  const showDetails = actionable && Boolean(reconnectError)

  const card = (
    <section data-testid="desktop-connection-card" aria-label={`${name} connection`} aria-live="polite" className="w-full max-w-full self-start text-sm text-foreground">
      <div className="flex min-h-10 min-w-0 flex-wrap items-center gap-3 px-3 py-1">
        <ServiceMark name={name} iconUrl={iconUrl} />
        <p role={failed ? "alert" : "status"} className="flex min-w-0 flex-1 items-center gap-2 font-medium">
          {connected ? <Check aria-hidden="true" className="size-4 shrink-0 text-foreground" strokeWidth={1.5} /> : null}
          {blocked ? <Lock aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.5} /> : null}
          <span className="min-w-0">{title}</span>
          {waiting ? <Loader2 aria-hidden="true" className="size-4 shrink-0 animate-spin text-muted-foreground" strokeWidth={1.5} /> : null}
        </p>
        {actionable ? (
          <div className="flex shrink-0 items-center gap-1">
            {showDetails ? (
              <Tooltip>
                <TooltipTrigger render={(
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    className="text-muted-foreground"
                    aria-label={`Technical details for ${name}`}
                    aria-expanded={detailsOpen}
                    onClick={() => setDetailsOpen(open => !open)}
                  >
                    <Braces aria-hidden="true" className="size-4" strokeWidth={1.5} />
                  </Button>
                )} />
                <TooltipContent>Technical details</TooltipContent>
              </Tooltip>
            ) : null}
            {settled ? (
              <Button size="sm" disabled={responseSubmitted} onClick={() => void handleContinue()}>Continue</Button>
            ) : action ? (
              <>
                {decisionAvailable ? <Button variant="ghost" size="sm" disabled={responseSubmitted} onClick={() => void handleSkip()}>Skip</Button> : null}
                <Button variant={waiting ? "ghost" : "default"} size="sm" disabled={reconnectBlocked || opening} onClick={() => void handleReconnect()}>
                  {opening ? <Loader2 data-icon="inline-start" aria-hidden="true" className="animate-spin" strokeWidth={1.5} /> : null}
                  {primaryLabel}
                </Button>
              </>
            ) : (
              <Button variant="ghost" size="sm" disabled={reconnectBlocked} onClick={() => decisionAvailable ? void handleSkip() : handleDismiss()}>Dismiss</Button>
            )}
          </div>
        ) : null}
      </div>
      {showDetails ? (
        <Collapsible open={detailsOpen} onOpenChange={setDetailsOpen}>
          <CollapsibleContent className="px-3 pb-2">
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap wrap-break-word font-mono text-xs text-muted-foreground">{reconnectError}</pre>
          </CollapsibleContent>
        </Collapsible>
      ) : null}
    </section>
  )
  if (isCloudCoding && cloudCoding?.scope && actionable && blocked && connection.state === "needs_connection"
    && connection.actor === "organization_admin" && connection.action?.surface === "openwork_organization_connections") {
    const { scope } = cloudCoding
    return <CloudCodingConnectionCard key={JSON.stringify([scope.denBaseUrl, scope.organizationId, scope.principal])}
      scope={scope} fallback={card} dismiss={handleDismiss} />
  }
  return card
}
