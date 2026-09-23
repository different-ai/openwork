"use memo";

import * as React from "react"
import {
  AlertTriangle,
  Check,
  ChevronRight,
  CirclePause,
  Copy,
  Download,
  FileIcon,
  FolderOpen,
  LoaderCircle,
  MoreHorizontal,
  Pencil,
  Split,
  Undo2,
  WifiOff,
} from "lucide-react"
import {
  DynamicToolUIPart,
  isFileUIPart,
  ToolUIPart,
  type FileUIPart,
  type UIMessage,
} from "ai"
import type { SessionStatus } from "@opencode-ai/sdk/v2/client"
import { openDesktopUrl, revealDesktopItemInDir } from "@/app/lib/desktop"
import { isElectronRuntime } from "@/app/lib/runtime-env"
import { SYNTHETIC_SESSION_ERROR_MESSAGE_PREFIX } from "@/app/types"
import { t } from "@/i18n"
import { useOpenTargets } from "@/lib/target-provider"
import { openTargetFromUrl } from "@/react-app/domains/session/artifacts/open-target"
import { presentOpencodeSessionError, sessionErrorPresentationFromUIMessage } from "@/react-app/domains/session/sync/session-error"
import { TaskRecovery } from "./task-recovery"
import { openModelPickerEvent } from "@/react-app/shell/new-providers-listener"
import { ApplyPatchTool } from "@/components/tools/apply-patch"
import { BashTool } from "@/components/tools/bash"
import { EditTool } from "@/components/tools/edit"
import { ReadFileTool, WriteFileTool } from "@/components/tools/file"
import { GlobTool } from "@/components/tools/glob"
import { GrepTool } from "@/components/tools/grep"
import { LspTool } from "@/components/tools/lsp"
import {
  isAutomationProposalToolPart,
  OpenWorkAutomationProposalTool,
} from "@/components/tools/openwork-automation-proposal"
import { QuestionTool } from "@/components/tools/question"
import { SkillTool } from "@/components/tools/skill"
import { TodoWriteTool } from "@/components/tools/todowrite"
import { WebfetchTool } from "@/components/tools/webfetch"
import { WebsearchTool } from "@/components/tools/websearch"
import { useMessageList, useSessionErrorMessage } from "@/components/chat/message-list-provider"
import { TaskSuggestions } from "@/components/chat/task-suggestions"
import { useSessionReferencesMaybe, type SessionReferences } from "@/components/chat/session-reference-context"
import { SessionReferenceLink } from "@/components/chat/session-reference-link"
import { ProgressiveMessageList, type MessageListViewport } from "@/components/chat/progressive-message-list"
import {
  DescriptiveButtonContent,
  DescriptiveButtonDescription,
  DescriptiveButtonIcon,
  DescriptiveButtonTitle,
} from "@/components/descriptive-button"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { ActionContextMenu } from "@/components/ui/action-context-menu"
import type { MenuAction } from "@/components/ui/action-menu-model"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { ImageAttachmentBadge } from "@/components/chat/image-attachment-badge"
import { Image } from "@/components/ui/image"
import {
  Message,
  MessageAction,
  MessageActions,
  MessageContent,
} from "@/components/ui/message"
import { Tool } from "@/components/ui/tool"
import { CapabilityCallLine } from "@/components/chat/capability-call-line"
import { CodeModeTool } from "@/components/chat/code-mode-tool"
import { ConnectionCard } from "@/components/chat/connection-card"
import { connectionFromChatToolPart } from "@/components/tools/error-attribution"
import { isReservedConnectionQuestion, type ChatConnectionDecisionBinding } from "@/react-app/domains/session/surface/mcp-chat-reconnect"
import { codeModeToolCalls } from "@/lib/code-mode-tools"
import { hasPreservedMcpAppResult, isNativeConnectionAppLaunch, McpAppFrame } from "@/components/chat/mcp-app-frame"
import { ReasoningBlock } from "@/components/chat/reasoning-block"
import { SubagentRunLine } from "@/components/chat/subagent-run-line"
import { ToolAggregateGroup } from "@/components/chat/tool-aggregate-group"
import {
  CurrentToolLifecycleProvider,
  useCurrentToolLifecycleResolver,
} from "@/components/chat/current-tool-lifecycle-context"
import {
  isApplyPatchToolPart,
  isBashToolPart,
  isEditToolPart,
  isGlobToolPart,
  isGrepToolPart,
  isLspToolPart,
  isQuestionToolPart,
  isReadToolPart,
  isSkillToolPart,
  isTaskToolPart,
  taskChildSessionId,
  isTodoWriteToolPart,
  isWebFetchToolPart,
  isWebSearchToolPart,
  isWriteToolPart,
} from "@/lib/build-in-tools"
import type { ThreadStatus } from "@/lib/messages"
import { useSessionActivityStore, type SessionActivityStatus } from "@/react-app/domains/session/status/session-activity-store"
import { activeDelegatedTasks, hasNoNewActivity, lastTaskProgressAt } from "@/react-app/domains/session/status/session-progress"
import { revalidateWorkspaceSessionSync } from "@/react-app/domains/session/sync/session-sync"
import { useWorkspaceMaybe } from "@/react-app/shell/workspace-provider"
import { formatElapsedSeconds, formatToolCallDuration } from "@/lib/tool-call-duration"
import { collectLatestAssistantToolParts } from "@/lib/latest-assistant-tool-parts"
import { isToolPartInFlight } from "@/lib/tool-activity"
import { faviconUrlForHref } from "@/lib/favicon"
import { useOpenArtifactPath } from "@/lib/artifacts"
import { cn } from "@/lib/utils"
import { DevProfiler } from "@/react-app/shell/dev-profiler"
import { groupMessages, isMessageGroup, getLastTextPart, getAggregateOnlyParts, getAssistantRenderGroups, getFileTitle, getMediaBadge, getMessageCompleted, getMessageCreated, formatMessageTimestamp, splitTurnAtAnswer, type UIMessageWithIndex, getMessagesText, getSafeFileDownloadUrl, getSafeFileRevealPath } from "./utils"
import type { AnyToolPart } from "@/lib/tool-aggregate"
import { resolveConnectorToolIdentity } from "@/react-app/domains/connections/connector-tool-identity"

const SEARCH_HIGHLIGHT_MARK_CLASS = "rounded px-0.5 bg-amber-4/70 text-current"

/** Above this many step rows a finished turn folds into one summary line. */
const COLLAPSED_STEP_RUN_MIN_ROWS = 4

const ParentRunActiveContext = React.createContext(true)

function MessageTimestamp({ message, className }: { message: UIMessage; className?: string }) {
  const created = getMessageCreated(message)
  if (created === null) return null

  return (
    <span
      className={cn(
        "select-none whitespace-nowrap text-[11px] tabular-nums text-muted-foreground/70",
        className
      )}
      title={new Date(created).toLocaleString()}
    >
      {formatMessageTimestamp(created)}
    </span>
  )
}

interface ToolMessageProps {
  part: ToolUIPart | DynamicToolUIPart
}

/**
 * Error boundary around tool-part rendering. Tool inputs from streamed or
 * interrupted runs can violate their type contracts (partial/undefined
 * input); without this boundary a single bad part unmounts the entire app
 * (white screen). Seen in production on v0.15.3 via a todowrite part with
 * missing input.todos.
 */
class ToolMessage extends React.Component<ToolMessageProps, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  componentDidCatch(error: unknown) {
    console.error("[tool-part] render failed", error)
  }

  render() {
    if (this.state.failed) {
      return (
        <div className="text-xs text-muted-foreground">Tool step unavailable</div>
      )
    }
    return <ToolMessageInner part={this.props.part} />
  }
}

/**
 * Tool calls in the current assistant turn that present as the native
 * connection card. One card per connection: the latest report wins, and a
 * pending native question pins the card to the call it is bound to. Earlier
 * reports for the same connection stay quiet sentence lines.
 */
const ConnectionCardPartsContext = React.createContext<ReadonlySet<string>>(new Set())

