"use client"

import { useState } from "react"
import type { DynamicToolUIPart } from "ai"
import { ChevronRight, ExternalLink, LoaderCircle, Lock, RefreshCcw } from "lucide-react"

import { useCreatedSkills } from "@/components/chat/created-skill-card"
import { useOptionalMessageList } from "@/components/chat/message-list-provider"
import { describeChatToolFailure } from "@/components/tools/error-attribution"
import {
  useChatToolReconnect,
  type ChatToolReconnectCallbacks,
} from "@/components/tools/use-chat-tool-reconnect"
import { Button } from "@/components/ui/button"
import { getCapabilityCallSentence, type CapabilityCallSentence } from "@/lib/capability-call"
import {
  isOpenWorkSkillCall,
  savedSkillSentence,
  skillShareFailureReason,
  skillShareRequest,
  skillShareSentence,
} from "@/lib/created-skill"
import { OPENWORK_NATIVE_TOOL, openWorkNativeFailure, openWorkNativeSentence } from "@/lib/openwork-native-activity"
import { resolveExtensionIconSrc } from "@/react-app/design-system/extension-icon-src"
import { RAIL_LINE, RAIL_ROW, TextSentenceLine } from "./activity-rail"
import { TextTechnicalDetails } from "./text-activity-details"
import { splitSentence } from "@/lib/text-activity"
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
  /** Inside a group already named for this service: drop the repeated name. */
  groupService?: string | null
  /** Identical consecutive calls folded into this row. */
  repeat?: number
  shimmer?: boolean
}

/** OpenWork's own skill tools are first-party work: they carry the OpenWork mark. */
export const OPENWORK_IDENTITY: ConnectorToolIdentity = {
  id: "openwork",
  name: "OpenWork",
  iconUrl: resolveExtensionIconSrc("/openwork-sidebar-mark.svg"),
  serviceUrl: null,
  toolNamespace: null,
  connectionId: null,
}

const OPENWORK_MARK_SRC = resolveExtensionIconSrc("/openwork-sidebar-mark.svg")

/**
 * Is this identity OpenWork's own (our skills, or the Connect/Cloud server
 * reached as a connection)? Matched by id, by our mark asset, or by an
 * OpenWork host, since connection identities carry their own ids.
 */
