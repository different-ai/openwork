"use client"

import { useState } from "react"
import type { DynamicToolUIPart } from "ai"
import { Check, Loader2, Plug } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { ChatToolReconnectAction } from "@/components/tools/error-attribution"
import { useChatToolReconnect } from "@/components/tools/use-chat-tool-reconnect"
import { useMessageList } from "./message-list-provider"

/** Uses the desktop's signed-in account; credentials never enter an MCP App. */
export function ConnectionCard({ part, action }: { part: DynamicToolUIPart; action: ChatToolReconnectAction }) {
  const { onMcpReconnect, connectorIdentities } = useMessageList()
  const { reconnectState, reconnectError, handleReconnect } = useChatToolReconnect(part, { onReconnect: onMcpReconnect }, action)
  const [iconFailed, setIconFailed] = useState(false)
  const icon = connectorIdentities.find(entry => entry.connectionId === action.connectionId)?.iconUrl
  const connected = reconnectState === "connected"
  const pending = reconnectState === "opening" || reconnectState === "authorization_opened"
  return (
    <section data-testid="desktop-connection-card" aria-label={`${action.connectionName} connection`} aria-live="polite"
      className="flex items-center gap-3 rounded-2xl border border-border bg-background p-4">
      <div className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-border bg-muted/30">
        {icon && !iconFailed ? <img src={icon} alt="" className="size-5 object-contain" onError={() => setIconFailed(true)} /> : <Plug className="size-5 text-muted-foreground" />}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{action.connectionName}</p>
        <p className="text-xs text-muted-foreground">{connected ? "Connected" : pending ? "Finish signing in in your browser." : "Connect your account to use it in chat."}</p>
        {reconnectError ? <p role="alert" className="mt-1 text-xs text-destructive">{reconnectError}</p> : null}
      </div>
      {connected ? <Check className="size-4 shrink-0 text-emerald-600" aria-label="Connected" /> : (
        <Button size="sm" disabled={pending} onClick={() => void handleReconnect()} aria-label={`${reconnectState === "failed" ? "Try again" : action.label} ${action.connectionName}`}>
          {pending ? <><Loader2 className="size-3.5 animate-spin" /> Waiting…</> : reconnectState === "failed" ? "Try again" : action.label}
        </Button>
      )}
    </section>
  )
}