function connectionCardPartIds(
  items: readonly UIMessageWithIndex[],
  getConnectionDecision: ((toolCallId: string) => ChatConnectionDecisionBinding | null) | undefined,
): Set<string> {
  const latest = new Map<string, string>()
  const bound = new Map<string, string>()
  for (const item of items) {
    if (item.message.role !== "assistant" || isSessionErrorMessage(item.message)) continue
    for (const part of item.message.parts) {
      if (part.type !== "dynamic-tool" || (part.state !== "output-available" && part.state !== "output-error")) continue
      const decision = getConnectionDecision?.(part.toolCallId) ?? null
      const found = connectionFromChatToolPart(part, { allowDiscovery: decision !== null })
      if (!found) continue
      if (decision) bound.set(found.connection.connectionId, part.toolCallId)
      else latest.set(found.connection.connectionId, part.toolCallId)
    }
  }
  return new Set([...latest.entries()].map(([connectionId, toolCallId]) => bound.get(connectionId) ?? toolCallId).concat([...bound.values()]))
}

/** The reserved native connection question is answered through the card, never as a tool row. */
function isReservedConnectionQuestionPart(part: ToolUIPart | DynamicToolUIPart): boolean {
  return part.type === "dynamic-tool" && /(?:^|_)question$/.test(part.toolName) && isReservedConnectionQuestion(part.input)
}

const ToolMessageInner = ({ part }: ToolMessageProps) => {
  const { connectorIdentities, onMcpReconnect, onMcpReopenAuthorization, connectionQuestionToolCallId, getConnectionDecision } = useMessageList()
  const parentActive = React.useContext(ParentRunActiveContext)
  const resolveLifecycle = useCurrentToolLifecycleResolver()
  const lifecycle = resolveLifecycle(part.toolCallId, isToolPartInFlight(part))
  const connectionCardParts = React.useContext(ConnectionCardPartsContext)
  if (part.toolCallId === connectionQuestionToolCallId || isReservedConnectionQuestionPart(part)) return null

  // Delegated work has its own lifecycle, even after a parent follow-up/error.
  if (isTaskToolPart(part)) return <SubagentRunLine part={part} parentActive={parentActive} />

  if (part.type === "dynamic-tool") {
    const calls = codeModeToolCalls(part)
    if (calls) return <CodeModeTool part={part} calls={calls} lifecycle={lifecycle} connectors={connectorIdentities} />
  }

  if (lifecycle === "waiting") {
    return (
      <div
        className="flex items-start gap-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-sm text-foreground"
        data-tool-lifecycle="waiting"
        role="status"
      >
        <CirclePause aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        <div>
          <div className="font-medium">Waiting for your action</div>
          <div className="text-xs text-amber-11">Choose an option or approve the request to continue.</div>
        </div>
      </div>
    )
  }

  const statusUnknown = isToolPartInFlight(part) && (lifecycle === "interrupted" || (!lifecycle && !parentActive))
  if (statusUnknown) {
    return (
      <div className="text-sm text-muted-foreground" data-tool-lifecycle="unknown">
        {part.type === "dynamic-tool" ? (
          <CapabilityCallLine part={part} connector={resolveConnectorToolIdentity(part, connectorIdentities)} statusUnknown />
        ) : "Tool activity — status unavailable"}
      </div>
    )
  }

  if (isBashToolPart(part)) {
    return <BashTool part={part} />
  }

  if (isEditToolPart(part)) {
    return <EditTool part={part} />
  }

  if (isWriteToolPart(part)) {
    return <WriteFileTool part={part} />
  }

  if (isReadToolPart(part)) {
    return <ReadFileTool part={part} />
  }

  if (isGrepToolPart(part)) {
    return <GrepTool part={part} />
  }

  if (isGlobToolPart(part)) {
    return <GlobTool part={part} />
  }

  if (isLspToolPart(part)) {
    return <LspTool part={part} />
  }

  if (isApplyPatchToolPart(part)) {
    return <ApplyPatchTool part={part} />
  }

  if (isSkillToolPart(part)) {
    return <SkillTool part={part} />
  }

  if (isTodoWriteToolPart(part)) {
    return <TodoWriteTool part={part} />
  }

  if (isWebFetchToolPart(part)) {
    return <WebfetchTool part={part} />
  }

  if (isWebSearchToolPart(part)) {
    return <WebsearchTool part={part} />
  }

  if (isQuestionToolPart(part)) {
    return <QuestionTool part={part} />
  }

  if (part.type === "dynamic-tool" && isAutomationProposalToolPart(part)) {
    return <OpenWorkAutomationProposalTool part={part} />
  }

  // OpenWork's own connection reports render as the native card: the host is
  // the presentation; the Den App remains for external hosts.
  if (part.type === "dynamic-tool" && connectionCardParts.has(part.toolCallId)) {
    return <ConnectionCard part={part} allowDiscovery={Boolean(getConnectionDecision?.(part.toolCallId))} />
  }

  // Failed calls use the same sentence line with the "failures are
  // instructions" treatment (inline Reconnect/Retry).
  if (part.type === "dynamic-tool") {
    return (
      <CapabilityCallLine
        part={part}
        connector={resolveConnectorToolIdentity(part, connectorIdentities)}
        onReconnect={hasPreservedMcpAppResult(part) ? undefined : onMcpReconnect}
        onReopenAuthorization={onMcpReopenAuthorization}
      />
    )
  }

  return (
    <Tool
      toolPart={part}
      onReconnect={onMcpReconnect}
      onReopenAuthorization={onMcpReopenAuthorization}
    />
  )
}

const isEmptyMessage = (message: UIMessage): boolean => message.parts.length === 0

type RetryStatus = Extract<SessionStatus, { type: "retry" }>

function isSessionErrorMessage(message: UIMessage) {
  return message.id.startsWith(SYNTHETIC_SESSION_ERROR_MESSAGE_PREFIX)
}

function retryDelaySeconds(status: RetryStatus) {
  return Math.max(0, Math.round((status.next - Date.now()) / 1000))
}

interface FileMessageProps {
  part: FileUIPart
  tone: "user" | "assistant"
}

