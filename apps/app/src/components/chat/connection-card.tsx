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
  const status = connected ? "Ready to use" : opening ? "Opening sign-in…" : waiting ? "Finish sign-in in your browser" : reconnectState === "failed" ? "Sign-in could not finish" : "Sign in to continue"
  const label = reconnectState === "failed" ? "Try again" : waiting ? "Open sign-in" : action.label

  return (
    <section data-testid="desktop-connection-card" aria-label={`${action.connectionName} connection`} aria-live="polite"
      className="w-96 max-w-full self-start rounded-xl bg-muted/40 px-3 py-2.5 text-sm">
      <div className="flex min-h-10 min-w-0 items-center gap-2.5">
        <span aria-hidden="true" className={cn("flex size-7 shrink-0 items-center justify-center overflow-hidden rounded-md", !icon && "bg-muted text-xs font-medium")}>
          {icon && icon !== failedIcon ? <img src={icon} alt="" className="size-5 object-contain" onError={() => setFailedIcon(icon)} /> : action.connectionName.charAt(0).toUpperCase()}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-medium" title={action.connectionName}>{action.connectionName}</p>
          <p className="mt-0.5 truncate text-[11px] text-muted-foreground" title={status}>{status}</p>
        </div>
        {connected ? (
          <span className="flex h-7 w-24 shrink-0 items-center justify-center gap-1 text-xs text-muted-foreground"><Check className="size-3.5 text-emerald-600 dark:text-emerald-400" />Connected</span>
        ) : (
          <Button variant="ghost" size="sm" disabled={opening} onClick={() => void handleReconnect()} aria-label={`${label} ${action.connectionName}`} className="h-7 w-24 shrink-0 gap-1 rounded-lg px-2 text-xs font-medium hover:bg-background/80">
            {opening ? <><Loader2 className="size-3.5 animate-spin" />Opening</> : <>{label}<ArrowUpRight className="size-3.5 text-muted-foreground" /></>}
          </Button>
        )}
      </div>
      {reconnectError ? <p role="alert" className="mt-2 text-xs leading-relaxed text-destructive">{reconnectError}</p> : null}
    </section>
  )
}
