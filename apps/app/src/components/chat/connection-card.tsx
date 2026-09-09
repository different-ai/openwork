"use client"

import { useState } from "react"
import type { DynamicToolUIPart } from "ai"
import type { ConnectionActionPayload } from "@openwork/types/connection-action-app"
import { ArrowUpRight, Check, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { ChatToolReconnectAction } from "@/components/tools/error-attribution"
import { useChatToolReconnect } from "@/components/tools/use-chat-tool-reconnect"
import { useMessageList } from "./message-list-provider"

const ACTION_OWNER = {
  member: "You",
  organization_admin: "Your organization admin",
  provider_admin: "The provider admin",
  network_admin: "Your network admin",
  openwork: "OpenWork support",
}

/** Uses the desktop's signed-in account; credentials never enter an MCP App. */
export function ConnectionCard({ part, action, connection }: {
  part: DynamicToolUIPart
  action: ChatToolReconnectAction | null
  connection: ConnectionActionPayload | null
}) {
  const { onMcpReconnect, onMcpReopenAuthorization, connectorIdentities } = useMessageList()
  const { reconnectState, reconnectError, handleReconnect } = useChatToolReconnect(part, {
    onReconnect: onMcpReconnect,
    onReopenAuthorization: onMcpReopenAuthorization,
  }, action ?? undefined)
  const [failedIcon, setFailedIcon] = useState<string | null>(null)
  const identity = connection ?? action
  if (!identity) return null
  const icon = connectorIdentities.find(entry => entry.connectionId === identity.connectionId)?.iconUrl
  const connected = connection?.state === "connected" || reconnectState === "connected"
  const opening = reconnectState === "opening"
  const waiting = reconnectState === "authorization_opened"
  const status = connected ? "Ready to use" : opening ? "Opening sign-in…" : waiting ? "Finish sign-in in your browser" : reconnectState === "failed" ? "Sign-in could not finish" : action ? "Sign in to continue" : connection?.message
  const label = reconnectState === "failed" ? "Try again" : waiting ? "Open sign-in" : action?.label

  return (
    <section data-testid="desktop-connection-card" aria-label={`${identity.connectionName} connection`} aria-live="polite"
      className="w-96 max-w-full self-start rounded-xl bg-muted/40 px-3 py-2.5 text-sm">
      <div className="flex min-h-10 min-w-0 items-center gap-2.5">
        <span aria-hidden="true" className={cn("flex size-7 shrink-0 items-center justify-center overflow-hidden rounded-md", !icon && "bg-muted text-xs font-medium")}>
          {icon && icon !== failedIcon ? <img src={icon} alt="" className="size-5 object-contain" onError={() => setFailedIcon(icon)} /> : identity.connectionName.charAt(0).toUpperCase()}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-medium" title={identity.connectionName}>{identity.connectionName}</p>
          <p className={cn("mt-0.5 text-[11px] text-muted-foreground", action && "truncate")} title={status}>{status}</p>
          {!action && !connected && connection?.action ? (
            <p className="mt-1 text-[11px] text-muted-foreground">
              {connection.actor ? `${ACTION_OWNER[connection.actor]}: ` : ""}{connection.action.label}
            </p>
          ) : null}
        </div>
        {connected ? (
          <span className="flex h-7 w-24 shrink-0 items-center justify-center gap-1 text-xs text-muted-foreground"><Check className="size-3.5 text-emerald-600 dark:text-emerald-400" />Connected</span>
        ) : action ? (
          <Button variant="ghost" size="sm" disabled={opening} onClick={() => void handleReconnect()} aria-label={`${label} ${identity.connectionName}`} className="h-7 w-24 shrink-0 gap-1 rounded-lg px-2 text-xs font-medium hover:bg-background/80">
            {opening ? <><Loader2 className="size-3.5 animate-spin" />Opening</> : <>{label}<ArrowUpRight className="size-3.5 text-muted-foreground" /></>}
          </Button>
        ) : null}
      </div>
      {reconnectError ? <p role="alert" className="mt-2 text-xs leading-relaxed text-destructive">{reconnectError}</p> : null}
    </section>
  )
}