function FileMessage({ part, tone }: FileMessageProps) {
  const openArtifactPath = useOpenArtifactPath()
  const title = getFileTitle(part)
  const badge = getMediaBadge(part)
  const isImage = part.mediaType.startsWith("image/") && Boolean(part.url)
  const downloadUrl = getSafeFileDownloadUrl(part)
  const revealPath = getSafeFileRevealPath(part)
  const canReveal = isElectronRuntime() && Boolean(revealPath)

  const handleDownload = React.useCallback(() => {
    if (!downloadUrl) return
    const anchor = document.createElement("a")
    anchor.href = downloadUrl
    anchor.download = title
    anchor.rel = "noopener noreferrer"
    document.body.append(anchor)
    anchor.click()
    anchor.remove()
  }, [downloadUrl, title])

  const handleReveal = React.useCallback(() => {
    if (!revealPath) return
    void revealDesktopItemInDir(revealPath)
  }, [revealPath])

  const fileContent = (
    <>
      <DescriptiveButtonIcon>
        <FileIcon className="size-5 shrink-0" />
      </DescriptiveButtonIcon>
      <DescriptiveButtonContent className="gap-0">
        <DescriptiveButtonTitle className="truncate text-xs">{title}</DescriptiveButtonTitle>
        {badge ? (
          <DescriptiveButtonDescription className="text-[10px]">
            {badge}
          </DescriptiveButtonDescription>
        ) : null}
      </DescriptiveButtonContent>
    </>
  )

  if (isImage && tone === "user") {
    return <ImageAttachmentBadge src={part.url} alt={title} />
  }

  if (isImage) {
    return (
      <Image
        src={part.url}
        alt={title}
        loading="lazy"
        decoding="async"
        previewMaxWidth={280}
        previewMaxHeight={160}
        className="rounded-xl border border-border/70"
      />
    )
  }

  return (
    <div className="flex h-auto w-fit min-w-0 max-w-full shrink items-center justify-start gap-2 rounded-xl border border-border/70 bg-background/40 ps-2 pe-2 py-1 text-left text-sm font-medium whitespace-normal">
      {revealPath ? (
        <button
          type="button"
          className="flex min-w-0 items-center gap-2 pe-2 text-left transition-opacity hover:opacity-80"
          onClick={() => openArtifactPath(revealPath)}
          title={`Open ${title} in Artifacts`}
        >
          {fileContent}
        </button>
      ) : (
        <div className="flex min-w-0 items-center gap-2 pe-2">{fileContent}</div>
      )}
      {downloadUrl || canReveal ? (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={`More actions for ${title}`}
              >
                <MoreHorizontal />
              </Button>
            }
          />
          <DropdownMenuContent align="end" className="min-w-44">
            {downloadUrl ? (
              <DropdownMenuItem onClick={handleDownload}>
                <Download />
                Download
              </DropdownMenuItem>
            ) : null}
            {canReveal ? (
              <DropdownMenuItem onClick={handleReveal}>
                <FolderOpen />
                Reveal in Finder
              </DropdownMenuItem>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </div>
  )
}

interface CopyMessageButtonProps {
  messages: UIMessage[]
}

function CopyMessageButton({ messages }: CopyMessageButtonProps) {
  const [copied, setCopied] = React.useState(false)
  const text = React.useMemo(() => getMessagesText(messages), [messages])

  const onCopy = React.useCallback(async () => {
    if (!text) {
      return
    }

    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      // ignore clipboard failures
    }
  }, [text])

  if (!text) {
    return null
  }

  return (
    <MessageAction tooltip={copied ? "Copied!" : "Copy"}>
      <Button
        variant="ghost"
        size="icon"
        aria-label="Copy message"
        onClick={() => void onCopy()}
      >
        {copied ? <Check /> : <Copy />}
      </Button>
    </MessageAction>
  )
}

type AssistantMessageProps = {
  message: UIMessage
  isLastMessage: boolean
  isStreaming: boolean
  isLastStep: boolean
  /** Set when the turn's collapsed step run shows this reasoning instead. */
  hideReasoning?: boolean
}

const AssistantMessage = React.memo(
  ({ message, isStreaming, hideReasoning }: AssistantMessageProps) => {
    const { showThinking, highlightQuery } = useMessageList()
    const assistantRenderGroups = React.useMemo(
      () => {
        const groups = getAssistantRenderGroups(message.parts, showThinking)
        return hideReasoning ? groups.filter((group) => group.kind !== "reasoning") : groups
      },
      [hideReasoning, message.parts, showThinking]
    )

    return (
      <Message
        className="mx-auto flex w-full max-w-3xl flex-col items-start gap-2 px-2 md:px-10"
        data-message-id={message.id}
        data-message-role={message.role}
      >
        <div className="group flex w-full flex-col gap-0 space-y-2">
          {assistantRenderGroups.map((group, index) => {
            if (group.kind === "text") {
              return (
                <MessageContent
                  key={`text-${index}`}
                  className="text-foreground prose w-full min-w-0 flex-1 rounded-lg bg-transparent p-0"
                  markdown
                  sessionReferences
                  isStreaming={isStreaming}
                  highlightQuery={highlightQuery}
                >
                  {group.text}
                </MessageContent>
              )
            }

            if (group.kind === "reasoning") {
              return (
                <ReasoningBlock
                  key={`reasoning-${index}`}
                  disclosureKey={JSON.stringify(["reasoning", message.id, index])}
                  text={group.text}
                  isStreaming={group.isStreaming}
                />
              )
            }

            if (group.kind === "file") {
              return (
                <div key={`file-${index}`} className="w-fit max-w-full">
                  <FileMessage part={group.part} tone="assistant" />
                </div>
              )
            }

            if (group.kind === "tool-aggregate") {
              return (
                <div key={`tool-aggregate-${index}`} className="w-full">
                  <ToolAggregateGroup messageId={message.id} parts={group.parts} thoughts={group.thoughts} />
                </div>
              )
            }

            return (
              <div key={`tool-${index}`} className="w-full">
                <ToolMessage part={group.part} />
              </div>
            )
          })}
        </div>
      </Message>
    )
  }
)

AssistantMessage.displayName = "AssistantMessage"

type UserMessageProps = {
  message: UIMessage
  isStreaming: boolean
}

const USER_SKILL_TOKEN_RE = /(Load \[skill [^\]]+\] and follow its instructions\.|\[skill [^\]]+\])/

function UserSkillChip(props: { name: string }) {
  return (
    <span className="mx-0.5 inline-flex items-center rounded-full border border-violet-6/35 bg-violet-3/20 px-2.5 py-1 text-xs font-medium text-violet-11 align-middle" title={`Skill: ${props.name}`}>
      {props.name}
    </span>
  )
}

function renderPlainTextWithSearchHighlights(text: string, highlightQuery: string | undefined, keyPrefix: string) {
  const needle = highlightQuery?.trim().toLowerCase() ?? ""
  if (needle.length < 2) return text

  const lower = text.toLowerCase()
  if (!lower.includes(needle)) return text

  const nodes: React.ReactNode[] = []
  let cursor = 0
  let matchIndex = lower.indexOf(needle)
  while (matchIndex >= 0) {
    if (matchIndex > cursor) {
      nodes.push(text.slice(cursor, matchIndex))
    }
    const end = matchIndex + needle.length
    nodes.push(
      <mark
        key={`${keyPrefix}:match:${matchIndex}`}
        data-search-highlight="true"
        className={SEARCH_HIGHLIGHT_MARK_CLASS}
      >
        {text.slice(matchIndex, end)}
      </mark>
    )
    cursor = end
    matchIndex = lower.indexOf(needle, cursor)
  }

  if (cursor < text.length) {
    nodes.push(text.slice(cursor))
  }

  return nodes
}

