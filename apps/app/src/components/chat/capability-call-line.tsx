"use client"

import { useState } from "react"
import type { DynamicToolUIPart } from "ai"
import { Ellipsis, ExternalLink, LoaderCircle, RefreshCcw } from "lucide-react"

import { describeChatToolFailure } from "@/components/tools/error-attribution"
import {
  useChatToolReconnect,
  type ChatToolReconnectCallbacks,
} from "@/components/tools/use-chat-tool-reconnect"
import { Button } from "@/components/ui/button"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { getCapabilityCallQuote, getCapabilityCallSentence } from "@/lib/capability-call"
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
function failureInstruction(part: DynamicToolUIPart, reconnectName: string | null): string {
  if (reconnectName) {
    return `${reconnectName} needs a fresh sign-in — reconnect it, then retry.`
  }
  const errorText = part.state === "output-error" ? part.errorText : null
  return describeChatToolFailure(errorText ?? "")
}

export function TechnicalDetailsPanel({ part, resultUnavailable = false }: { part: DynamicToolUIPart; resultUnavailable?: boolean }) {
  return (
    <div className="mt-2 flex flex-col gap-2 rounded-lg bg-muted p-2 text-xs">
      <div className="font-mono text-[11px] text-muted-foreground">
        {part.toolName} · {part.toolCallId}
      </div>
      {part.input !== undefined && part.input !== null ? (
        <pre className="max-h-40 overflow-auto whitespace-pre-wrap wrap-break-word">
          {formatTechnicalValue(part.input)}
        </pre>
      ) : null}
      {"output" in part && part.output !== undefined ? (
        <pre className="max-h-60 overflow-auto whitespace-pre-wrap wrap-break-word opacity-80">
          {formatTechnicalValue(part.output)}
        </pre>
      ) : null}
      {resultUnavailable ? (
        <p>The engine did not provide an individual result for this action. See the execution details.</p>
      ) : null}
      {part.state === "output-error" && part.errorText ? (
        <pre className="max-h-60 overflow-auto whitespace-pre-wrap wrap-break-word opacity-80">
          {part.errorText}
        </pre>
      ) : null}
    </div>
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
  resultUnavailable = false,
  statusUnknown = false,
  quietFailure = false,
  shimmer = false,
  onReconnect,
  onReopenAuthorization,
}: CapabilityCallLineProps) {
  const [open, setOpen] = useState(false)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const inFlight = !statusUnknown && isToolPartInFlight(part)
  const isFailed = part.state === "output-error"
  const duration = statusUnknown ? null : trackToolCallDuration(part)
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
    const label = sentence.failure ?? `Couldn't complete ${sentence.past.toLowerCase()}`
    return (
      <Collapsible data-capability-call={part.toolName} open={open} onOpenChange={setOpen} className={className}>
        <CollapsibleTrigger className="flex min-w-0 items-center gap-2 text-start text-sm text-muted-foreground hover:text-foreground" aria-label={`${label}. ${open ? "Hide" : "Show"} technical details`}>
          {connector ? <ConnectorMark connector={connector} /> : null}
          <span className="min-w-0 truncate">{label}</span>
          {duration ? <span className="shrink-0 text-xs tabular-nums text-muted-foreground/70">{duration}</span> : null}
        </CollapsibleTrigger>
        <CollapsibleContent><TechnicalDetailsPanel part={part} /></CollapsibleContent>
      </Collapsible>
    )
  }

  // Failures stay minimal until the user asks for more: one collapsed
  // line, expanding into the Paper "Failed Call Card" (quote, instruction
  // + Reconnect/Retry, technical details).
  if (isFailed) {
    const sentence = getCapabilityCallSentence(part, { includeQuery: false, connectionName: connector?.name })
    const failureLabel = sentence.failure ?? `${sentence.past} failed`
    const quote = sentence.failure ? null : getCapabilityCallQuote(part)
    const initial = sentence.service?.charAt(0).toUpperCase() ?? null
    return (
      <Collapsible
        data-capability-call={part.toolName}
        open={open}
        onOpenChange={setOpen}
        className={className}
      >
        <CollapsibleTrigger
          className="group flex min-w-0 max-w-full cursor-pointer items-center gap-2 text-start text-sm text-muted-foreground transition-colors hover:text-foreground"
          aria-label={open ? `${failureLabel}. Hide failure details` : `${failureLabel}. Show what to do next`}
        >
          {connector ? <ConnectorMark connector={connector} /> : null}
          <span className="min-w-0 truncate">{sentence.failure ?? sentence.past}</span>
          {!sentence.failure ? <span className="shrink-0 text-xs text-dls-secondary">failed</span> : null}
          {duration ? (
            <span className="shrink-0 text-xs tabular-nums text-muted-foreground/70">{duration}</span>
          ) : null}
        </CollapsibleTrigger>
        <CollapsibleContent className="h-(--collapsible-panel-height) overflow-hidden transition-[height] duration-150 ease-out data-starting-style:h-0 data-ending-style:h-0 [&[hidden]:not([hidden='until-found'])]:hidden">
          <div className="mt-2 flex flex-col gap-2 border-s border-border ps-3">
            <div className="flex min-w-0 items-center gap-2.5">
              {connector ? (
                <ConnectorMark connector={connector} />
              ) : initial ? (
                <span
                  aria-hidden="true"
                  className="flex size-6 shrink-0 items-center justify-center rounded-md bg-muted text-xs font-semibold text-foreground"
                >
                  {initial}
                </span>
              ) : null}
              <span className="min-w-0 truncate text-sm font-medium text-foreground">
                {sentence.failure ?? sentence.present}
              </span>
            </div>
            {quote ? (
              <div className="flex min-w-0 gap-2.5 ps-0.5">
                <span aria-hidden="true" className="w-0.5 shrink-0 rounded-full bg-border" />
                <p className="min-w-0 text-[13px] leading-5 text-muted-foreground">“{quote}”</p>
              </div>
            ) : null}
            <div className="flex min-w-0 items-center gap-2">
              <p className="min-w-0 text-sm leading-5 text-dls-secondary">
                {reconnectState === "connected" ? "The connection is restored. Check whether the action finished before retrying." : failureInstruction(part, reconnectAction?.connectionName ?? null)}
              </p>
              {reconnectAction && onReconnect ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  className="ms-auto shrink-0"
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
            </div>
            {reconnectError ? (
              <p className="text-xs text-dls-secondary" role="alert">{describeChatToolFailure(reconnectError)}</p>
            ) : null}
            <div>
              <Button variant="ghost" size="icon-xs" title="Technical details" aria-label="Technical details"
                onClick={() => setDetailsOpen(!detailsOpen)}
                aria-expanded={detailsOpen}
              >
                <Ellipsis aria-hidden="true" />
              </Button>
              {detailsOpen ? <TechnicalDetailsPanel part={part} /> : null}
            </div>
          </div>
        </CollapsibleContent>
      </Collapsible>
    )
  }

  const sentence = getCapabilityCallSentence(part, { connectionName: connector?.name })
  const line = statusUnknown ? `${sentence.present} — status unavailable` : inFlight ? sentence.present : sentence.past
  return (
    <Collapsible data-capability-call={part.toolName} open={open} onOpenChange={setOpen} className={className}>
      <div className="flex min-w-0 items-center gap-2">
        <CollapsibleTrigger
          className="group flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-start text-sm text-muted-foreground transition-colors hover:text-foreground"
          aria-label={open ? `${line}. Hide technical details` : `${line}. Show technical details`}
        >
          {connector ? (
            <ConnectorMark connector={connector} />
          ) : inFlight ? (
            <span className="flex size-3.5 shrink-0 items-center justify-center">
              <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin text-muted-foreground" />
            </span>
          ) : null}
          <span className={cn("min-w-0 truncate", shimmer && inFlight && "ow-text-shimmer motion-reduce:animate-none")}>{line}</span>
          {duration ? (
            <span className="shrink-0 text-xs tabular-nums text-muted-foreground/70">{duration}</span>
          ) : null}
        </CollapsibleTrigger>
      </div>
      <CollapsibleContent className="h-(--collapsible-panel-height) overflow-hidden transition-[height] duration-150 ease-out data-starting-style:h-0 data-ending-style:h-0 [&[hidden]:not([hidden='until-found'])]:hidden">
        <TechnicalDetailsPanel part={part} resultUnavailable={resultUnavailable} />
      </CollapsibleContent>
    </Collapsible>
  )
}
