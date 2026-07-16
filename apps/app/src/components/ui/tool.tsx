"use client"

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { Button } from "@/components/ui/button"
import {
  attributeChatToolError,
  reconnectActionFromChatToolResult,
  type ChatToolReconnectAction,
  type ChatToolReconnectProgress,
  type ChatToolReconnectResult,
  type ToolErrorAttribution,
} from "@/components/tools/error-attribution"
import {
  chatMcpReconnectKey,
  chatMcpReconnectPresentation,
  useChatMcpReconnectStore,
} from "@/components/tools/mcp-reconnect-state"
import { getToolActivityLabel, isToolPartInFlight } from "@/lib/tool-activity"
import { cn } from "@/lib/utils"
import {
  Bot,
  ChevronDown,
  CircleAlert,
  ExternalLink,
  FilePen,
  KeyRound,
  ListTodo,
  LoaderCircle,
  MessageCircleQuestion,
  RefreshCcw,
  Search,
  Sparkles,
  SquareCode,
  Wrench,
} from "lucide-react"
import type { DynamicToolUIPart, ToolUIPart } from "ai"

function toolIcon(part: ToolPart) {
  const name = part.type === "dynamic-tool" ? part.toolName : part.type
  switch (name) {
    case "edit":
    case "write":
    case "apply_patch":
      return FilePen
    case "grep":
    case "glob":
      return Search
    case "lsp":
      return SquareCode
    case "skill":
      return Sparkles
    case "todowrite":
      return ListTodo
    case "question":
      return MessageCircleQuestion
    case "request_env_var":
    case "env_var_request":
      return KeyRound
    case "task":
      return Bot
    default:
      return Wrench
  }
}

export type ToolPart = ToolUIPart | DynamicToolUIPart

export type ToolProps = {
  title?: string
  toolPart: ToolPart
  defaultOpen?: boolean
  className?: string
  onReconnect?: (
    action: ChatToolReconnectAction,
    onProgress: (progress: ChatToolReconnectProgress) => void,
  ) => Promise<ChatToolReconnectResult>
  onRetry?: (action: ChatToolReconnectAction) => void | Promise<void>
}

const formatValue = (value: unknown): string => {
  if (value === null) return "null"
  if (value === undefined) return "undefined"
  if (typeof value === "string") return value
  if (typeof value === "object") {
    return JSON.stringify(value, null, 2)
  }
  return String(value)
}

function isDiffText(value: unknown): value is string {
  return (
    typeof value === "string" &&
    (value.includes("@@") || value.includes("+++ ") || value.includes("--- "))
  )
}

/** Tools like apply_patch carry the diff in their input (patchText). */
function getInputDiff(input: unknown): string | null {
  if (isDiffText(input)) {
    return input
  }
  if (typeof input === "object" && input !== null && "patchText" in input) {
    const value = input.patchText
    if (isDiffText(value)) {
      return value
    }
  }
  return null
}

function diffLineClass(line: string) {
  if (line.startsWith("+")) return "text-green-11 bg-green-1/40"
  if (line.startsWith("-")) return "text-red-11 bg-red-1/40"
  if (line.startsWith("@@")) return "text-blue-11 bg-blue-1/30"
  return ""
}

function DiffLines({ diff }: { diff: string }) {
  return (
    <div className="max-h-60 overflow-auto rounded-md font-mono leading-relaxed">
      {diff.split("\n").map((line, index) => (
        <div
          key={`${index}:${line}`}
          className={cn(
            "whitespace-pre-wrap wrap-break-word px-1",
            diffLineClass(line)
          )}
        >
          {line || " "}
        </div>
      ))}
    </div>
  )
}

function reconnectAttribution(action: ChatToolReconnectAction, label: string): ToolErrorAttribution {
  return {
    label,
    confidence: "Confirmed",
    description: label === "Reconnected"
      ? `${action.connectionName} has a fresh authorization. Retry the request when ready.`
      : `${action.connectionName} rejected its saved authorization and needs to be reconnected.`,
  }
}