function renderPlainTextWithSessionReferences(text: string, highlightQuery: string | undefined, keyPrefix: string, references: SessionReferences | undefined) {
  if (!references) return renderPlainTextWithSearchHighlights(text, highlightQuery, keyPrefix)
  const nodes: React.ReactNode[] = []
  let cursor = 0
  for (const match of text.matchAll(/[^\s()[\]{}<>"'`]+/g)) {
    const raw = match[0].replace(/[.,;:!]+$/, "")
    const reference = references.resolve(raw)
    if (!reference) continue
    const start = match.index
    nodes.push(
      <React.Fragment key={`${keyPrefix}:pre:${cursor}`}>
        {renderPlainTextWithSearchHighlights(text.slice(cursor, start), highlightQuery, `${keyPrefix}:pre:${cursor}`)}
      </React.Fragment>
    )
    const needle = highlightQuery?.trim().toLowerCase() ?? ""
    nodes.push(
      <SessionReferenceLink key={`${keyPrefix}:session:${start}`} reference={reference} openReference={references.openReference}>
        {needle.length >= 2 && raw.toLowerCase().includes(needle) ? (
          <mark data-search-highlight="true" className={SEARCH_HIGHLIGHT_MARK_CLASS}>{reference.title}</mark>
        ) : renderPlainTextWithSearchHighlights(reference.title, highlightQuery, `${keyPrefix}:title:${start}`)}
      </SessionReferenceLink>
    )
    cursor = start + raw.length
  }
  nodes.push(
    <React.Fragment key={`${keyPrefix}:post:${cursor}`}>
      {renderPlainTextWithSearchHighlights(text.slice(cursor), highlightQuery, `${keyPrefix}:post:${cursor}`)}
    </React.Fragment>
  )
  return nodes
}

// Bare URL, excluding trailing punctuation that usually ends a sentence.
const PLAIN_URL_RE = /https?:\/\/[^\s<>"')\]]+[^\s<>"')\].,;:!?]/g

/** User bubbles are plain text, so bare https:// URLs need explicit anchors. */
function renderPlainTextWithLinks(text: string, highlightQuery: string | undefined, keyPrefix: string, references: SessionReferences | undefined) {
  const nodes: React.ReactNode[] = []
  let cursor = 0
  for (const match of text.matchAll(PLAIN_URL_RE)) {
    const start = match.index
    const url = match[0]
    if (start > cursor) {
      nodes.push(
        <React.Fragment key={`${keyPrefix}:pre:${cursor}`}>
          {renderPlainTextWithSessionReferences(text.slice(cursor, start), highlightQuery, `${keyPrefix}:pre:${cursor}`, references)}
        </React.Fragment>
      )
    }
    const favicon = faviconUrlForHref(url)
    nodes.push(
      <a
        key={`${keyPrefix}:url:${start}`}
        href={url}
        target="_blank"
        rel="noreferrer noopener"
        className="text-indigo-10 transition-colors hover:text-indigo-8 break-all"
      >
        {favicon ? (
          <img
            src={favicon}
            alt=""
            aria-hidden="true"
            loading="lazy"
            decoding="async"
            className="me-1 inline-block size-3.5 rounded-[3px] align-[-2px]"
          />
        ) : null}
        {url}
      </a>
    )
    cursor = start + url.length
  }
  if (nodes.length === 0) return renderPlainTextWithSessionReferences(text, highlightQuery, keyPrefix, references)
  if (cursor < text.length) {
    nodes.push(
      <React.Fragment key={`${keyPrefix}:post:${cursor}`}>
        {renderPlainTextWithSessionReferences(text.slice(cursor), highlightQuery, `${keyPrefix}:post:${cursor}`, references)}
      </React.Fragment>
    )
  }
  return nodes
}

function renderUserTextWithSkillChips(text: string, highlightQuery: string | undefined, references: SessionReferences | undefined) {
  if (!USER_SKILL_TOKEN_RE.test(text)) return renderPlainTextWithLinks(text, highlightQuery, "text", references)
  let offset = 0
  return text.split(USER_SKILL_TOKEN_RE).map((segment) => {
    const key = `${offset}:${segment}`
    offset += segment.length
    const skillMatch = segment.match(/^(?:Load )?\[skill ([^\]]+)\](?: and follow its instructions\.)?$/)
    if (skillMatch?.[1]) return <UserSkillChip key={key} name={skillMatch[1]} />
    return <React.Fragment key={key}>{renderPlainTextWithLinks(segment, highlightQuery, key, references)}</React.Fragment>
  })
}

function renderUserProse(text: string, highlightQuery: string | undefined, references: SessionReferences | undefined) {
  const nodes: React.ReactNode[] = []
  const ticks = /`+/g
  let cursor = 0
  let match: RegExpExecArray | null
  while ((match = ticks.exec(text))) {
    const start = match.index
    const delimiter = match[0]
    const bodyStart = ticks.lastIndex
    let closing: RegExpExecArray | null
    do {
      closing = ticks.exec(text)
    } while (closing && closing[0] !== delimiter)
    const end = closing ? ticks.lastIndex : text.length
    const body = text.slice(bodyStart, closing?.index ?? text.length)
    const exactId = Boolean(closing) && /^ses_[A-Za-z0-9][A-Za-z0-9_-]*$/.test(body)
    nodes.push(
      <React.Fragment key={`prose:${cursor}`}>
        {renderUserTextWithSkillChips(text.slice(cursor, start), highlightQuery, references)}
      </React.Fragment>,
      <React.Fragment key={`inline-code:${start}`}>
        {renderUserTextWithSkillChips(text.slice(start, end), highlightQuery, exactId ? references : undefined)}
      </React.Fragment>
    )
    cursor = end
    if (!closing) break
  }
  nodes.push(<React.Fragment key={`prose:${cursor}`}>{renderUserTextWithSkillChips(text.slice(cursor), highlightQuery, references)}</React.Fragment>)
  return nodes
}

function renderUserText(text: string, highlightQuery: string | undefined, references: SessionReferences | undefined) {
  if (!references) return renderUserTextWithSkillChips(text, highlightQuery, undefined)
  const nodes: React.ReactNode[] = []
  const blocks = /^(?:[ \t]*(?:>[ \t]*)*(?:(?:[-+*]|\d+[.)])[ \t]+)?(`{3,}|~{3,})[^\n]*(?:\n|$)|(?: {4}|\t)[^\n]*(?:\n|$))/gm
  let cursor = 0
  let match: RegExpExecArray | null
  while ((match = blocks.exec(text))) {
    const start = match.index
    const fence = match[1]
    let end = blocks.lastIndex
    if (fence) {
      const closing = new RegExp(`^[ \\t]*(?:>[ \\t]*)*${fence[0]}{${fence.length},}[ \\t]*\\r?(?:\\n|$)`, "gm")
      closing.lastIndex = end
      end = closing.exec(text) ? closing.lastIndex : text.length
      blocks.lastIndex = end
    }
    nodes.push(
      <React.Fragment key={`prose:${cursor}`}>
        {renderUserProse(text.slice(cursor, start), highlightQuery, references)}
      </React.Fragment>,
      <React.Fragment key={`code-block:${start}`}>
        {renderUserTextWithSkillChips(text.slice(start, end), highlightQuery, undefined)}
      </React.Fragment>
    )
    cursor = end
  }
  nodes.push(<React.Fragment key={`prose:${cursor}`}>{renderUserProse(text.slice(cursor), highlightQuery, references)}</React.Fragment>)
  return nodes
}

const UserMessage = React.memo(
  ({ message, isStreaming }: UserMessageProps) => {
    const { onRevertToUserMessage, onForkAtMessage, forkingMessageId, onEditUserMessage, highlightQuery, readOnly } = useMessageList()
    const references = useSessionReferencesMaybe()
    const branching = forkingMessageId === message.id
    const { onOpenTarget } = useOpenTargets()
    const openLink = (event: React.MouseEvent) => {
      if (event.defaultPrevented || !onOpenTarget || !(event.target instanceof Element)) return
      const link = event.target.closest("a[href]")
      const target = openTargetFromUrl(link?.getAttribute("href") ?? "")
      if (!target) return
      event.preventDefault()
      onOpenTarget(target)
    }
    const messageText = React.useMemo(() => getMessagesText([message]), [message])
    const inlineParts = React.useMemo(
      () => message.parts.filter((part) => (part.type === "text" && Boolean(part.text)) || isFileUIPart(part)),
      [message.parts],
    )
    const hasContent = inlineParts.length > 0
    const menuActions: MenuAction[] = []
    if (messageText) menuActions.push(
      { type: "item", id: "edit", label: "Edit message", icon: <Pencil className="size-4" />, disabled: readOnly, onSelect: () => onEditUserMessage(message.id, messageText) },
      { type: "item", id: "copy", label: "Copy", icon: <Copy className="size-4" />, onSelect: () => navigator.clipboard.writeText(messageText) },
    )
    menuActions.push(
      { type: "item", id: "branch", label: branching ? "Branching..." : "Branch in new chat", icon: <Split className="size-4 rotate-90" />, disabled: Boolean(forkingMessageId), onSelect: () => onForkAtMessage(message.id) },
      { type: "item", id: "revert", label: "Revert", icon: <Undo2 className="size-4" />, disabled: readOnly, onSelect: () => onRevertToUserMessage(message.id) },
    )

    return (
      <Message
        className="mx-auto flex w-full max-w-3xl flex-col items-end gap-2 px-2 md:px-10"
        data-message-id={message.id}
        data-message-role={message.role}
      >
          <ActionContextMenu
            tabIndex={0}
            actions={menuActions}
            contentClassName="w-56"
            // Override Trigger's select-none so user bubbles stay copyable.
            className="!select-text"
            render={
              <div
                className="group flex w-full flex-col items-end gap-1 !select-text"
                style={{ userSelect: "text" }}
              >
                {hasContent ? (
                  <MessageContent
                    className="bg-muted text-foreground max-w-[85%] rounded-3xl px-4 py-2.5 leading-6 sm:max-w-[75%] !select-text not-prose"
                    style={{ userSelect: "text" }}
                    onClick={openLink}
                  >
                    {inlineParts.map((part, index) => {
                      if (part.type === "text") {
                        return (
                          <span key={`text-${index}`} className="whitespace-pre-wrap">
                            {renderUserText(part.text, highlightQuery, references)}
                          </span>
                        )
                      }
                      if (isFileUIPart(part)) {
                        // An attachment is identified by its position among the
                        // message's files, not by its URL or filename: a sent image
                        // first shows the composer's blob: preview, then the server's
                        // recompressed data: copy. Keeping one element lets the
                        // browser swap the bitmap in place instead of remounting an
                        // <img> that has to decode before it can paint.
                        const attachmentIndex = inlineParts.slice(0, index).filter(isFileUIPart).length
                        return (
                          <span
                            key={`file-${attachmentIndex}`}
                            className="mx-1 inline-flex align-middle not-prose"
                          >
                            <FileMessage part={part} tone="user" />
                          </span>
                        )
                      }
                      return null
                    })}
                  </MessageContent>
                ) : null}
                {!isStreaming && (
                  <MessageActions
                    className={cn(
                      "flex items-center gap-0 transition-opacity duration-150 group-hover:opacity-100 max-lg:opacity-100 pointer-coarse:opacity-100",
                      branching ? "opacity-100" : "opacity-0"
                    )}
                  >
                    <MessageTimestamp message={message} className="mr-1.5" />
                    <CopyMessageButton messages={[message]} />
                    {messageText ? (
                      <MessageAction tooltip="Edit message">
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label="Edit message"
                          disabled={readOnly}
                          onClick={() => onEditUserMessage(message.id, messageText)}
                        >
                          <Pencil />
                        </Button>
                      </MessageAction>
                    ) : null}
                    <MessageAction tooltip={branching ? "Branching..." : "Branch in new chat"}>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={branching ? "Branching..." : "Branch in new chat"}
                        aria-busy={branching || undefined}
                        disabled={Boolean(forkingMessageId)}
                        onClick={() => onForkAtMessage(message.id)}
                      >
                        {branching ? <LoaderCircle className="motion-safe:animate-spin" /> : <Split className="rotate-90" />}
                      </Button>
                    </MessageAction>
                    {branching ? <span role="status" className="sr-only">Branching...</span> : null}
                    <MessageAction tooltip="Revert">
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label="Revert"
                        disabled={readOnly}
                        onClick={() => onRevertToUserMessage(message.id)}
                      >
                        <Undo2 />
                      </Button>
                    </MessageAction>
                  </MessageActions>
                )}
              </div>
            }
          />
      </Message>
    )
  }
)

