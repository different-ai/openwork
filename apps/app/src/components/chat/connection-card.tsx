"use client"

import { useState } from "react"
import type { DynamicToolUIPart } from "ai"
import { ArrowUpRight, Check, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { ChatToolReconnectAction } from "@/components/tools/error-attribution"
import { useChatToolReconnect } from "@/components/tools/use-chat-tool-reconnect"
import { useMessageList } from "./message-list-provider"

/** Uses the desktop's signed-in account; credentials never enter an MCP App. */
export function ConnectionCard({ part, action }: { part: DynamicToolUIPart; action: ChatToolReconnectAction }) {
  const { onMcpReconnect, onMcpReopenAuthorization, connectorIdentities } = useMessageList()
  const { reconnectState, reconnectError, handleReconnect } = useChatToolReconnect(part, {
    onReconnect: onMcpReconnect,
    onReopenAuthorization: onMcpReopenAuthorization,
  }, action)
  const [failedIcon, setFailedIcon] = useState<string | null>(null)
  const icon = connectorIdentities.find(entry => entry.connectionId === action.connectionId)?.iconUrl
  const connected = reconnectState === "connected"
  const opening = reconnectState === "opening"
  const waiting = reconnectState === "authorization_opened"
  const label = reconnectState === "failed" ? "Try again" : waiting ? "Open sign-in" : action.label

  return (
    <section data-testid="desktop-connection-card" aria-label={`${action.connectionName} connection`} aria-live="polite"
      className={cn("self-start max-w-full text-sm", connected ? "py-1" : "w-80 rounded-xl bg-muted/40 px-3 py-2.5")}>
      <div className="flex min-w-0 items-center gap-2.5">
        <span aria-hidden="true" className={cn("flex shrink-0 items-center justify-center overflow-hidden rounded-md", connected ? "size-5" : "size-7", !icon && "bg-muted text-xs font-medium")}>
          {icon && icon !== failedIcon ? <img src={icon} alt="" className={connected ? "size-4 object-contain" : "size-5 object-contain"} onError={() => setFailedIcon(icon)} /> : action.connectionName.charAt(0).toUpperCase()}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-medium" title={action.connectionName}>{action.connectionName}</p>
          {waiting || opening ? <p className="mt-0.5 text-[11px] text-muted-foreground">{opening ? "Opening sign-in…" : "Finish sign-in in your browser"}</p> : null}
        </div>
        {connected ? (
          <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground"><Check className="size-3.5 text-emerald-600 dark:text-emerald-400" />Connected</span>
        ) : (
          <Button variant="ghost" size="sm" disabled={opening} onClick={() => void handleReconnect()} aria-label={`${label} ${action.connectionName}`} className="h-7 shrink-0 gap-1 rounded-lg px-2 text-xs font-medium hover:bg-background/80">
            {opening ? <Loader2 className="size-3.5 animate-spin" /> : <>{label}<ArrowUpRight className="size-3.5 text-muted-foreground" /></>}
          </Button>
        )}
      </div>
      {reconnectError ? <p role="alert" className="mt-2 text-xs leading-relaxed text-destructive">{reconnectError}</p> : null}
    </section>
  )
}
