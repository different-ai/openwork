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
import { sessionErrorPresentationFromUIMessage } from "@/react-app/domains/session/sync/session-error"
import { ApplyPatchTool } from "@/components/tools/apply-patch"
import { BashTool } from "@/components/tools/bash"
import { EditTool } from "@/components/tools/edit"
import { EnvVarRequestTool } from "@/components/tools/env-var-request"
import { ReadFileTool, WriteFileTool } from "@/components/tools/file"
import { GlobTool } from "@/components/tools/glob"
import { GrepTool } from "@/components/tools/grep"
import { LspTool } from "@/components/tools/lsp"
import {
  isAutomationProposalToolPart,
  OpenWorkAutomationProposalTool,
} from "@/components/tools/openwork-automation-proposal"
import { OpenWorkSessionCreateTool } from "@/components/tools/openwork-session-create"
import { QuestionTool } from "@/components/tools/question"
import { SkillTool } from "@/components/tools/skill"
import { TodoWriteTool } from "@/components/tools/todowrite"
import { WebfetchTool } from "@/components/tools/webfetch"
import { WebsearchTool } from "@/components/tools/websearch"
import { useMessageList, useSessionErrorMessage } from "@/components/chat/message-list-provider"
import { TaskSuggestions } from "@/components/chat/task-suggestions"
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
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
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
import { hasPreservedMcpAppResult, McpAppFrame } from "@/components/chat/mcp-app-frame"
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
  isEnvVarRequestToolPart,
  isGlobToolPart,
  isGrepToolPart,
  isLspToolPart,
  isQuestionToolPart,
  isReadToolPart,
  isSkillToolPart,
  isTaskToolPart,
  isTodoWriteToolPart,
  isWebFetchToolPart,
  isWebSearchToolPart,
  isWriteToolPart,
} from "@/lib/build-in-tools"
import type { ThreadStatus } from "@/lib/messages"
import type { SessionActivityStatus } from "@/react-app/domains/session/status/session-activity-store"
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