UserMessage.displayName = "UserMessage"

type MessageComponentProps = {
  message: UIMessage
  isLastMessage: boolean
  isStreaming: boolean
  isLastStep: boolean
  hideReasoning?: boolean
}

const MessageComponent = React.memo(
  ({ message, isLastMessage, isStreaming, isLastStep, hideReasoning }: MessageComponentProps) => {
    if (isSessionErrorMessage(message)) {
      const presentation = sessionErrorPresentationFromUIMessage(message)
      return (
        <ErrorMessage
          error={getMessagesText([message]) || "Session failed"}
          description={presentation?.description}
          showDescriptionOnResume={presentation?.kind !== "aborted" && presentation?.kind !== "provider-timeout"}
          resumePrompt={presentation?.recoveryPrompt}
          canRetry={isLastMessage && !isStreaming}
          technicalDetails={presentation?.technicalDetails}
          gatewayConnectUrl={presentation?.kind === "gateway-auth-required" || presentation?.kind === "provider-credentials" ? presentation.connectUrl ?? null : undefined}
          gatewaySelectionRequired={presentation?.kind === "gateway-selection-required"}
          changeModel={presentation !== null && ["provider-access-denied", "provider-unavailable", "rate-limited", "conversation-too-long", "attachment-unsupported"].includes(presentation.kind)}
        />
      )
    }

    if (isEmptyMessage(message)) {
      return null
    }

    if (message.role === "assistant") {
      return (
        <AssistantMessage
          message={message}
          isLastMessage={isLastMessage}
          isStreaming={isStreaming}
          isLastStep={isLastStep}
          hideReasoning={hideReasoning}
        />
      )
    }

    return (
      <UserMessage
        message={message}
        isStreaming={isStreaming}
      />
    )
  }
)

MessageComponent.displayName = "MessageComponent"

const LoadingMessage = React.memo(({ elapsedSeconds, starting }: { elapsedSeconds: number; starting: boolean }) => (
    <Message className="mx-auto flex w-full max-w-3xl flex-col items-start gap-2 px-2 md:px-10">
      <div role={starting ? "status" : undefined} data-loading-message={starting ? "starting" : "working"} className="py-1 text-sm text-muted-foreground">
        <span className="ow-text-shimmer tabular-nums">{starting ? "Starting…" : `Working ${formatElapsedSeconds(elapsedSeconds)}`}</span>
      </div>
    </Message>
))

LoadingMessage.displayName = "LoadingMessage"

// Show when the run was last validated once the gap is long enough to matter;
// a short blip needs no timestamp archaeology.
const RECONNECTING_LAST_CONFIRMED_AFTER_MS = 120_000

