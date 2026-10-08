"use client"

import { useState } from "react"
import type { DynamicToolUIPart } from "ai"
import { CodeXml, ExternalLink, LoaderCircle, RefreshCcw } from "lucide-react"

import { describeChatToolFailure } from "@/components/tools/error-attribution"
import {
  useChatToolReconnect,
  type ChatToolReconnectCallbacks,
} from "@/components/tools/use-chat-tool-reconnect"
import { Button } from "@/components/ui/button"
import { getCapabilityCallSentence } from "@/lib/capability-call"
import { trackToolCallDuration } from "@/lib/tool-call-duration"
import { isToolPartInFlight } from "@/lib/tool-activity"
import { cn } from "@/lib/utils"
import type { ConnectorToolIdentity } from "@/react-app/domains/connections/connector-tool-identity"

type CapabilityCallLineProps = ChatToolReconnectCallbacks & {
  part: DynamicToolUIPart
  className?: string
  connector?: ConnectorToolIdentity | null
  resultUnavailable?: boolean
  statusUnknown?: boolean
  quietFailure?: boolean
  /** Calls inside a script have no recorded timing; don't invent one. */
  hideDuration?: boolean
  /** Inside a group already named for this service: drop the repeated name. */
  groupService?: string | null
  /** Identical consecutive calls folded into this row. */
  repeat?: number
  shimmer?: boolean
}

function ConnectorMark({ connector }: { connector: ConnectorToolIdentity }) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null)
  const showImage = Boolean(connector.iconUrl && failedUrl !== connector.iconUrl)
  return (
    <span
      data-connector-icon={connector.id}
      data-connector-name={connector.name}
      className={cn(
        "flex size-5 shrink-0 items-center justify-center overflow-hidden rounded-md",
        // The muted chip only exists to make the single-letter fallback read
        // as an avatar; real brand icons render without a background.
        !showImage && "bg-muted text-[10px] font-semibold text-foreground",
      )}
      title={connector.name}
      aria-hidden="true"
    >
      {showImage && connector.iconUrl ? (
        <img
          src={connector.iconUrl}
          alt=""
          className="size-4 object-contain"
          loading="lazy"
          decoding="async"
          onError={() => setFailedUrl(connector.iconUrl)}
        />
      ) : (
        connector.name.charAt(0).toUpperCase()
      )}
    </span>
  )
}

function formatTechnicalValue(value: unknown): string {
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

/** One human sentence explaining what to do about a failed call. */
/** First sentence of a raw tool error, short enough for the row. */
function shortError(text: string | undefined): string | null {
  const first = (text ?? "").replace(/\s+/g, " ").trim().split(/(?<=[.!?])\s/)[0] ?? ""
  if (!first) return null
  return first.length > 90 ? `${first.slice(0, 89)}…` : first
}

function failureInstruction(part: DynamicToolUIPart, reconnectName: string | null): string {
  if (reconnectName) {
    return `${reconnectName} needs a fresh sign-in. Reconnect it, then retry.`
  }
  const errorText = part.state === "output-error" ? part.errorText : null
  return describeChatToolFailure(errorText ?? "")
}

/** A script's source reads as code, not as an escaped JSON string. */
function scriptSource(input: unknown): { code: string } | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return null
  const code = Object.entries(input).find(([key]) => key === "code")?.[1]
  return typeof code === "string" ? { code: code.trim() } : null
}

export function TechnicalDetailsPanel({ part }: { part: DynamicToolUIPart }) {
  const script = scriptSource(part.input)
  return (
    <div className="mt-2 flex flex-col gap-2 rounded-lg bg-muted p-2 text-xs">
      {part.state === "output-error" && part.errorText ? (
        <p className="whitespace-pre-wrap wrap-break-word text-foreground">{part.errorText}</p>
      ) : null}
      {script ? (
        <pre className="max-h-60 overflow-auto whitespace-pre font-mono leading-5">{script.code}</pre>
      ) : part.input !== undefined && part.input !== null && !(typeof part.input === "object" && Object.keys(part.input).length === 0) ? (
        <pre className="max-h-40 overflow-auto whitespace-pre-wrap wrap-break-word">
          {formatTechnicalValue(part.input)}
        </pre>
      ) : null}
      {"output" in part && part.output !== undefined ? (
        <pre className="max-h-60 overflow-auto whitespace-pre-wrap wrap-break-word opacity-80">
          {formatTechnicalValue(part.output)}
        </pre>
      ) : null}
    </div>
  )
}


/**
 * Raw details stay one quiet click away: a code icon right after the row's
 * content that appears on hover or keyboard focus (always on touch, and
 * always for a failure, which is when people actually need it). Its slot is
 * reserved, so the row never shifts when it appears.
 */
export function DetailsToggle({ open, onToggle, label, alwaysVisible = false }: {
  open: boolean
  onToggle: () => void
  label: string
  alwaysVisible?: boolean
}) {
  return (
    <Button type="button" variant={open ? "secondary" : "ghost"} size="icon-xs"
      className={cn("shrink-0 text-muted-foreground transition-opacity duration-150 motion-reduce:transition-none",
        open || alwaysVisible ? "opacity-100" : "opacity-0 group-hover/step:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100")}
      aria-label={`${open ? "Hide" : "Show"} technical details for ${label}`} title="Technical details"
      aria-expanded={open} onClick={onToggle} data-testid="tool-details-toggle">
      <CodeXml aria-hidden="true" />
    </Button>
  )
}

/**
 * Capability calls stay sentence-first. Calls attributed to a connector add
 * that connector's first-class brand mark; unbranded calls keep the circular
 * spinner while running. IDs, schema digests, and raw payloads live
 * under a collapsed "Technical details" section.
 * Failures render the Paper "Failed Call Card": service avatar +
 * present-participle headline, the interpreted ask as a quote, one
 * instruction line saying what to do next with an inline
 * Reconnect/Retry action, and technical details collapsed below.
 */