const ToolMessageInner = ({ part }: ToolMessageProps) => {
  const { connectorIdentities, onMcpReconnect, onMcpReopenAuthorization, onMcpRetry } = useMessageList()
  const resolveLifecycle = useCurrentToolLifecycleResolver()
  const lifecycle = resolveLifecycle(part.toolCallId, isToolPartInFlight(part))

  if (lifecycle === "waiting") {
    return (
      <div
        className="flex items-start gap-2 rounded-md border border-amber-7 bg-amber-2 px-3 py-2 text-sm text-amber-12"
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

  if (lifecycle === "interrupted") {
    return (
      <div
        className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
        data-tool-lifecycle="interrupted"
        role="alert"
      >
        <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        <div>
          <div className="font-medium">Task interrupted</div>
          <div className="text-xs text-destructive/80">This step stopped before it finished. Retry to continue.</div>
        </div>
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

  if (isEnvVarRequestToolPart(part)) {
    return <EnvVarRequestTool part={part} />
  }

  if (part.type === "dynamic-tool" && part.toolName === "openwork_session_create") {
    return <OpenWorkSessionCreateTool part={part} />
  }

  if (part.type === "dynamic-tool" && isAutomationProposalToolPart(part)) {
    return <OpenWorkAutomationProposalTool part={part} />
  }

  if (isTaskToolPart(part)) {
    return <SubagentRunLine part={part} />
  }

  // Failed calls use the same sentence line with the "failures are
  // instructions" treatment (inline Reconnect/Retry).
  if (part.type === "dynamic-tool") {
    return (
      <CapabilityCallLine
        part={part}
        connector={resolveConnectorToolIdentity(part, connectorIdentities)}
        onReconnect={onMcpReconnect}
        onReopenAuthorization={onMcpReopenAuthorization}
        onRetry={onMcpRetry}
      />
    )
  }

  return (
    <Tool
      toolPart={part}
      onReconnect={onMcpReconnect}
      onReopenAuthorization={onMcpReopenAuthorization}
      onRetry={onMcpRetry}
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
                  <ToolAggregateGroup parts={group.parts} thoughts={group.thoughts} />
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

// Bare URL, excluding trailing punctuation that usually ends a sentence.
const PLAIN_URL_RE = /https?:\/\/[^\s<>"')\]]+[^\s<>"')\].,;:!?]/g

/** User bubbles are plain text, so bare https:// URLs need explicit anchors. */
function renderPlainTextWithLinks(text: string, highlightQuery: string | undefined, keyPrefix: string) {
  const nodes: React.ReactNode[] = []
  let cursor = 0
  for (const match of text.matchAll(PLAIN_URL_RE)) {
    const start = match.index
    const url = match[0]
    if (start > cursor) {
      nodes.push(
        <React.Fragment key={`${keyPrefix}:pre:${cursor}`}>
          {renderPlainTextWithSearchHighlights(text.slice(cursor, start), highlightQuery, `${keyPrefix}:pre:${cursor}`)}
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
  if (nodes.length === 0) return renderPlainTextWithSearchHighlights(text, highlightQuery, keyPrefix)
  if (cursor < text.length) {
    nodes.push(
      <React.Fragment key={`${keyPrefix}:post:${cursor}`}>
        {renderPlainTextWithSearchHighlights(text.slice(cursor), highlightQuery, `${keyPrefix}:post:${cursor}`)}
      </React.Fragment>
    )
  }
  return nodes
}

function renderUserTextWithSkillChips(text: string, highlightQuery: string | undefined) {
  if (!USER_SKILL_TOKEN_RE.test(text)) return renderPlainTextWithLinks(text, highlightQuery, "text")
  let offset = 0
  return text.split(USER_SKILL_TOKEN_RE).map((segment) => {
    const key = `${offset}:${segment}`
    offset += segment.length
    const skillMatch = segment.match(/^(?:Load )?\[skill ([^\]]+)\](?: and follow its instructions\.)?$/)
    if (skillMatch?.[1]) return <UserSkillChip key={key} name={skillMatch[1]} />
    return <React.Fragment key={key}>{renderPlainTextWithLinks(segment, highlightQuery, key)}</React.Fragment>
  })
}

const UserMessage = React.memo(
  ({ message, isStreaming }: UserMessageProps) => {
    const { onRevertToUserMessage, onForkAtMessage, onEditUserMessage, highlightQuery } = useMessageList()
    const messageText = React.useMemo(() => getMessagesText([message]), [message])
    const inlineParts = React.useMemo(
      () => message.parts.filter((part) => (part.type === "text" && Boolean(part.text)) || isFileUIPart(part)),
      [message.parts],
    )
    const hasContent = inlineParts.length > 0

    return (
      <Message
        className="mx-auto flex w-full max-w-3xl flex-col items-end gap-2 px-2 md:px-10"
        data-message-id={message.id}
        data-message-role={message.role}
      >
        <ContextMenu>
          <ContextMenuTrigger
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
                  >
                    {inlineParts.map((part, index) => {
                      if (part.type === "text") {
                        return (
                          <span key={`text-${index}`} className="whitespace-pre-wrap">
                            {renderUserTextWithSkillChips(part.text, highlightQuery)}
                          </span>
                        )
                      }
                      if (isFileUIPart(part)) {
                        return (
                          <span
                            key={`file-${part.url}-${index}`}
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
                      "flex items-center gap-0 opacity-0 transition-opacity duration-150 group-hover:opacity-100 max-lg:opacity-100 pointer-coarse:opacity-100"
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
                          onClick={() => onEditUserMessage(message.id, messageText)}
                        >
                          <Pencil />
                        </Button>
                      </MessageAction>
                    ) : null}
                    <MessageAction tooltip="Branch in new chat">
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label="Branch in new chat"
                        onClick={() => onForkAtMessage(message.id)}
                      >
                        <Split className="rotate-90" />
                      </Button>
                    </MessageAction>
                    <MessageAction tooltip="Revert">
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label="Revert"
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
          <ContextMenuContent className="w-56">
            {messageText ? (
              <ContextMenuItem onClick={() => onEditUserMessage(message.id, messageText)}>
                <Pencil className="size-4" />
                Edit message
              </ContextMenuItem>
            ) : null}
            {messageText ? (
              <ContextMenuItem onClick={() => void navigator.clipboard.writeText(messageText)}>
                <Copy className="size-4" />
                Copy
              </ContextMenuItem>
            ) : null}
            <ContextMenuItem onClick={() => onForkAtMessage(message.id)}>
              <Split className="size-4 rotate-90" />
              Branch in new chat
            </ContextMenuItem>
            <ContextMenuItem onClick={() => onRevertToUserMessage(message.id)}>
              <Undo2 className="size-4" />
              Revert
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
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
          resumePrompt={presentation?.recoveryPrompt}
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

const LoadingMessage = React.memo(({ elapsedSeconds }: { elapsedSeconds: number }) => (
    <Message className="mx-auto flex w-full max-w-3xl flex-col items-start gap-2 px-2 md:px-10">
      <div data-loading-message="working" className="py-1 text-sm text-muted-foreground">
        <span className="ow-text-shimmer tabular-nums">Working {formatElapsedSeconds(elapsedSeconds)}</span>
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
  /** Set only for interrupted runs (aborted / provider timeout) that can resume. */
  resumePrompt?: string | null
}

function ErrorMessage({ error, resumePrompt }: ErrorMessageProps) {
  const { onResumeInterrupted } = useMessageList()

  // A resumable interruption is a pause, not a failure: it renders as a
  // quiet status line (like "Working 12s"), with Resume as the emphasis.
  if (resumePrompt && onResumeInterrupted) {
    return (
      <Message className="not-prose mx-auto flex w-full max-w-3xl flex-col items-start gap-2 px-2 md:px-10">
        <div
          data-testid="session-error-interrupted"
          className="flex min-w-0 items-center gap-2 py-1 text-sm text-muted-foreground"
        >
          <CirclePause aria-hidden="true" className="size-4 shrink-0" />
          <span className="min-w-0 truncate">{error}</span>
          <span aria-hidden="true" className="text-muted-foreground/60">·</span>
          <button
            type="button"
            data-testid="session-error-resume"
            onClick={() => onResumeInterrupted(resumePrompt)}
            className="shrink-0 cursor-pointer font-medium text-foreground underline-offset-2 transition-colors hover:underline"
          >
            {t("session.resume_interrupted")}
          </button>
        </div>
      </Message>
    )
  }

  return (
    <Message className="not-prose mx-auto flex w-full max-w-3xl flex-col items-start gap-2 px-0 md:px-10">
      <div className="group flex w-full flex-col items-start gap-0">
        <div className="flex min-w-0 flex-1 flex-col gap-1.5 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm">
          <div className="flex flex-row items-start gap-2">
            <AlertTriangle aria-hidden="true" size={16} className="mt-0.5 shrink-0 text-destructive" />
            <p className="whitespace-pre-wrap text-destructive">{error}</p>
          </div>
        </div>
      </div>
    </Message>
  )
}

interface RetryMessageProps {
  status: RetryStatus
}

function RetryActionButton(props: { link: string; label: string }) {
  return (
    <Button
      variant="outline"
      size="sm"
      className="h-7 border-amber-500/70 bg-amber-50 text-xs text-amber-950 hover:bg-amber-100"
      onClick={() => void openDesktopUrl(props.link)}
    >
      {props.label}
    </Button>
  )
}

const RetryMessage = React.memo(({ status }: RetryMessageProps) => {
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

  return (
    <Message className="not-prose mx-auto flex w-full max-w-3xl flex-col items-start gap-2 px-0 md:px-10">
      <div className="group flex w-full flex-col items-start gap-0">
        <div className="text-foreground flex min-w-0 flex-1 flex-col gap-2 rounded-lg border-2 border-amber-300 bg-amber-300/20 px-3 py-2">
          <div className="flex items-start gap-2">
            <LoaderCircle size={16} className="mt-0.5 shrink-0 animate-spin text-amber-700" />
            <div className="min-w-0 space-y-1">
              <p className="whitespace-pre-wrap text-sm font-medium text-amber-900">{status.message}</p>
              <p className="text-xs text-amber-800">{info}</p>
            </div>
          </div>
          {action ? (
            <div className="ml-6 space-y-1 border-t border-amber-400/60 pt-2">
              <p className="text-xs font-medium text-amber-950">{action.title}</p>
              <p className="text-xs text-amber-900">{action.message}</p>
              {action.link ? (
                <RetryActionButton link={action.link} label={action.label} />
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </Message>
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
  const { onRevertToUserMessage, onForkAtMessage, showThinking } = useMessageList()
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
          ? [{ key: `${item.message.id}-${groupIndex}`, text: group.text, isStreaming: group.isStreaming }]
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
        <ReasoningBlock text={reasoning.text} isStreaming={reasoning.isStreaming} />
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
            <ToolAggregateGroup parts={run.parts} className="w-full" />
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
        <div className="mx-auto flex w-full max-w-3xl flex-wrap items-center gap-2 px-2 opacity-0 transition-opacity duration-150 group-hover/message-group:opacity-100 max-lg:opacity-100 pointer-coarse:opacity-100 md:px-8">
          <MessageActions className="flex gap-0">
            <CopyMessageButton messages={renderableItems.map((item) => item.message)} />
            {lastRealItem ? (
              <>
                <MessageAction tooltip="Branch in new chat">
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Branch in new chat"
                    onClick={() => onForkAtMessage(lastRealItem.message.id)}
                  >
                    <Split className="rotate-90" />
                  </Button>
                </MessageAction>
                <MessageAction tooltip="Revert">
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Revert"
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
  status: ThreadStatus
  activityStatus: SessionActivityStatus
  retryStatus?: RetryStatus | null
  syncHealth?: RunSyncHealth
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

export function MessageList({ messages, status, activityStatus, retryStatus, syncHealth }: MessageListProps) {
  const isStreaming = status === "streaming" || status === "retrying"
  const runActive = status === "submitted" || status === "streaming" || status === "retrying"
  const syncDegraded = syncHealth?.degraded === true
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
    if (!runActive) {
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
  }, [runActive, runStartedAt, syncDegraded])
  const items = React.useMemo(() => groupMessages(messages, status), [messages, status]);
  const error = useSessionErrorMessage();
  const hasSessionErrorMessage = React.useMemo(() => messages.some(isSessionErrorMessage), [messages])
  const latestAssistantToolParts = React.useMemo(
    () => collectLatestAssistantToolParts(messages),
    [messages],
  )
  const hasVisibleToolActivity = latestAssistantToolParts.some(isToolPartInFlight)
  const showReconnecting = shouldShowRunReconnecting(status, syncDegraded)
  const showLoading = !showReconnecting && shouldShowMessageListLoading(status, messages.length, hasVisibleToolActivity)
  const currentToolCallIds = React.useMemo(
    () => new Set(latestAssistantToolParts.map((part) => part.toolCallId)),
    [latestAssistantToolParts],
  )

  return (
    <CurrentToolLifecycleProvider
      activityStatus={activityStatus}
      currentToolCallIds={currentToolCallIds}
    >
      <div className={cn("flex flex-col gap-2 @container/message-list")}>
        {messages.length === 0 && <TaskSuggestions className="mx-auto w-full max-w-3xl shrink-0 px-3 pb-3 md:px-5 md:pb-5 grow" />}

        {items.map((item) => {
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
        })}

        {showLoading && <LoadingMessage elapsedSeconds={runElapsedSeconds} />}
        {showReconnecting && <ReconnectingMessage lastConfirmedAt={syncHealth?.lastConfirmedAt ?? null} />}
        {retryStatus ? <RetryMessage status={retryStatus} /> : null}
        {error && !hasSessionErrorMessage ? <ErrorMessage error={error} /> : null}
      </div>
    </CurrentToolLifecycleProvider>
  )
}