export function reconnectingLastConfirmedLabel(
  lastConfirmedAt: number | null,
  now: number,
): string | null {
  if (lastConfirmedAt === null) return null
  if (now - lastConfirmedAt < RECONNECTING_LAST_CONFIRMED_AFTER_MS) return null
  return new Date(lastConfirmedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
}

/**
 * The honest replacement for the ticking "Working" row while a live run can
 * no longer be validated: the engine may still be working, but nothing has
 * confirmed it recently, so the timer stops instead of counting unverified
 * time. Recovery is automatic — the sync layer keeps revalidating and the
 * row settles from authoritative status, never from elapsed time.
 */
const ReconnectingMessage = React.memo(({ lastConfirmedAt }: { lastConfirmedAt: number | null }) => {
  const [now, setNow] = React.useState(() => Date.now())
  React.useEffect(() => {
    // The health store stops changing once its failure counter caps, so keep
    // a slow local tick to let the "last update" hint appear over time.
    const interval = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(interval)
  }, [])
  const lastConfirmedLabel = reconnectingLastConfirmedLabel(lastConfirmedAt, now)
  return (
    <Message className="mx-auto flex w-full max-w-3xl flex-col items-start gap-2 px-2 md:px-10">
      <div
        data-loading-message="reconnecting"
        className="flex min-w-0 items-center gap-2 py-1 text-sm text-muted-foreground"
      >
        <WifiOff aria-hidden="true" className="size-4 shrink-0" />
        <span className="min-w-0 truncate">
          Connection lost — reconnecting…
          {lastConfirmedLabel ? ` · last update ${lastConfirmedLabel}` : ""}
        </span>
      </div>
    </Message>
  )
})

ReconnectingMessage.displayName = "ReconnectingMessage"

interface ErrorMessageProps {
  error: string | null
  description?: string | null
  /** Keep safety guidance visible without expanding ordinary interruption rows. */
  showDescriptionOnResume?: boolean
  /** Set only for interrupted runs that can resume. */
  resumePrompt?: string | null
  canRetry?: boolean
  /** Error type, status, provider, code, response body — for bug reports and support. */
  technicalDetails?: string | null
  /**
   * Set (possibly null) only when the OpenWork Gateway rejected the request
   * because the member must sign in: a URL opens the grant in the browser,
   * null deep-links to Settings > AI providers instead.
   */
  gatewayConnectUrl?: string | null
  gatewaySelectionRequired?: boolean
  changeModel?: boolean
}

function ErrorMessage({ error, description, showDescriptionOnResume, resumePrompt, canRetry = true, technicalDetails, gatewayConnectUrl, gatewaySelectionRequired, changeModel }: ErrorMessageProps) {
  const { onResumeInterrupted, developerMode, dispatchAction, sessionId } = useMessageList()
  const selection = error?.includes("gateway_selection_required") ? presentOpencodeSessionError(error) : null
  const displayError = selection?.title ?? error
  const displayDescription = selection?.description ?? description
  const displayDetails = selection?.technicalDetails ?? technicalDetails
  const resumable = Boolean(resumePrompt && onResumeInterrupted)
  return (
    <TaskRecovery title={displayError ?? "Task failed"} state={resumable ? "paused" : "failed"}
      testId={resumable ? "session-error-interrupted" : undefined}
      description={showDescriptionOnResume && displayDescription
        ? <span data-testid="session-error-interruption-warning">{displayDescription}</span>
        : !resumePrompt ? displayDescription : null}
      technicalDetails={developerMode ? displayDetails : null}
      onRetry={canRetry && resumable && resumePrompt ? () => onResumeInterrupted?.(resumePrompt) : undefined}
      retryTestId="session-error-resume"
      actions={gatewaySelectionRequired || selection || changeModel || gatewayConnectUrl !== undefined ? <>
        {gatewaySelectionRequired || selection ? <Button variant="ghost" size="xs" data-testid="session-error-gateway-selection"
          onClick={() => window.dispatchEvent(new CustomEvent(openModelPickerEvent, { detail: { sessionId, initialTab: "available" } }))}>
          Choose group and credential set
        </Button> : null}
        {changeModel && !gatewaySelectionRequired && !selection ? <Button variant="ghost" size="xs"
          onClick={() => window.dispatchEvent(new CustomEvent(openModelPickerEvent, { detail: { sessionId, initialTab: "available" } }))}>Change model</Button> : null}
        {gatewayConnectUrl !== undefined ? <Button variant="ghost" size="xs" data-testid="session-error-gateway-connect"
          onClick={() => dispatchAction({ target: "settings", action: "open", section: "providers" })}>Connect</Button> : null}
      </> : null} />
  )
}

interface RetryMessageProps {
  status: RetryStatus
}

const RetryMessage = React.memo(({ status }: RetryMessageProps) => {
  const { dispatchAction, developerMode } = useMessageList()
  const [seconds, setSeconds] = React.useState(() => retryDelaySeconds(status))

  React.useEffect(() => {
    let timer: number | null = null
    const update = () => {
      const nextSeconds = retryDelaySeconds(status)
      setSeconds((current) => current === nextSeconds ? current : nextSeconds)
      if (nextSeconds > 0) timer = window.setTimeout(update, 1000)
    }
    update()
    return () => {
      if (timer !== null) window.clearTimeout(timer)
    }
  }, [status])

  const info = seconds > 0
    ? `Retrying in ${seconds}s · attempt ${status.attempt}`
    : `Retrying · attempt ${status.attempt}`
  const action = status.action
  const freeModelLimit = action?.reason === "free_tier_limit"
  const presentation = presentOpencodeSessionError({ name: "APIError", data: { message: status.message } })

  return (
    <TaskRecovery state="retrying" testId="session-retrying"
      title={`${(freeModelLimit ? "The free starter model is busy right now" : action?.title ?? presentation.title).replace(/[.!…]+$/, "")}. Retrying…`}
      description={freeModelLimit ? "To keep working now, connect your own model provider." : action?.message}
      technicalDetails={[info, ...(developerMode ? [presentation.technicalDetails] : [])].join("\n")}
      actions={freeModelLimit ? <Button variant="ghost" size="xs"
        onClick={() => dispatchAction({ target: "settings", action: "open", section: "providers" })}>Connect a model provider</Button>
        : action?.link ? <Button variant="ghost" size="xs" onClick={openDesktopUrl.bind(null, action.link)}>{action.label}</Button> : null} />
  )
})

RetryMessage.displayName = "RetryMessage"

const isMessageEmptyGroup = (messages: UIMessageWithIndex[]) =>
  messages.every(message => isEmptyMessage(message.message));

const getRenderableMessages = (messages: UIMessageWithIndex[]) =>
  messages.flatMap((item) => {
    const renderableMessage = getRenderableMessage(item.message);

    return renderableMessage ? [{ ...item, message: renderableMessage }] : []
  })

function getRenderableMessage(message: UIMessage) {
  const parts = message.parts.filter((part) => part.type === "text" || part.type === "file");

  return parts.length > 0 ? { ...message, parts } : null;
}

/**
 * A finished turn's steps collapse to a single "Worked for 1m 19s" line
 * that expands back into the full run. Only live turns show their steps
 * unprompted; once the answer is in, the reasoning is available but out
 * of the way.
 */
function CompletedStepRun({ label, children }: { label: string; children: React.ReactNode }) {
  const [open, setOpen] = React.useState(false)

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="flex w-full flex-col gap-2">
      <div className="mx-auto flex w-full max-w-3xl px-2 md:px-10">
        <CollapsibleTrigger
          className="group flex cursor-pointer items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
          aria-label={open ? `${label}. Hide steps` : `${label}. Show steps`}
        >
          <span>{label}</span>
          <ChevronRight
            aria-hidden="true"
            className={cn(
              "size-3.5 text-muted-foreground/70 transition-transform duration-150",
              open && "rotate-90"
            )}
          />
        </CollapsibleTrigger>
      </div>
      <CollapsibleContent className="h-(--collapsible-panel-height) overflow-hidden transition-[height] duration-150 ease-out data-starting-style:h-0 data-ending-style:h-0 [&[hidden]:not([hidden='until-found'])]:hidden">
        {children}
      </CollapsibleContent>
    </Collapsible>
  )
}

interface AssistantMessageGroupProps {
  items: UIMessageWithIndex[]
  isLastGroup: boolean
  isStreaming: boolean
}

function collectMcpAppParts(items: UIMessageWithIndex[]): DynamicToolUIPart[] {
  const parts = new Map<string, DynamicToolUIPart>()
  for (const item of items) {
    if (item.message.role !== "assistant" || isSessionErrorMessage(item.message)) continue
    for (const part of item.message.parts) {
      if (
        part.type === "dynamic-tool"
        && (part.state === "output-available" || part.state === "output-error")
        && hasPreservedMcpAppResult(part)
        && !isNativeConnectionAppLaunch(part)
      ) {
        parts.set(part.toolCallId, part)
      }
    }
  }
  return [...parts.values()]
}