export function isOpenWorkIdentity(connector: ConnectorToolIdentity): boolean {
  if (connector.id === OPENWORK_IDENTITY.id) return true
  const icon = connector.iconUrl ?? ""
  if (/\/openwork-(?:sidebar-)?mark\.svg(?:$|[?#])/.test(icon)) return true
  const host = (value: string | null | undefined) => {
    if (!value) return ""
    try { return new URL(value).hostname } catch { return "" }
  }
  return [host(connector.serviceUrl), host(connector.iconUrl)].some((name) => /(?:^|\.)openworklabs\.com$/.test(name))
}

/**
 * The OpenWork mark drawn in the current text colour (a mask, not an image),
 * so it reads on light and dark and dims with the sentence around it.
 */
export function OpenWorkMark({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      data-openwork-mark=""
      className={cn("inline-block shrink-0 bg-current", className)}
      style={{ maskImage: `url("${OPENWORK_MARK_SRC}")`, maskSize: "contain", maskRepeat: "no-repeat", maskPosition: "center", WebkitMaskImage: `url("${OPENWORK_MARK_SRC}")`, WebkitMaskSize: "contain", WebkitMaskRepeat: "no-repeat", WebkitMaskPosition: "center" }}
    />
  )
}

export function ConnectorMark({ connector }: { connector: ConnectorToolIdentity }) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null)
  // Text-first: the mark sits inline in the sentence at the text's size.

  const openwork = isOpenWorkIdentity(connector)
  const showImage = Boolean(connector.iconUrl && failedUrl !== connector.iconUrl)
  if (openwork) {
    return (
      <span data-connector-icon={connector.id} data-connector-name={connector.name} title={connector.name} aria-hidden="true" className="inline-flex size-3.5 shrink-0 items-center justify-center">
        {/* Full ink, not the sentence's muted tone: white on dark, ink on light. */}
        <OpenWorkMark className="size-3.5 text-foreground" />
      </span>
    )
  }
  return (
    <span
      data-connector-icon={connector.id}
      data-connector-name={connector.name}
      className={cn(
        "flex shrink-0 items-center justify-center overflow-hidden rounded-md",
        "size-3.5",
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
          className="size-3.5 object-contain"
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

/**
 * Results often nest JSON inside strings (an MCP resource's `text`, a tool's
 * stringified output). Parse those so details read as indented JSON, not as
 * one escaped line.
 */
function unwrapJson(value: unknown, depth = 0): unknown {
  if (depth > 4) return value
  if (typeof value === "string") {
    const trimmed = value.trim()
    if (!/^[[{]/.test(trimmed)) return value
    try {
      return unwrapJson(JSON.parse(trimmed), depth + 1)
    } catch {
      return value
    }
  }
  if (Array.isArray(value)) return value.map((entry) => unwrapJson(entry, depth + 1))
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, unwrapJson(entry, depth + 1)]))
  }
  return value
}

function formatTechnicalValue(value: unknown): string {
  const unwrapped = unwrapJson(value)
  if (typeof unwrapped === "string") return unwrapped
  try {
    return JSON.stringify(unwrapped, null, 2)
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
    return `${reconnectName} needs a fresh sign-in.`
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

  // Text-first: one quiet "Technical details" box (slate-2, inset hairline, small mono).
  const input = part.input !== undefined && part.input !== null && !(typeof part.input === "object" && Object.keys(part.input).length === 0)
  return (
    <div className="mt-1.5">
      <TextTechnicalDetails>
        <div className="flex flex-col gap-2">
          {part.state === "output-error" && part.errorText ? <p className="whitespace-pre-wrap wrap-break-word text-red-11">{part.errorText}</p> : null}
          {script ? <pre className="whitespace-pre font-mono">{script.code}</pre>
            : input ? <pre className="whitespace-pre-wrap wrap-break-word font-mono">{formatTechnicalValue(part.input)}</pre> : null}
          {"output" in part && part.output !== undefined ? <pre className="whitespace-pre-wrap wrap-break-word font-mono text-slate-9">{formatTechnicalValue(part.output)}</pre> : null}
        </div>
      </TextTechnicalDetails>
    </div>
  )
}

/**
 * Raw details stay one quiet click away: a chevron right after the row's
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
  // Text-first: a small chevron after the sentence instead of a code icon.
  return (
    <Button type="button" variant="ghost" size="icon-xs"
      className={cn("shrink-0 text-muted-foreground/70 transition-opacity duration-150 motion-reduce:transition-none",
        open || alwaysVisible ? "opacity-100" : "opacity-0 group-hover/step:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100")}
      aria-label={`${open ? "Hide" : "Show"} technical details for ${label}`} title="Technical details"
      aria-expanded={open} onClick={onToggle} data-testid="tool-details-toggle">
      <ChevronRight aria-hidden="true" className={cn("size-3 transition-transform duration-150 ease-out motion-reduce:transition-none", open && "rotate-90")} />
    </Button>
  )
}

/**
 * Capability calls stay sentence-first on one flat rail: the connector's
 * brand mark sits inline, and raw calls stay behind the details chevron.
 * Failures say what to do on a second line with an inline Reconnect; a
 * policy block is neutral with a lock (C5). IDs, schema digests and payloads
 * never show in the row.
 */
/**
 * OpenWork's own tools (app context, chats and groups, Cloud discovery and
 * API capabilities) carry the OpenWork mark. A capability that reaches
 * another service ("mcp:", "native:", "plugin:") is that service's, never ours.
 */
export function isOpenWorkActivity(part: DynamicToolUIPart): boolean {
  if (OPENWORK_NATIVE_TOOL.test(part.toolName)) return true
  if (!/^(?:openwork|openwork-cloud)_/.test(part.toolName)) return false
  const input = part.input
  const name = typeof input === "object" && input !== null && "name" in input && typeof input.name === "string" ? input.name : ""
  return !/^(?:mcp|native|plugin):/.test(name)
}

export function CapabilityCallLine({
  part,
  className,
  connector,

  statusUnknown = false,
  quietFailure = false,
  groupService = null,
  repeat = 1,
  shimmer = false,
  onReconnect,
  onReopenAuthorization,
}: CapabilityCallLineProps) {
  const [open, setOpen] = useState(false)

  const { shareLabels } = useCreatedSkills()
  const syncDegraded = useOptionalMessageList()?.syncDegraded === true
  const inFlight = !statusUnknown && isToolPartInFlight(part)
  const isFailed = part.state === "output-error"
  const { reconnectAction, reconnectState, reconnectError, reconnectPresentation, handleReconnect } =
    useChatToolReconnect(part, { onReconnect, onReopenAuthorization })
  const ReconnectIcon = reconnectState === "opening"
    ? LoaderCircle
    : reconnectState === "authorization_opened"
      ? ExternalLink
      : RefreshCcw

  // OpenWork's own skill steps name the skill and the person, from results.
  const shareRequest = skillShareRequest(part)
  const skillSentence = savedSkillSentence(part)
    ?? (shareRequest ? skillShareSentence(shareLabels.get(part.toolCallId) ?? null) : null)
  const mark = connector ?? (isOpenWorkSkillCall(part) || isOpenWorkActivity(part) ? OPENWORK_IDENTITY : null)
  const nativeSentence = openWorkNativeSentence(part)
  const sentenceFor = (includeQuery: boolean): CapabilityCallSentence => skillSentence
    ? { service: null, ...skillSentence }
    : nativeSentence ?? getCapabilityCallSentence(part, { includeQuery, connectionName: connector?.name })
  // OpenWork's own commands report a refusal in their result; that is a failure, not a success.
  const reportedFailure = openWorkNativeFailure(part)

  // A share whose answer never arrived: sharing is unverified, not done.
  if (shareRequest && isToolPartInFlight(part) && (statusUnknown || syncDegraded)) {
    return (
      <div data-capability-call={part.toolName} data-skill-share="unverified" className={cn(RAIL_ROW, className)}>
        <div className="flex min-h-6.5 min-w-0 items-center gap-2 text-xs text-muted-foreground">
          <span className="min-w-0 flex-1 truncate">Connection lost. Sharing status couldn't be verified.</span>
          <DetailsToggle open={open} onToggle={() => setOpen(!open)} label="Sharing status" />
        </div>
        {open ? <TechnicalDetailsPanel part={part} /> : null}
      </div>
    )
  }

  // Blocked by policy is not an error: neutral ink, a lock, and who can change it.
  if (shareRequest && skillShareFailureReason(part) === "blocked") {
    const label = "Sharing is blocked by your organization"
    return (
      <div data-capability-call={part.toolName} data-skill-share="blocked" className={cn(RAIL_ROW, className)}>
        <div className={RAIL_LINE}>
          <span className="min-w-0 flex-1 truncate">{label}</span>
          <Lock aria-label="Blocked by your organization" className="size-3.5 shrink-0" strokeWidth={1.5} />
          <DetailsToggle open={open} onToggle={() => setOpen(!open)} label={label} />
        </div>
        <p className="pb-1 text-xs text-muted-foreground">An organization admin can change who may share skills.</p>
        {open ? <TechnicalDetailsPanel part={part} /> : null}
      </div>
    )
  }

  // Inner script failures are frequent and often recovered. Keep their place
  // in the rail without turning a failed call into a prominent card.
  if (isFailed && quietFailure && !reconnectAction) {
    const sentence = sentenceFor(false)
    const label = sentence.failure ?? `${sentence.past} failed`
    return (
      <div data-capability-call={part.toolName} className={cn(RAIL_ROW, className)}>
        <div className={RAIL_LINE}>
          <TextSentenceLine {...splitSentence(label)} mark={mark ? <ConnectorMark connector={mark} /> : null} tone="failed" />
          <DetailsToggle open={open} onToggle={() => setOpen(!open)} label={label} alwaysVisible />
        </div>
        {open ? <TechnicalDetailsPanel part={part} /> : null}
      </div>
    )
  }

  // A failed call is one row like every other step: what failed, then the
  // fix on its own line with Reconnect when that is the fix, and the raw
  // call behind the details icon (always visible on a failure). Reconnecting
  // never repeats the call; the person or agent decides that afterwards.
  if (isFailed || reportedFailure) {
    const sentence = sentenceFor(false)
    const failureLabel = sentence.failure ?? `${sentence.past} failed`
    const reason = reconnectState === "connected"
      ? "Connection restored. Check whether the action finished before retrying."
      : reconnectAction ? failureInstruction(part, reconnectAction.connectionName)
        : shortError(part.state === "output-error" ? part.errorText : reportedFailure ?? undefined)
    return (
      <div data-capability-call={part.toolName} className={cn(RAIL_ROW, className)}>
        <div className="flex min-h-6.5 min-w-0 items-center gap-2 text-sm">
          <TextSentenceLine {...splitSentence(failureLabel)} mark={mark ? <ConnectorMark connector={mark} /> : null} tone="failed" />
          <DetailsToggle open={open} onToggle={() => setOpen(!open)} label={failureLabel} alwaysVisible />
        </div>
        {reason || (reconnectAction && onReconnect) ? (
          <div className="flex min-w-0 items-center gap-3 pb-1 text-xs text-muted-foreground">
            {reason ? <span className="min-w-0 truncate" title={reason}>{reason}</span> : null}
            {reconnectAction && onReconnect ? (
              <Button
                type="button"
                variant="link"
                size="xs"
                className="h-6 shrink-0 px-0 text-xs text-foreground underline underline-offset-3"
                data-testid="chat-mcp-reconnect-action"
                disabled={reconnectPresentation?.disabled}
                title={`${reconnectPresentation?.buttonLabel} ${reconnectAction.connectionName}`}
                aria-label={`${reconnectPresentation?.buttonLabel} ${reconnectAction.connectionName}`}
                onClick={() => void handleReconnect()}
              >
                {reconnectState === "opening" || reconnectState === "authorization_opened" ? (
                  <ReconnectIcon
                    data-icon="inline-start"
                    className={cn("size-3.5", reconnectState === "opening" && "animate-spin motion-reduce:animate-none")}
                    aria-hidden="true"
                  />
                ) : null}
                {reconnectPresentation?.buttonLabel}
              </Button>
            ) : null}
          </div>
        ) : null}
        {reconnectError ? (
          <p className="mt-1 text-xs text-dls-secondary" role="alert">{describeChatToolFailure(reconnectError)}</p>
        ) : null}
        {open ? <TechnicalDetailsPanel part={part} /> : null}
      </div>
    )
  }

  const sentence = sentenceFor(true)
  const withoutService = (text: string) => groupService
    ? text.replace(` · ${groupService}`, "").replace(new RegExp(`^(Search(?:ed|ing)) ${groupService.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} for`), "$1 for")
    : text
  const line = withoutService(statusUnknown ? `${sentence.present}, status unavailable` : inFlight ? sentence.present : sentence.past)
  return (
    <div data-capability-call={part.toolName} className={cn(RAIL_ROW, className)}>
      <div className={RAIL_LINE}>
        <TextSentenceLine {...splitSentence(line)} mark={mark ? <ConnectorMark connector={mark} /> : null} tone={shimmer && inFlight ? "running" : "normal"} />
        {repeat > 1 ? <span className="shrink-0 text-xs text-muted-foreground">{repeat} times</span> : null}
        <DetailsToggle open={open} onToggle={() => setOpen(!open)} label={line} />
      </div>
      {open ? <TechnicalDetailsPanel part={part} /> : null}
    </div>
  )
}