const Tool = ({ title, toolPart, defaultOpen = false, className, onReconnect, onRetry }: ToolProps) => {
  const { state, input } = toolPart
  const inFlight = isToolPartInFlight(toolPart)
  const isError = state === "output-error"
  const reconnectResult = isError && toolPart.errorText
    ? toolPart.errorText
    : state === "output-available" && "output" in toolPart
      ? toolPart.output
      : undefined
  const reconnectAction = toolPart.type === "dynamic-tool" && reconnectResult !== undefined
    ? reconnectActionFromChatToolResult(toolPart.toolName, reconnectResult)
    : null
  const reconnectKey = reconnectAction
    ? chatMcpReconnectKey(toolPart.toolCallId, reconnectAction.connectionId)
    : null
  const reconnectState = useChatMcpReconnectStore((store) => (
    reconnectKey ? store.records[reconnectKey]?.phase ?? "ready" : "ready"
  ))
  const reconnectError = useChatMcpReconnectStore((store) => (
    reconnectKey ? store.records[reconnectKey]?.error ?? null : null
  ))
  const setReconnectRecord = useChatMcpReconnectStore((store) => store.setRecord)
  const reconnectPresentation = reconnectAction
    ? chatMcpReconnectPresentation(reconnectAction, reconnectState)
    : null
  const errorAttribution = reconnectAction
    ? reconnectAttribution(reconnectAction, reconnectPresentation?.badgeLabel ?? "Reconnect required")
    : isError && toolPart.errorText
      ? attributeChatToolError(toolPart.errorText)
      : null
  const label = title ?? getToolActivityLabel(toolPart)
  const hasInput = input !== null && input !== undefined
  const hasOutput = "output" in toolPart && toolPart.output !== undefined
  const inputDiff = getInputDiff(input)
  const Icon = toolIcon(toolPart)
  const ReconnectIcon = reconnectState === "opening"
    ? LoaderCircle
    : reconnectState === "authorization_opened"
      ? ExternalLink
      : RefreshCcw

  const handleReconnect = async () => {
    if (!reconnectAction || !reconnectKey || !onReconnect) return
    if (reconnectState === "connected") {
      await onRetry?.(reconnectAction)
      return
    }
    if (reconnectState === "opening" || reconnectState === "authorization_opened") return
    setReconnectRecord(reconnectKey, { phase: "opening", error: null })
    try {
      const result = await onReconnect(reconnectAction, (progress) => {
        setReconnectRecord(reconnectKey, { phase: progress, error: null })
      })
      setReconnectRecord(reconnectKey, { phase: result, error: null })
    } catch (error) {
      setReconnectRecord(reconnectKey, {
        phase: "failed",
        error: error instanceof Error ? error.message : "Could not reconnect this account.",
      })
    }
  }

  return (
    <Collapsible className={className} defaultOpen={defaultOpen}>
      <div className="flex min-w-0 items-center gap-2" aria-live="polite">
        <CollapsibleTrigger
          className="group text-muted-foreground hover:text-foreground flex min-w-0 flex-1 cursor-pointer items-center justify-start gap-2 overflow-hidden text-start text-sm transition-colors"
        >
          <span className="relative inline-flex size-4 shrink-0 items-center justify-center">
            <span className="transition-opacity group-hover:opacity-0">
              {inFlight ? (
                <LoaderCircle className="size-4 animate-spin" />
              ) : isError ? (
                <CircleAlert className="text-destructive size-4" />
              ) : (
                <Icon className="size-3.5" />
              )}
            </span>
            <ChevronDown className="absolute size-4 opacity-0 transition-opacity group-hover:opacity-100 group-data-panel-open:rotate-180" />
          </span>
          <span className="min-w-0 truncate">{label}</span>
          {isError && !errorAttribution ? (
            <span className="text-destructive shrink-0 text-xs">failed</span>
          ) : null}
          {errorAttribution ? (
            <span
              className={cn(
                "shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] font-medium leading-none transition-colors",
                reconnectAction && reconnectState === "connected"
                  ? "border-green-7/30 bg-green-3/50 text-green-11"
                  : reconnectAction && reconnectState === "failed"
                    ? "border-destructive/30 bg-destructive/5 text-destructive"
                    : reconnectAction
                      ? "border-amber-7/30 bg-amber-3/50 text-amber-11"
                      : "border-border/70 text-muted-foreground",
              )}
              title={`${errorAttribution.confidence}: ${errorAttribution.description}`}
              aria-label={`Error attribution: ${errorAttribution.label}. ${errorAttribution.confidence}.`}
            >
              {errorAttribution.label}
            </span>
          ) : null}
        </CollapsibleTrigger>
        {reconnectAction && onReconnect ? (
          <Button
            type="button"
            variant="outline"
            size="xs"
            className={cn(
              "h-7 shrink-0 gap-1.5 rounded-lg px-2.5 font-semibold shadow-none before:shadow-none",
              reconnectState === "connected"
                ? "border-green-7/40 bg-green-3/60 text-green-11 hover:border-green-7/60 hover:bg-green-4/70"
                : reconnectState === "failed"
                  ? "border-destructive/30 bg-destructive/5 text-destructive hover:border-destructive/50 hover:bg-destructive/10"
                  : "border-amber-7/40 bg-amber-3/60 text-amber-11 hover:border-amber-7/60 hover:bg-amber-4/70",
            )}
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
        <p className="mt-1 text-xs text-destructive" role="alert">{reconnectError}</p>
      ) : null}
      <CollapsibleContent className="h-(--collapsible-panel-height) overflow-hidden text-sm transition-[height] duration-150 ease-out data-starting-style:h-0 data-ending-style:h-0 [&[hidden]:not([hidden='until-found'])]:hidden">
        <div className="bg-muted mt-2 flex flex-col gap-2 rounded-lg p-2 text-xs">
          {hasInput ? (
            inputDiff !== null ? (
              <DiffLines diff={inputDiff} />
            ) : (
              <pre className="whitespace-pre-wrap wrap-break-word">
                {formatValue(input)}
              </pre>
            )
          ) : null}
          {hasOutput ? (
            isDiffText(toolPart.output) ? (
              <DiffLines diff={toolPart.output} />
            ) : (
              <pre className="max-h-60 overflow-auto whitespace-pre-wrap wrap-break-word opacity-80">
                {formatValue(toolPart.output)}
              </pre>
            )
          ) : null}
          {isError && toolPart.errorText ? (
            <pre className="text-destructive whitespace-pre-wrap wrap-break-word">
              {toolPart.errorText}
            </pre>
          ) : null}
          {inFlight && !hasInput ? (
            <span className="text-muted-foreground">Waiting for input…</span>
          ) : null}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

export { Tool }