function MessageGroup({
  items,
  isLastGroup,
  isStreaming,
}: AssistantMessageGroupProps) {
  const { onRevertToUserMessage, onForkAtMessage, forkingMessageId, showThinking, readOnly, getConnectionDecision } = useMessageList()
  const connectionCardParts = React.useMemo(() => connectionCardPartIds(items, getConnectionDecision), [items, getConnectionDecision])
  const lastItem = items[items.length - 1]
  // Branch/revert must target a real server-side message id. Synthetic
  // client-side messages (e.g. session errors) don't exist on the server and
  // silently corrupt fork/revert boundaries.
  const lastRealItem = items.findLast((item) => !isSessionErrorMessage(item.message))
  const isLiveGroup = isStreaming && isLastGroup

  if (!lastItem || isMessageEmptyGroup(items)) {
    return null;
  }

  const renderableItems = getRenderableMessages(items)
  const lastTextMessage = getLastTextPart(lastItem.message)
  const mcpAppParts = collectMcpAppParts(items)

  // Leading messages without prose (tool/reasoning steps) render inline and
  // rely on the transcript's one scroll container. Tool activity must never
  // create a nested scrollbar while it grows.
  let stepCount = 0
  while (stepCount < items.length && !getRenderableMessage(items[stepCount].message)) {
    stepCount += 1
  }
  let stepItems = items.slice(0, stepCount)
  let proseItems = items.slice(stepCount)
  // OpenCode delivers a whole turn as one assistant message with steps and
  // the answer interleaved in its parts. Split the first prose message so
  // its leading steps fold with the rest instead of pinning the run open.
  const firstProse = proseItems[0]
  if (firstProse && firstProse.message.role === "assistant" && !isSessionErrorMessage(firstProse.message)) {
    const split = splitTurnAtAnswer(firstProse.message)
    if (split) {
      stepItems = [...stepItems, { index: firstProse.index, message: split.steps }]
      proseItems = [{ index: firstProse.index, message: split.answer }, ...proseItems.slice(1)]
    }
  }
  // How long the turn spent working, from the first step to when the answer
  // finished (or started, for older history without a completed timestamp).
  // Server timestamps, so this survives a reload.
  const stepsStartedAt = stepItems.length > 0 ? getMessageCreated(stepItems[0].message) : null
  const stepsEndedAt = getMessageCompleted(lastItem.message) ?? getMessageCreated(lastItem.message)

  // The answer message's own thinking belongs to the work, not the answer, so
  // a collapsed run shows it and the message below renders text only.
  const proseReasoning = proseItems.flatMap((item) =>
    item.message.role === "assistant" && !isSessionErrorMessage(item.message)
      ? getAssistantRenderGroups(item.message.parts, showThinking).flatMap((group, groupIndex) =>
        group.kind === "reasoning"
          ? [{ key: JSON.stringify(["reasoning", item.message.id, groupIndex]), text: group.text, isStreaming: group.isStreaming }]
          : []
      )
      : []
  )
  // An aggregate line counts each call it absorbed: it reads as one row but
  // stands for that much work, and folding should key off the work done.
  const stepRowCount =
    stepItems.reduce(
      (total, item) =>
        total +
        (item.message.role === "assistant" && !isSessionErrorMessage(item.message)
          ? getAssistantRenderGroups(item.message.parts, showThinking).reduce(
            (rows, group) => rows + (group.kind === "tool-aggregate" ? group.parts.length + group.thoughts.length : 1),
            0
          )
          : 1),
      0
    ) + proseReasoning.length
  const stepRunLabel =
    stepsStartedAt !== null && stepsEndedAt !== null && stepsEndedAt > stepsStartedAt
      ? `Worked for ${formatToolCallDuration(stepsEndedAt - stepsStartedAt)}`
      : stepRowCount === 1
        ? "1 step"
        : `${stepRowCount} steps`
  // A short finished run reads fine as a list, so only long ones fold away.
  const collapseSteps =
    !isLiveGroup && stepItems.length > 0 && stepRowCount > COLLAPSED_STEP_RUN_MIN_ROWS
  const foldedReasoning = collapseSteps
    ? proseReasoning.map((reasoning) => (
      <Message
        key={`folded-reasoning-${reasoning.key}`}
        className="mx-auto flex w-full max-w-3xl flex-col items-start gap-2 px-2 md:px-10"
      >
        <ReasoningBlock disclosureKey={reasoning.key} text={reasoning.text} isStreaming={reasoning.isStreaming} />
      </Message>
    ))
    : []

  const renderItem = (item: UIMessageWithIndex, groupIndex: number, hideReasoning?: boolean) => {
    const isLastMessage = isLastGroup && item.index === lastItem.index

    return (
      <div key={item.message.id}>
        <MessageComponent
          message={item.message}
          isLastMessage={isLastMessage}
          isStreaming={isLastMessage && isStreaming}
          isLastStep={groupIndex === items.length - 1}
          hideReasoning={hideReasoning}
        />
      </div>
    )
  }

  // Consecutive step messages that contain nothing but command/edit/read/
  // search tool calls merge into one aggregate line (Paper "Recurring
  // actions"); any prose, reasoning, or other tool breaks the run.
  const renderItems = (slice: UIMessageWithIndex[], offset: number, hideReasoning?: boolean) => {
    const nodes: React.ReactNode[] = []
    let run: { parts: AnyToolPart[]; key: string } | null = null
    const flush = () => {
      if (!run) return
      nodes.push(
        <div key={`aggregate-${run.key}`}>
          <Message className="mx-auto flex w-full max-w-3xl flex-col items-start gap-2 px-2 md:px-10">
            <ToolAggregateGroup messageId={run.key} parts={run.parts} className="w-full" />
          </Message>
        </div>
      )
      run = null
    }
    slice.forEach((item, sliceIndex) => {
      const aggregateParts =
        item.message.role === "assistant" && !isSessionErrorMessage(item.message)
          ? getAggregateOnlyParts(item.message, showThinking)
          : null
      if (aggregateParts) {
        if (!run) run = { parts: [], key: item.message.id }
        run.parts.push(...aggregateParts)
        return
      }
      flush()
      nodes.push(renderItem(item, offset + sliceIndex, hideReasoning))
    })
    flush()
    return nodes
  }

  return (
    <DevProfiler id={`MessageGroup:${lastItem.message.id}`}>
      <ConnectionCardPartsContext.Provider value={connectionCardParts}>
      <div className="flex flex-col gap-2 group/message-group">
      {/* The scroll area keeps the same 8px rhythm the parts inside a single
          message use, so a step row is spaced identically whether or not a
          message boundary happens to fall between it and the previous row. */}
      {stepItems.length > 0 ? (
        collapseSteps ? (
          <CompletedStepRun label={stepRunLabel}>
            <div className="flex flex-col gap-2">
              {renderItems(stepItems, 0)}
              {foldedReasoning}
            </div>
          </CompletedStepRun>
        ) : (
          <div data-live-steps="" className="flex flex-col gap-2">
            {renderItems(stepItems, 0)}
          </div>
        )
      ) : null}
      {mcpAppParts.map((part) => (
        <Message
          key={`mcp-app-${part.toolCallId}`}
          className="mx-auto flex w-full max-w-3xl flex-col px-2 empty:hidden md:px-10"
        >
          <McpAppFrame part={part} />
        </Message>
      ))}
      {renderItems(proseItems, stepItems.length, collapseSteps)}
      {lastTextMessage && !isStreaming && (
        <div className={cn("mx-auto flex w-full max-w-3xl flex-wrap items-center gap-2 px-2 transition-opacity duration-150 group-hover/message-group:opacity-100 max-lg:opacity-100 pointer-coarse:opacity-100 md:px-8", forkingMessageId && forkingMessageId === lastRealItem?.message.id ? "opacity-100" : "opacity-0")}>
          <MessageActions className="flex gap-0">
            <CopyMessageButton messages={renderableItems.map((item) => item.message)} />
            {lastRealItem ? (
              <>
                <MessageAction tooltip={forkingMessageId === lastRealItem.message.id ? "Branching..." : "Branch in new chat"}>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={forkingMessageId === lastRealItem.message.id ? "Branching..." : "Branch in new chat"}
                    aria-busy={forkingMessageId === lastRealItem.message.id || undefined}
                    disabled={Boolean(forkingMessageId)}
                    onClick={() => onForkAtMessage(lastRealItem.message.id)}
                  >
                    {forkingMessageId === lastRealItem.message.id ? <LoaderCircle className="motion-safe:animate-spin" /> : <Split className="rotate-90" />}
                  </Button>
                </MessageAction>
                {forkingMessageId === lastRealItem.message.id ? <span role="status" className="sr-only">Branching...</span> : null}
                <MessageAction tooltip="Revert">
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Revert"
                    disabled={readOnly}
                    onClick={() => onRevertToUserMessage(lastRealItem.message.id)}
                  >
                    <Undo2 />
                  </Button>
                </MessageAction>
              </>
            ) : null}
          </MessageActions>
          <MessageTimestamp message={lastItem.message} />
          {/* <MessageSources messages={items.map((item) => item.message)} /> */}
        </div>
      )}
      </div>
      </ConnectionCardPartsContext.Provider>
    </DevProfiler>
  )
}

function sameMessageGroupProps(left: AssistantMessageGroupProps, right: AssistantMessageGroupProps): boolean {
  return left.isLastGroup === right.isLastGroup
    && left.isStreaming === right.isStreaming
    && left.items.length === right.items.length
    && left.items.every((item, index) => (
      item.index === right.items[index]?.index
      && item.message === right.items[index]?.message
    ))
}

const MemoizedMessageGroup = React.memo(MessageGroup, sameMessageGroupProps)

type StandaloneMessageProps = {
  message: UIMessage
  isLastMessage: boolean
  isStreaming: boolean
  isLastStep: boolean
}