export function CapabilityCallLine({
  part,
  className,
  connector,

  statusUnknown = false,
  quietFailure = false,
  hideDuration = false,
  groupService = null,
  repeat = 1,
  shimmer = false,
  onReconnect,
  onReopenAuthorization,
}: CapabilityCallLineProps) {
  const [open, setOpen] = useState(false)
  const inFlight = !statusUnknown && isToolPartInFlight(part)
  const isFailed = part.state === "output-error"
  const duration = statusUnknown || hideDuration ? null : trackToolCallDuration(part)
  const { reconnectAction, reconnectState, reconnectError, reconnectPresentation, handleReconnect } =
    useChatToolReconnect(part, { onReconnect, onReopenAuthorization })
  const ReconnectIcon = reconnectState === "opening"
    ? LoaderCircle
    : reconnectState === "authorization_opened"
      ? ExternalLink
      : RefreshCcw

  // Inner script failures are frequent and often recovered. Keep their place
  // in the rail without turning a failed call into a prominent card.
  if (isFailed && quietFailure && !reconnectAction) {
    const sentence = getCapabilityCallSentence(part, { includeQuery: false, connectionName: connector?.name })
    const label = sentence.failure ?? `${sentence.past} failed`
    return (
      <div data-capability-call={part.toolName} className={cn("group/step min-w-0", className)}>
        <div className="flex min-h-6 min-w-0 items-center gap-2 text-sm text-muted-foreground">
          {connector ? <ConnectorMark connector={connector} /> : null}
          <span className="min-w-0 truncate">{label}</span>
          {duration ? <span className="shrink-0 text-xs tabular-nums text-muted-foreground/70">{duration}</span> : null}
          <DetailsToggle open={open} onToggle={() => setOpen(!open)} label={label} alwaysVisible />
        </div>
        {open ? <TechnicalDetailsPanel part={part} /> : null}
      </div>
    )
  }

  // A failed call is one row like every other step: what failed, a short
  // reason or the fix on the same line, Reconnect when that is the fix, and
  // the raw call behind the details icon (always visible on a failure).
  if (isFailed) {
    const sentence = getCapabilityCallSentence(part, { includeQuery: false, connectionName: connector?.name })
    const failureLabel = sentence.failure ?? `${sentence.past} failed`
    const reason = reconnectState === "connected"
      ? "Connection restored. Check whether the action finished before retrying."
      : reconnectAction ? failureInstruction(part, reconnectAction.connectionName) : shortError(part.errorText)
    return (
      <div data-capability-call={part.toolName} className={cn("group/step min-w-0", className)}>
        <div className="flex min-h-6 min-w-0 items-center gap-2 text-sm text-muted-foreground">
          {connector ? <ConnectorMark connector={connector} /> : null}
          <span className="shrink-0">{failureLabel}</span>
          {reason ? <span className="min-w-0 truncate text-xs text-muted-foreground" title={reason}>{reason}</span> : null}
          {duration ? <span className="shrink-0 text-xs tabular-nums text-muted-foreground/70">{duration}</span> : null}
          {reconnectAction && onReconnect ? (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className="shrink-0"
              data-testid="chat-mcp-reconnect-action"
              disabled={reconnectPresentation?.disabled}
              title={`${reconnectPresentation?.buttonLabel} ${reconnectAction.connectionName}`}
              aria-label={`${reconnectPresentation?.buttonLabel} ${reconnectAction.connectionName}`}
              onClick={() => void handleReconnect()}
            >
              <ReconnectIcon
                data-icon="inline-start"
                className={cn("size-3.5", reconnectState === "opening" && "animate-spin")}
                aria-hidden="true"
              />
              {reconnectPresentation?.buttonLabel}
            </Button>
          ) : null}
          <DetailsToggle open={open} onToggle={() => setOpen(!open)} label={failureLabel} alwaysVisible />
        </div>
        {reconnectError ? (
          <p className="mt-1 text-xs text-dls-secondary" role="alert">{describeChatToolFailure(reconnectError)}</p>
        ) : null}
        {open ? <TechnicalDetailsPanel part={part} /> : null}
      </div>
    )
  }

  const sentence = getCapabilityCallSentence(part, { connectionName: connector?.name })
  const withoutService = (text: string) => groupService
    ? text.replace(` · ${groupService}`, "").replace(new RegExp(`^(Search(?:ed|ing)) ${groupService.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} for`), "$1 for")
    : text
  const line = withoutService(statusUnknown ? `${sentence.present}, status unavailable` : inFlight ? sentence.present : sentence.past)
  return (
    <div data-capability-call={part.toolName} className={cn("group/step min-w-0", className)}>
      <div className="flex min-h-6 min-w-0 items-center gap-2 text-sm text-muted-foreground">
        {connector ? (
          <ConnectorMark connector={connector} />
        ) : inFlight ? (
          <span className="flex size-3.5 shrink-0 items-center justify-center">
            {shimmer ? <span aria-hidden="true" className="size-1 rounded-full bg-muted-foreground" />
              : <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin text-muted-foreground" />}
          </span>
        ) : null}
        <span className={cn("min-w-0 truncate", shimmer && inFlight && "ow-text-shimmer motion-reduce:animate-none")}>{line}</span>
        {repeat > 1 ? <span className="shrink-0 text-xs text-muted-foreground">{repeat} times</span> : null}
        {duration ? (
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground/70">{duration}</span>
        ) : null}
        <DetailsToggle open={open} onToggle={() => setOpen(!open)} label={line} />
      </div>
      {open ? <TechnicalDetailsPanel part={part} /> : null}
    </div>
  )
}