const StandaloneMessage = React.memo(function StandaloneMessage(props: StandaloneMessageProps) {
  return <MessageComponent {...props} />
})

/**
 * Liveness of the run behind this transcript, derived from the workspace
 * sync layer's continuous status revalidation. While `degraded` is true the
 * busy state cannot be confirmed, so working indicators must stop ticking.
 */
export interface RunSyncHealth {
  degraded: boolean
  lastConfirmedAt: number | null
}

interface MessageListProps {
  messages: UIMessage[]
  messageIdReplacements?: ReadonlyMap<string, string>
  status: ThreadStatus
  activityStatus: SessionActivityStatus
  retryStatus?: RetryStatus | null
  syncHealth?: RunSyncHealth
  viewport?: MessageListViewport
}

export function shouldShowMessageListLoading(
  status: ThreadStatus,
  messageCount: number,
  hasVisibleToolActivity = false,
) {
  if (hasVisibleToolActivity) return false
  return status === "streaming" || (status === "submitted" && messageCount > 0)
}

export function shouldShowRunReconnecting(status: ThreadStatus, syncDegraded: boolean) {
  if (!syncDegraded) return false
  return status === "submitted" || status === "streaming" || status === "retrying"
}

export function MessageList({ messages, messageIdReplacements, status, activityStatus, retryStatus, syncHealth, viewport }: MessageListProps) {
  const { workspaceId, sessionId } = useMessageList()
  const workspace = useWorkspaceMaybe()
  const tasks = React.useMemo(() => activeDelegatedTasks(messages), [messages])
  const [observedAt] = React.useState(() => Date.now())
  const lastProgressAt = useSessionActivityStore((state) => {
    const records = state.recordsByWorkspaceId[workspaceId]
    const own = records?.[sessionId]
    return lastTaskProgressAt(Math.max(own?.runStartedAt || observedAt, own?.lastProgressAt ?? 0), tasks, records)
  })
  const childBlocked = useSessionActivityStore((state) => tasks.some((part) => {
    const id = taskChildSessionId(part)
    const child = id ? state.recordsByWorkspaceId[workspaceId]?.[id] : undefined
    return (child?.waitingPermissionIds.length ?? 0) > 0 || (child?.waitingQuestionIds.length ?? 0) > 0
      || child?.compacting || child?.retrying
  }))
  const isStreaming = status === "streaming" || status === "retrying"
  const runActive = status === "streaming" || status === "retrying"
  const syncDegraded = syncHealth?.degraded === true
  const activityActive = runActive || tasks.length > 0
  const runStartedAtRef = React.useRef<number | null>(null)
  const [runElapsedSeconds, setRunElapsedSeconds] = React.useState(0)
  // Anchor the counter to the user message that started the run (server
  // timestamp), so switching sessions and back doesn't reset it to 0 on
  // remount. Optimistic messages without metadata fall back to first-mount
  // wall clock.
  const runStartedAt = React.useMemo(() => {
    if (!runActive) return null
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index]
      if (message && message.role === "user") return getMessageCreated(message)
    }
    return null
  }, [messages, runActive])
  React.useEffect(() => {
    if (!activityActive) {
      runStartedAtRef.current = null
      setRunElapsedSeconds(0)
      return
    }
    if (runStartedAt !== null) runStartedAtRef.current = runStartedAt
    else if (runStartedAtRef.current === null) runStartedAtRef.current = Date.now()
    // While liveness is unconfirmed the counter must not tick: elapsed time
    // is only presented as work while something is validating that work is
    // still happening. The anchor is kept, so a confirmed recovery resumes
    // the true task age instead of restarting at zero.
    if (syncDegraded) return
    const updateElapsed = () => {
      const startedAt = runStartedAtRef.current
      if (startedAt !== null) setRunElapsedSeconds(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)))
    }
    updateElapsed()
    const interval = window.setInterval(updateElapsed, 1000)
    return () => window.clearInterval(interval)
  }, [activityActive, runStartedAt, syncDegraded])
  const latestUserMessageId = React.useMemo(() => messages.findLast((message) => message.role === "user")?.id, [messages])
  const items = React.useMemo(() => groupMessages(messages, status), [messages, status]);
  const error = useSessionErrorMessage();
  const hasSessionErrorMessage = React.useMemo(() => messages.some(isSessionErrorMessage), [messages])
  const latestAssistantToolParts = React.useMemo(
    () => collectLatestAssistantToolParts(messages),
    [messages],
  )
  // Delegated task rows may be above newer messages; keep the run footer visible.
  const hasVisibleToolActivity = latestAssistantToolParts.some((part) => !isTaskToolPart(part) && isToolPartInFlight(part))
  const waiting = activityStatus === "waiting" || activityStatus === "compacting" || childBlocked
  const showReconnecting = !waiting && !retryStatus && shouldShowRunReconnecting(status, syncDegraded)
  const noNewActivity = hasNoNewActivity({
    active: activityActive && activityStatus !== "error", waiting, retrying: status === "retrying" || Boolean(retryStatus),
    disconnected: syncDegraded, lastProgressAt, now: Date.now(),
  })
  const showLoading = !waiting && !noNewActivity && !showReconnecting
    && shouldShowMessageListLoading(status, messages.length, hasVisibleToolActivity)
  const baseUrl = workspace?.opencodeBaseUrl
  React.useEffect(() => {
    if (!noNewActivity || !baseUrl) return
    // Revalidate existing state only. Silence never aborts or resubmits work.
    void revalidateWorkspaceSessionSync({ workspaceId, baseUrl })
  }, [noNewActivity, workspaceId, sessionId, baseUrl])
  const currentToolCallIds = React.useMemo(
    () => new Set(latestAssistantToolParts.map((part) => part.toolCallId)),
    [latestAssistantToolParts],
  )

  return (
    <ParentRunActiveContext.Provider value={runActive}>
    <CurrentToolLifecycleProvider
      activityStatus={activityStatus}
      currentToolCallIds={currentToolCallIds}
    >
      <ProgressiveMessageList
        groups={items}
        groupKeyReplacements={messageIdReplacements}
        priorityMessageId={latestUserMessageId}
        viewport={viewport}
        className="@container/message-list"
        getGroupKey={(item) => isMessageGroup(item) ? item.messages[0]?.message.id ?? "empty-assistant-group" : item.message.id}
        getMessageIds={(item) => isMessageGroup(item) ? item.messages.flatMap(({ message }) => [message.id, `${message.id}:steps`]) : [item.message.id]}
        header={messages.length === 0 && <TaskSuggestions className="mx-auto w-full max-w-3xl shrink-0 px-3 pb-3 md:px-5 md:pb-5 grow" />}
        renderGroup={(item) => {
        if (isMessageGroup(item)) {
          return (
            <MemoizedMessageGroup
              key={item.messages[0]?.message.id ?? "empty-assistant-group"}
              items={item.messages}
              isLastGroup={item.messages.at(-1)?.index === messages.length - 1}
              isStreaming={isStreaming && item.messages.at(-1)?.index === messages.length - 1}
            />
          )
        }

        const isLastMessage = item.index === messages.length - 1
        const isLastStep =
          !messages[item.index + 1] || messages[item.index + 1].role !== item.message.role

        return (
          <StandaloneMessage
            key={item.message.id}
            message={item.message}
            isLastMessage={isLastMessage}
            isStreaming={isLastMessage && isStreaming}
            isLastStep={isLastStep}
          />
        )
        }}
      >
        {showLoading && <LoadingMessage elapsedSeconds={runElapsedSeconds} starting={status === "submitted"} />}
        {showReconnecting && <ReconnectingMessage lastConfirmedAt={syncHealth?.lastConfirmedAt ?? null} />}
        {retryStatus ? <RetryMessage status={retryStatus} /> : null}
        {error && !hasSessionErrorMessage ? <ErrorMessage error={error} /> : null}
      </ProgressiveMessageList>
    </CurrentToolLifecycleProvider>
    </ParentRunActiveContext.Provider>
  )
}
