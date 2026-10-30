"use memo";

import { appBuildActivity, appBuildInProgress, appCreationRuns } from "@/react-app/domains/apps/app-creation-progress"
import { BuiltAppPreviewSync } from "@/react-app/domains/apps/built-app-chat-preview"
import { builtAppSummary } from "@/react-app/domains/apps/built-mcp-app-model"
import { AppBuilderStep } from "./app-builder-step"
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
  isToolUIPart,
  ToolUIPart,
  type FileUIPart,
  type UIMessage,
} from "ai"
import type { SessionStatus } from "@opencode-ai/sdk/v2/client"
import { openDesktopUrl, revealDesktopItemInDir } from "@/app/lib/desktop"
import { isElectronRuntime } from "@/app/lib/runtime-env"
import { SYNTHETIC_SESSION_ERROR_MESSAGE_PREFIX } from "@/app/types"
import { t } from "@/i18n"
import { markFeatureUsed } from "@/app/lib/den"
import { useOpenTargets } from "@/lib/target-provider"
import { openTargetFromUrl } from "@/react-app/domains/session/artifacts/open-target"
import { presentOpencodeSessionError, sessionErrorPresentationFromUIMessage } from "@/react-app/domains/session/sync/session-error"
import { TaskRecovery } from "./task-recovery"
import { BackgroundTaskNotice, BackgroundTasksLabel, BackgroundTasksMessage, SubagentNoticeRow, backgroundShellNoticeFromMessage, subagentNoticeFromMessage } from "./background-tasks"
import { sessionBackgroundShells, useBackgroundShellStore, type BackgroundShell } from "@/react-app/domains/session/status/background-shell-store"
import { messageAutoAccessWall } from "@/app/lib/inference-access"
import { AutoAccessNotice } from "@/react-app/domains/cloud/auto-access-ui"
import { OpenWorkModelsLimitCard } from "@/react-app/domains/cloud/usage-limit-card"
import type { OpenWorkModelsLimit } from "@/react-app/domains/cloud/usage-limit-state"
import { rejectedRecoveryFromMessage } from "@/react-app/domains/session/sync/rejected-turn"
import { replyModelLabel, replyModelProvider } from "@/react-app/domains/session/sync/reply-model"
import { useLiveReplyModel } from "@/components/chat/live-reply-model-store"
import { ProviderIcon } from "@/react-app/design-system/provider-icon"
import { openAlternativeModelPicker } from "@/app/lib/inference-access"
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
import { useOrgFeature } from "@/react-app/domains/cloud/use-org-feature"
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
import { AttachmentFileChip, ComposerBadgeChip, ComposerPillChip, PastedTextChip } from "@/components/chat/composer-pill"
import { agentBadge, fileMentionBadge } from "@/react-app/domains/session/surface/composer/composer-chips"
import { isChatAttachmentUrl } from "@/react-app/domains/session/sync/attachment-file-part"
import { readComposerPill, splitComposerPillText } from "@/react-app/domains/session/surface/composer/composer-pills"
import { Image } from "@/components/ui/image"
import {
  Message,
  MessageAction,
  MessageActions,
  MessageContent,
} from "@/components/ui/message"
import { Tool } from "@/components/ui/tool"
import { CapabilityCallLine } from "@/components/chat/capability-call-line"
import { CodeModeTool, isSilentCodeModePart } from "@/components/chat/code-mode-tool"
import { CreatedSkillCard, CreatedSkillsContext, useCreatedSkills, type CreatedSkillsContextValue } from "@/components/chat/created-skill-card"
import { readCreatedSkillAccess } from "@/components/chat/created-skill-access"
import { collectCreatedSkills, type ConfirmedSkillAccess, type CreatedSkillsModel } from "@/lib/created-skill"
import { openWorkNativeFailure } from "@/lib/openwork-native-activity"
import { LaneChevron, LeadingLane, RailMeta, TextSentenceLine, TrailingChevron } from "@/components/chat/activity-rail"
import { useTextActivityRail } from "@/components/chat/text-activity-rail-store"
import { ConnectionCard } from "@/components/chat/connection-card"
import { CredentialPromptCard } from "@/components/chat/credential-prompt-card"
import { credentialPromptCall } from "@/components/chat/credential-prompt"
import { connectionFromChatToolPart } from "@/components/tools/error-attribution"
import { isReservedConnectionQuestion, type ChatConnectionDecisionBinding } from "@/react-app/domains/session/surface/mcp-chat-reconnect"
import { codeModeToolCalls } from "@/lib/code-mode-tools"
import { codeModeCallsWithResults, remoteThreadStartsInParts } from "@/lib/remote-thread-starts"
import { dedupeRenderedTurnErrors } from "@/react-app/domains/session/sync/transcript-reconcile"
import { builtMcpAppId, hasPreservedMcpAppResult, isNativeConnectionAppLaunch, McpAppFrame } from "@/components/chat/mcp-app-frame"
import { ReasoningBlock } from "@/components/chat/reasoning-block"
import { SubagentRunLine } from "@/components/chat/subagent-run-line"
import { RemoteThreadRunLine } from "@/components/chat/remote-thread-run-line"
import { isRemoteThreadStatusCheck, remoteThreadFromToolPart, type RemoteThreadStart } from "@/lib/remote-session-thread"
import { useRemoteThreadsEnabled, useReviveRemoteThread } from "@/react-app/domains/session/remote-threads/remote-thread-store"
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
import { useShallow } from "zustand/react/shallow"
import { useSessionActivityStore, type SessionActivityStatus, type WaitInterval } from "@/react-app/domains/session/status/session-activity-store"
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
import { groupMessages, isMessageGroup, getLastTextPart, getAggregateOnlyParts, getAssistantRenderGroups, getFileTitle, getMediaBadge, getMessageCompleted, getMessageCreated, getRunStartedAt, getWaitedMs, formatMessageTimestamp, splitTurnAtAnswer, type UIMessageWithIndex, getMessagesText, getSafeFileDownloadUrl, getSafeFileRevealPath } from "./utils"
import type { AnyToolPart } from "@/lib/tool-aggregate"
import { resolveConnectorToolIdentity } from "@/react-app/domains/connections/connector-tool-identity"

const SEARCH_HIGHLIGHT_MARK_CLASS = "rounded px-0.5 bg-amber-4/70 text-current"

/** A finished turn with at least this many step rows folds into one summary line (T1). */
const COLLAPSED_STEP_RUN_MIN_ROWS = 1

const AppCreationPartsContext = React.createContext<ReadonlySet<string>>(new Set())
/**
 * While an App is being built, its panel is the one live
 * thing in the chat: thinking and plain tool rows fold away and the panel
 * shows the latest of them. Approvals, connection cards, questions and
 * sub-agents still show.
 */
const AppPanelLiveContext = React.createContext(false)
const AppPanelFoldContext = React.createContext(false)
/** Remote task rows a folded turn shows below its fold; inside it they render nothing. */
const NO_PINNED_REMOTE_THREADS: ReadonlySet<string> = new Set()
const PinnedRemoteThreadsContext = React.createContext<ReadonlySet<string>>(NO_PINNED_REMOTE_THREADS)
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
  const remoteThreads = useRemoteThreadsEnabled()
  const pinnedRemoteThreads = React.useContext(PinnedRemoteThreadsContext)
  // The agent following up on a task the chat shows makes it run again.
  useReviveRemoteThread(remoteThreads && part.type === "dynamic-tool" ? part : null)
  const parentActive = React.useContext(ParentRunActiveContext)
  const resolveLifecycle = useCurrentToolLifecycleResolver()
  const lifecycle = resolveLifecycle(part.toolCallId, isToolPartInFlight(part))
  const connectionCardParts = React.useContext(ConnectionCardPartsContext)
  const appCreationParts = React.useContext(AppCreationPartsContext)
  const appPanelFold = React.useContext(AppPanelFoldContext)
  const textRail = useTextActivityRail()
  if (appCreationParts.has(part.toolCallId)) return null
  if (part.toolCallId === connectionQuestionToolCallId || isReservedConnectionQuestionPart(part)) return null
  const promptCall = credentialPromptCall(part)
  const remoteStart = remoteThreads && part.type === "dynamic-tool" ? remoteThreadFromToolPart(part) : null
  const calls = part.type === "dynamic-tool" ? codeModeToolCalls(part) : null
  const remoteStarts = remoteThreads && calls && part.type === "dynamic-tool" ? (codeModeCallsWithResults(part) ?? []).flatMap((call) => {
    const start = remoteThreadFromToolPart(call)
    return start ? [{ start, call }] : []
  }) : []
  const foldTool = appPanelFold && lifecycle !== "waiting" && !connectionCardParts.has(part.toolCallId) && !promptCall && !isTaskToolPart(part)
  if (foldTool && !remoteStart && remoteStarts.length === 0) return null

  // Delegated work has its own lifecycle, even after a parent follow-up/error.
  if (isTaskToolPart(part)) return <SubagentRunLine part={part} parentActive={parentActive} />

  // So does a task started on another computer: it reads as a sub-agent.
  if (remoteStart && part.type === "dynamic-tool") {
    return pinnedRemoteThreads.has(part.toolCallId) ? null : <RemoteThreadRunLine start={remoteStart} part={part} />
  }

  if (part.type === "dynamic-tool") {
    if (calls && remoteStarts.length > 0) {
      const started = new Set(remoteStarts.map(({ call }) => call.toolCallId))
      return (
        <div className="flex min-w-0 flex-col gap-1">
          {!foldTool && <CodeModeTool part={part} calls={calls.filter((call) => !started.has(call.toolCallId))} lifecycle={lifecycle} connectors={connectorIdentities} />}
          {promptCall && <CredentialPromptCard part={promptCall} continueToolCallId={part.toolCallId} />}
          {remoteStarts.filter(({ call }) => !pinnedRemoteThreads.has(call.toolCallId))
            .map(({ start, call }) => <RemoteThreadRunLine key={start.key} start={start} part={call} />)}
        </div>
      )
    }
    if (calls) {
      const script = <CodeModeTool part={part} calls={calls} lifecycle={lifecycle} connectors={connectorIdentities} />
      // A key the script's Den call asked for is entered in the host's private field.
      return promptCall ? <>{script}<CredentialPromptCard part={promptCall} continueToolCallId={part.toolCallId} /></> : script
    }
  }

  if (lifecycle === "waiting" && textRail) {
    // Text-first: waiting on the person is one amber sentence; the decision itself sits above the composer (T4).
    return (
      <div className="flex min-h-6.5 items-center text-sm" data-tool-lifecycle="waiting" role="status">
        <TextSentenceLine verb={t("text_activity.waiting_for_you")} tone="waiting" />
      </div>
    )
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

  // A key an agent asked for is entered in the host's private field, never in chat.
  if (part.type === "dynamic-tool" && promptCall) {
    return <CredentialPromptCard part={promptCall} continueToolCallId={part.toolCallId} />
  }

  // Failed calls use the same sentence line with the "failures are
  // instructions" treatment (inline Reconnect/Retry).
  if (part.type === "dynamic-tool") {
    return (
      <CapabilityCallLine
        part={part}
        connector={resolveConnectorToolIdentity(part, connectorIdentities)}
        shimmer={isToolPartInFlight(part)}
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

/**
 * A finished catalog lookup (what OpenWork offers, which Cloud capabilities
 * exist) did no work the person asked for (T2), the same rule Code Mode
 * scripts follow. A lookup that reports a connection to set up stays: that
 * is something the person can act on.
 */
function isSilentAppLookup(part: DynamicToolUIPart): boolean {
  if (part.state !== "output-available") return false
  if (part.toolName === "openwork_context") return true
  const catalogSearch = part.toolName === "search" || part.toolName.endsWith("search_capabilities")
  return catalogSearch && connectionFromChatToolPart(part, { allowDiscovery: true }) === null
}

/**
 * A finished turn folds only when nothing in it needs the person: a failed
 * step stays inline with its fix (T2), and a key, connection or question the
 * agent is waiting on is never hidden behind "Worked for…".
 */
function stepsNeedAttention(items: UIMessageWithIndex[], connectionCards: ReadonlySet<string>): boolean {
  return items.some(({ message }) => message.role === "assistant" && !isSessionErrorMessage(message) && message.parts.some((part) => {
    if (!isToolUIPart(part)) return false
    if (part.state === "output-error") return true
    if (part.type === "dynamic-tool") {
      if (connectionCards.has(part.toolCallId) || credentialPromptCall(part)) return true
      if (openWorkNativeFailure(part)) return true
      if ((codeModeToolCalls(part) ?? []).some((call) => call.state === "output-error" || openWorkNativeFailure(call))) return true
    }
    return isQuestionToolPart(part) && isToolPartInFlight(part)
  }))
}

function withoutSilentSteps(messages: UIMessage[], remoteThreads: boolean): UIMessage[] {
  let changed = false
  const next = messages.flatMap((message) => {
    if (message.role !== "assistant") return [message]
    // With tasks on other computers shown live, the agent's own checks on them are plumbing.
    const parts = message.parts.filter((part) => !(part.type === "dynamic-tool"
      && (isSilentCodeModePart(part) || isSilentAppLookup(part) || remoteThreads && isRemoteThreadStatusCheck(part))))
    if (parts.length === message.parts.length) return [message]
    changed = true
    return parts.length > 0 ? [{ ...message, parts }] : []
  })
  return changed ? next : messages
}

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
  const revealPath = getSafeFileRevealPath(part)
  const isImage = part.mediaType.startsWith("image/") && Boolean(part.url) && !revealPath
  const downloadUrl = getSafeFileDownloadUrl(part)
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

  const actions = downloadUrl || canReveal ? (
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
  ) : null

  if (isImage && tone === "user" && !revealPath) {
    return <ImageAttachmentBadge src={part.url} alt={title} />
  }

  if (tone === "user" && revealPath && !isChatAttachmentUrl(part.url)) {
    return (
      <button type="button" className="inline rounded-lg align-middle" onClick={() => openArtifactPath(revealPath)} title={`Open ${title} in Artifacts`}>
        <ComposerBadgeChip badge={fileMentionBadge(revealPath)} className="mx-0" />
      </button>
    )
  }

  if (tone === "user") {
    return (
      <AttachmentFileChip
        filename={title}
        mime={part.mediaType}
        bytes={fileBytes(part)}
        onOpen={revealPath ? () => openArtifactPath(revealPath) : undefined}
        actions={actions}
      />
    )
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
      {actions}
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
    const textRail = useTextActivityRail()
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
              // The answer lines up with the activity rail: the same leading
              // 20px lane the step rows and the "Worked for…" summary use, so
              // the reply's text starts where their labels do instead of 28px
              // to the rail's left (DESIGN.md T1 — one quiet rail).
              return (
                <div key={`text-${index}`} className="flex min-w-0 items-start gap-2">
                  <LeadingLane />
                  <MessageContent
                    className="text-foreground prose w-full min-w-0 flex-1 rounded-lg bg-transparent p-0"
                    markdown
                    sessionReferences
                    githubReferences={textRail}
                    isStreaming={isStreaming}
                    highlightQuery={highlightQuery}
                  >
                    {group.text}
                  </MessageContent>
                </div>
              )
            }

            if (group.kind === "reasoning") {
              return (
                <ReasoningBlock
                  key={`reasoning-${index}`}
                  disclosureKey={JSON.stringify(["reasoning", message.id, index])}
                  text={group.text}
                  isStreaming={group.isStreaming}
                  durationMs={group.durationMs}
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

function isPastedTextPart(part: UIMessage["parts"][number]) {
  if (part.type !== "text") return false
  const metadata = part.providerMetadata?.opencode
  return Boolean(metadata && typeof metadata === "object" && "pastedText" in metadata && metadata.pastedText === true)
}

function fileBytes(part: FileUIPart) {
  const metadata = part.providerMetadata?.opencode
  const bytes = metadata && typeof metadata === "object" && "bytes" in metadata ? metadata.bytes : undefined
  return typeof bytes === "number" ? bytes : undefined
}

/** Agent and file mentions keep their composer badge in the sent message. */
function textPartMentionBadge(part: UIMessage["parts"][number]) {
  if (part.type !== "text") return null
  const metadata = part.providerMetadata?.opencode
  if (!metadata || typeof metadata !== "object") return null
  if ("agentMention" in metadata && typeof metadata.agentMention === "string") return agentBadge(metadata.agentMention)
  if ("fileMention" in metadata && typeof metadata.fileMention === "string") return fileMentionBadge(metadata.fileMention)
  return null
}

/** The pill a sent text part was tagged with in the composer, if any. */
function textPartComposerPill(part: UIMessage["parts"][number]) {
  if (part.type !== "text") return null
  const metadata = part.providerMetadata?.opencode
  return metadata && typeof metadata === "object" && "composerPill" in metadata
    ? readComposerPill(metadata.composerPill)
    : null
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

function renderUserTextWithPills(text: string, highlightQuery: string | undefined, references: SessionReferences | undefined) {
  const segments = splitComposerPillText(text)
  if (segments.length === 1 && typeof segments[0] === "string") return renderPlainTextWithLinks(text, highlightQuery, "text", references)
  let offset = 0
  return segments.map((segment) => {
    const key = `${offset}`
    if (typeof segment !== "string") {
      offset += 1
      return <ComposerPillChip key={`pill:${key}`} pill={segment} />
    }
    offset += segment.length
    return <React.Fragment key={`text:${key}`}>{renderPlainTextWithLinks(segment, highlightQuery, key, references)}</React.Fragment>
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
        {renderUserTextWithPills(text.slice(cursor, start), highlightQuery, references)}
      </React.Fragment>,
      <React.Fragment key={`inline-code:${start}`}>
        {renderUserTextWithPills(text.slice(start, end), highlightQuery, exactId ? references : undefined)}
      </React.Fragment>
    )
    cursor = end
    if (!closing) break
  }
  nodes.push(<React.Fragment key={`prose:${cursor}`}>{renderUserTextWithPills(text.slice(cursor), highlightQuery, references)}</React.Fragment>)
  return nodes
}

function renderUserText(text: string, highlightQuery: string | undefined, references: SessionReferences | undefined) {
  if (!references) return renderUserTextWithPills(text, highlightQuery, undefined)
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
        {renderUserTextWithPills(text.slice(start, end), highlightQuery, undefined)}
      </React.Fragment>
    )
    cursor = end
  }
  nodes.push(<React.Fragment key={`prose:${cursor}`}>{renderUserProse(text.slice(cursor), highlightQuery, references)}</React.Fragment>)
  return nodes
}

const UserMessage = React.memo(
  ({ message, isStreaming }: UserMessageProps) => {
    const { onRevertToUserMessage, onEditUserMessage, highlightQuery, readOnly } = useMessageList()
    const references = useSessionReferencesMaybe()
    const wall = messageAutoAccessWall(message.metadata)
    const { sessionId, workspaceId } = useMessageList()
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
    // Same actions, in the same order, as the buttons below the bubble.
    const menuActions: MenuAction[] = []
    if (messageText) menuActions.push(
      { type: "item", id: "copy", label: "Copy", icon: <Copy className="size-4" />, onSelect: () => navigator.clipboard.writeText(messageText) },
      { type: "item", id: "edit", label: "Edit message", icon: <Pencil className="size-4" />, disabled: readOnly || Boolean(wall), onSelect: () => onEditUserMessage(message.id, messageText) },
    )
    if (!wall) menuActions.push(
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
                className={cn("group flex w-full flex-col items-end gap-1 !select-text", wall && "opacity-50")}
                data-unprocessed={wall ? "true" : undefined}
                style={{ userSelect: "text" }}
              >
                {hasContent ? (
                  <MessageContent
                    className="bg-muted text-foreground max-w-[85%] rounded-3xl px-4 py-2.5 leading-6 sm:max-w-[75%] !select-text not-prose"
                    style={{ userSelect: "text" }}
                    onClick={openLink}
                  >
                    {inlineParts.map((part, index) => {
                      const pill = textPartComposerPill(part)
                      if (pill) return <ComposerPillChip key={`pill-${index}`} pill={pill} />
                      if (part.type === "text" && isPastedTextPart(part)) return <PastedTextChip key={`pasted-${index}`} text={part.text} />
                      const mention = textPartMentionBadge(part)
                      if (mention) return <ComposerBadgeChip key={`mention-${index}`} badge={mention} />
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
                {!isStreaming && !wall && (
                  <MessageActions
                    className="flex items-center gap-0 opacity-0 transition-opacity duration-150 group-hover:opacity-100 max-lg:opacity-100 pointer-coarse:opacity-100"
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
          {wall ? <div className="w-full"><AutoAccessNotice wall={wall} sessionId={sessionId} workspaceId={workspaceId} recovery={rejectedRecoveryFromMessage(message)} /></div> : null}
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
      if (presentation?.autoAccessWall) return <TranscriptAutoAccessNotice wall={presentation.autoAccessWall} />
      const errorMessage = (
        <ErrorMessage
          error={getMessagesText([message]) || "Session failed"}
          description={presentation?.description}
          showDescriptionOnResume={presentation?.kind !== "aborted" && presentation?.kind !== "provider-timeout"}
          resumePrompt={presentation?.recoveryPrompt}
          canRetry={isLastMessage && !isStreaming}
          technicalDetails={presentation?.technicalDetails}
          gatewayConnectUrl={presentation?.kind === "gateway-auth-required" || presentation?.kind === "provider-credentials" ? presentation.connectUrl ?? null : undefined}
          gatewayProviderAuthError={presentation?.kind === "gateway-provider-authentication-failed" || presentation?.kind === "gateway-provider-permission-denied"}
          gatewaySelectionRequired={presentation?.kind === "gateway-selection-required"}
          changeModel={presentation !== null && ["provider-access-denied", "provider-unavailable", "provider-unreachable", "model-unavailable", "rate-limited", "conversation-too-long", "attachment-unsupported"].includes(presentation.kind)}
        />
      )
      if (presentation?.openworkModelsLimit) return <TranscriptOpenWorkModelsLimit limit={presentation.openworkModelsLimit} />
      return errorMessage
    }

    const backgroundShellNotice = backgroundShellNoticeFromMessage(message)
    if (backgroundShellNotice) return <BackgroundTaskNotice message={message} notice={backgroundShellNotice} />
    const subagentNotice = subagentNoticeFromMessage(message)
    if (subagentNotice) return <SubagentNoticeRow message={message} notice={subagentNotice} />

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

/** The organization used its OpenWork Models allowance: one usage-limit card. */
function TranscriptOpenWorkModelsLimit({ limit }: { limit: OpenWorkModelsLimit }) {
  const { sessionId } = useMessageList()
  return <div className="mx-auto w-full max-w-3xl px-2 py-2 md:px-10"><OpenWorkModelsLimitCard limit={limit} sessionId={sessionId} /></div>
}

function TranscriptAutoAccessNotice({ wall }: { wall: NonNullable<ReturnType<typeof messageAutoAccessWall>> }) {
  const { sessionId, workspaceId } = useMessageList()
  return <div className="mx-auto w-full max-w-3xl px-2 md:px-10"><AutoAccessNotice wall={wall} sessionId={sessionId} workspaceId={workspaceId} /></div>
}

MessageComponent.displayName = "MessageComponent"

const NO_BACKGROUND_SHELLS: BackgroundShell[] = []
const NO_WAITS: WaitInterval[] = []

type WorkingModel = { label: string; providerId?: string }

const LoadingMessage = React.memo(({ elapsedSeconds, starting, backgroundShells = NO_BACKGROUND_SHELLS, backgroundStale = false, model = null }: {
  elapsedSeconds: number
  starting: boolean
  /** Feature `liveReplyModel`: the model writing this turn, shown on hover after the timer. */
  model?: WorkingModel | null
  /** Commands left running in the background share this line while the turn runs. */
  backgroundShells?: BackgroundShell[]
  backgroundStale?: boolean
}) => {
  const background = backgroundShells.length > 0 ? (
    <>
      <span aria-hidden="true"> · </span>
      <BackgroundTasksLabel shells={backgroundShells} stale={backgroundStale} shimmer={false} />
    </>
  ) : null
  return (
    <Message className="mx-auto flex w-full max-w-3xl flex-col items-start gap-2 px-2 md:px-10">
      <div role={starting ? "status" : undefined} data-loading-message={starting ? "starting" : "working"} className="group/working py-1 text-sm text-muted-foreground">
        {/* One shimmer sweeps the whole line, so Working and the count move as
            one. A count the connection cannot confirm stays outside it, still. */}
        <span className="ow-text-shimmer tabular-nums">
          {starting ? "Starting…" : `Working ${formatElapsedSeconds(elapsedSeconds)}`}
          {backgroundStale ? null : background}
        </span>
        {backgroundStale ? background : null}
        {/* Hover the Working line to see which model is writing this turn. It
            sits right after the timer, outside the shimmer, on the same line. */}
        {model ? (
          <span
            data-working-model=""
            onMouseEnter={() => markFeatureUsed("liveReplyModel")}
            className="opacity-0 transition-opacity duration-150 ease-out group-hover/working:opacity-100 pointer-coarse:opacity-100 motion-reduce:transition-none"
          >
            <span aria-hidden="true"> · </span>
            <span className="sr-only">{t("session.reply_model_live_prefix")}</span>
            <span className="inline-flex items-center gap-1 align-[-2px]">
              {model.providerId ? <span aria-hidden="true" className="flex size-3 shrink-0 items-center justify-center"><ProviderIcon providerId={model.providerId} size={12} /></span> : null}
              <span>{model.label}</span>
            </span>
          </span>
        ) : null}
      </div>
    </Message>
  )
})

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
  gatewayProviderAuthError?: boolean
  gatewaySelectionRequired?: boolean
  changeModel?: boolean
}

function ErrorMessage({ error, description, showDescriptionOnResume, resumePrompt, canRetry = true, technicalDetails, gatewayConnectUrl, gatewaySelectionRequired, gatewayProviderAuthError, changeModel }: ErrorMessageProps) {
  const { onResumeInterrupted, dispatchAction, sessionId } = useMessageList()
  const gatewayProviderAuthEnabled = useOrgFeature("gatewayProviderAuthErrors")
  const useGatewayProviderAuthCopy = gatewayProviderAuthError && gatewayProviderAuthEnabled
  const selection = error?.includes("gateway_selection_required") ? presentOpencodeSessionError(error) : null
  const displayError = gatewayProviderAuthError && !gatewayProviderAuthEnabled
    ? "Check your model connection"
    : selection?.title ?? error
  const displayDescription = gatewayProviderAuthError && !gatewayProviderAuthEnabled
    ? "Update your connection in model settings."
    : selection?.description ?? description
  const displayDetails = selection?.technicalDetails ?? technicalDetails
  const displayTechnicalDetails = gatewayProviderAuthError && !gatewayProviderAuthEnabled
    ? displayDetails?.split("\n").filter((line) => !line.startsWith("Request ID:")).join("\n")
    : displayDetails
  const resumable = Boolean(resumePrompt && onResumeInterrupted)
  return (
    <TaskRecovery title={displayError ?? "Task failed"} state={resumable ? "paused" : "failed"}
      testId={resumable ? "session-error-interrupted" : undefined}
      description={showDescriptionOnResume && displayDescription
        ? <span data-testid="session-error-interruption-warning">{displayDescription}</span>
        : !resumePrompt ? displayDescription : null}
      technicalDetails={useGatewayProviderAuthCopy ? displayDetails : displayTechnicalDetails}
      onRetry={canRetry && resumable && resumePrompt ? () => onResumeInterrupted?.(resumePrompt) : undefined}
      retryTestId="session-error-resume"
      actions={gatewaySelectionRequired || selection || changeModel || gatewayConnectUrl !== undefined || (gatewayProviderAuthError && !gatewayProviderAuthEnabled) ? <>
        {gatewaySelectionRequired || selection ? <Button variant="ghost" size="xs" data-testid="session-error-gateway-selection"
          onClick={() => openAlternativeModelPicker(sessionId)}>
          Choose group and credential set
        </Button> : null}
        {changeModel && !gatewaySelectionRequired && !selection ? <Button variant="ghost" size="xs"
          onClick={() => openAlternativeModelPicker(sessionId)}>Change model</Button> : null}
        {gatewayProviderAuthError && !gatewayProviderAuthEnabled ? <Button variant="ghost" size="xs" data-testid="session-error-gateway-connect"
          onClick={() => dispatchAction({ target: "settings", action: "open", section: "providers" })}>Connect</Button> : null}
        {gatewayConnectUrl !== undefined ? <Button variant="ghost" size="xs" data-testid="session-error-gateway-connect"
          onClick={() => dispatchAction({ target: "settings", action: "open", section: "providers" })}>Connect</Button> : null}
      </> : null} />
  )
}

interface RetryMessageProps {
  status: RetryStatus
}

const RetryMessage = React.memo(({ status }: RetryMessageProps) => {
  const { dispatchAction } = useMessageList()
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
  // Transport failures are the engine reconnecting, not a failure yet: say so
  // and show progress instead of echoing the raw fetch error.
  const reconnecting = !freeModelLimit && !action
    && ["network-unavailable", "provider-unreachable", "provider-connection-dropped"].includes(presentation.kind)
  const progress = seconds > 0 ? `Attempt ${status.attempt}, next try in ${seconds}s` : `Attempt ${status.attempt}`

  return (
    <TaskRecovery state="retrying" testId="session-retrying"
      title={reconnecting ? "Reconnecting to the model"
        : `${(freeModelLimit ? "The free starter model is busy right now" : action?.title ?? presentation.title).replace(/[.!?…]+$/, "")}. Retrying…`}
      description={freeModelLimit ? "To keep working now, connect your own model provider." : reconnecting ? progress : action?.message}
      technicalDetails={[info, presentation.technicalDetails].join("\n")}
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
 * Running steps only ever grow. When a finished step folds its live detail
 * before the next step's row arrives, the area briefly got shorter and the
 * chat jumped; holding the tallest height seen during the run keeps it still.
 * The hold ends when the turn folds or the App panel replaces these steps.
 */
function LiveSteps({ children, active }: { children: React.ReactNode; active: boolean }) {
  const ref = React.useRef<HTMLDivElement>(null)
  React.useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    // The hold only protects a running turn from the engine's own shrinks.
    // A finished turn, or a group the person collapsed, may get shorter.
    if (!active || typeof ResizeObserver === "undefined") {
      element.style.minHeight = ""
      return
    }
    let tallest = 0
    const hold = () => {
      element.style.minHeight = ""
      const height = element.getBoundingClientRect().height
      if (height > tallest) tallest = height
      element.style.minHeight = `${tallest}px`
    }
    const release = () => {
      tallest = 0
      element.style.minHeight = ""
    }
    hold()
    const observer = new ResizeObserver(hold)
    for (const child of element.children) observer.observe(child)
    const mutations = new MutationObserver(() => {
      observer.disconnect()
      for (const child of element.children) observer.observe(child)
      hold()
    })
    mutations.observe(element, { childList: true })
    element.addEventListener("pointerdown", release)
    element.addEventListener("keydown", release)
    return () => {
      observer.disconnect()
      mutations.disconnect()
      element.removeEventListener("pointerdown", release)
      element.removeEventListener("keydown", release)
      element.style.minHeight = ""
    }
  }, [active])
  return <div ref={ref} data-live-steps="" className="flex flex-col gap-2">{children}</div>
}

/**
 * A finished turn's steps collapse to a single "Worked for 1m 19s" line
 * that expands back into the full run. Only live turns show their steps
 * unprompted; once the answer is in, the reasoning is available but out
 * of the way.
 */
function CompletedStepRun({ label, count, modelLabel, children }: { label: string; count?: string | null; modelLabel?: string | null; children: React.ReactNode }) {
  const [open, setOpen] = React.useState(false)
  // Text-first: "Worked for 43m 29s ›", no step count beside it.
  const textRail = useTextActivityRail()

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="flex w-full flex-col gap-2">
      <div className="mx-auto flex w-full max-w-3xl px-2 md:px-10">
        <CollapsibleTrigger
          className="group flex min-h-6 cursor-pointer items-center gap-2 text-xs text-muted-foreground transition-colors hover:text-foreground"
          aria-label={`${label}${count ? `, ${count}` : ""}${modelLabel ? ` · ${modelLabel}` : ""}. ${open ? "Hide steps" : "Show steps"}`}
          data-testid="completed-work-rail"
        >
          {/* The chevron sits in the rail's 20px leading lane, so step labels line up below it. */}
          <LaneChevron open={open} />
          <span>{label}</span>
          {count && !textRail ? <RailMeta>{count}</RailMeta> : null}
          {modelLabel ? <span data-testid="reply-model"> · {modelLabel}</span> : null}
          <TrailingChevron open={open} />
        </CollapsibleTrigger>
      </div>
      <CollapsibleContent className="h-(--collapsible-panel-height) overflow-hidden transition-[height] duration-150 ease-out data-starting-style:h-0 data-ending-style:h-0 motion-reduce:transition-none [&[hidden]:not([hidden='until-found'])]:hidden">
        {children}
      </CollapsibleContent>
    </Collapsible>
  )
}

interface AssistantMessageGroupProps {
  items: UIMessageWithIndex[]
  isLastGroup: boolean
  isStreaming: boolean
  /** Newline-joined tool call ids of each built App's newest card in the conversation. */
  newestAppCallIds: string
}

function isMcpAppFramePart(part: UIMessage["parts"][number]): part is DynamicToolUIPart {
  return part.type === "dynamic-tool"
    && (part.state === "output-available" || part.state === "output-error")
    && hasPreservedMcpAppResult(part)
    && !isNativeConnectionAppLaunch(part)
}

/** Tasks a group's steps started on other computers, directly or from a script. */
function collectRemoteThreadStarts(items: UIMessageWithIndex[]) {
  const starts = new Map<string, { start: RemoteThreadStart; part: DynamicToolUIPart }>()
  for (const item of items) {
    if (item.message.role !== "assistant" || isSessionErrorMessage(item.message)) continue
    for (const found of remoteThreadStartsInParts(item.message.parts)) {
      if (!starts.has(found.start.key)) starts.set(found.start.key, found)
    }
  }
  return [...starts.values()]
}

function collectMcpAppParts(items: UIMessageWithIndex[]): DynamicToolUIPart[] {
  const parts = new Map<string, DynamicToolUIPart>()
  for (const item of items) {
    if (item.message.role !== "assistant" || isSessionErrorMessage(item.message)) continue
    for (const part of item.message.parts) {
      if (isMcpAppFramePart(part)) parts.set(part.toolCallId, part)
    }
  }
  return [...parts.values()]
}

/**
 * Every card of an App built in OpenWork opens the App's current revision, so
 * only its newest card in the conversation stays live; earlier ones would load
 * the same App again. A string keeps memoized groups stable while text streams.
 */
function newestBuiltAppCallIds(messages: UIMessage[]): string {
  const newest = new Map<string, string>()
  for (const message of messages) {
    if (message.role !== "assistant" || isSessionErrorMessage(message)) continue
    for (const part of message.parts) {
      if (!isMcpAppFramePart(part)) continue
      const appId = builtMcpAppId(part)
      if (appId) newest.set(appId, part.toolCallId)
    }
  }
  return [...newest.values()].sort().join("\n")
}

function MessageGroup({
  items,
  isLastGroup,
  isStreaming,
  newestAppCallIds,
}: AssistantMessageGroupProps) {
  const { onForkAtMessage, forkingMessageId, showThinking, readOnly, getConnectionDecision, resolveReplyModelTitle, autoRoutes, resolveAutoRouteName } = useMessageList()
  const connectionCardParts = React.useMemo(() => connectionCardPartIds(items, getConnectionDecision), [items, getConnectionDecision])
  const newestAppCalls = React.useMemo(() => new Set(newestAppCallIds.split("\n")), [newestAppCallIds])
  const lastItem = items[items.length - 1]
  // Branch/revert must target a real server-side message id. Synthetic
  // client-side messages (e.g. session errors) don't exist on the server and
  // silently corrupt fork/revert boundaries.
  const lastRealItem = items.findLast((item) => !isSessionErrorMessage(item.message))
  const parentActive = React.useContext(ParentRunActiveContext)
  const panelLive = React.useContext(AppPanelLiveContext) && isLastGroup
  const creationLive = (parentActive || panelLive) && isLastGroup && !readOnly
  const creationRuns = React.useMemo(() => appCreationRuns(items.map(item => item.message), creationLive), [items, creationLive])
  const creationParts = React.useMemo(() => new Set(creationRuns.flatMap(run => [...(run.executions ?? []).map(part => part.toolCallId), ...(run.discoveries ?? []).map(part => part.toolCallId), ...(run.attempts ?? []).map(part => part.toolCallId), ...(run.preparation ? [run.preparation.toolCallId] : []), ...run.builds.map(part => part.toolCallId)])), [creationRuns])
  const isLiveGroup = (isStreaming || (creationLive && creationRuns.length > 0)) && isLastGroup
  const panelActivity = React.useMemo(
    () => panelLive ? appBuildActivity(items.map(item => item.message), creationParts, showThinking) : null,
    [panelLive, items, creationParts, showThinking],
  )
  const remoteThreads = useRemoteThreadsEnabled()
  const textRail = useTextActivityRail()
  const remoteThreadStarts = React.useMemo(() => remoteThreads ? collectRemoteThreadStarts(items) : [], [items, remoteThreads])
  // The skill this turn produced stays in view as its result, even when the
  // steps fold; later updates and shares change this card, not add another.
  const { cards: createdSkillCards } = useCreatedSkills()
  const groupSkillCards = React.useMemo(() => {
    const ids = new Set(items.flatMap((item) => item.message.parts.flatMap((part) => part.type === "dynamic-tool" ? [part.toolCallId] : [])))
    return createdSkillCards.filter((card) => ids.has(card.anchorToolCallId))
  }, [items, createdSkillCards])

  if (!lastItem || isMessageEmptyGroup(items)) {
    return null;
  }

  const renderableItems = getRenderableMessages(items)
  const lastTextMessage = items.findLast(item => getLastTextPart(item.message))
  // Same actions, in the same order, as the buttons below the reply, and only
  // once those buttons show (a finished reply with text).
  const replyText = getMessagesText(renderableItems.map((item) => item.message))
  const replyMenuActions: MenuAction[] = []
  if (lastTextMessage && !isStreaming) {
    if (replyText) replyMenuActions.push(
      { type: "item", id: "copy", label: "Copy", icon: <Copy className="size-4" />, onSelect: () => navigator.clipboard.writeText(replyText) },
    )
    if (lastRealItem && onForkAtMessage) replyMenuActions.push(
      { type: "item", id: "branch", label: forkingMessageId === lastRealItem.message.id ? "Branching..." : "Branch in new chat", icon: <Split className="size-4 rotate-90" />, disabled: Boolean(forkingMessageId), onSelect: () => onForkAtMessage(lastRealItem.message.id) },
    )
  }
  // Native turns can end with a metadata-free completion marker. Keep the
  // latest known model within this turn rather than losing the answer's name.
  const replyModelMessage = items.findLast(item => item.message.role === "assistant" && replyModelLabel(item.message, resolveReplyModelTitle, autoRoutes, resolveAutoRouteName))?.message
  const resolvedReplyModel = replyModelMessage ? replyModelLabel(replyModelMessage, resolveReplyModelTitle, autoRoutes, resolveAutoRouteName) : null
  const replyModelProviderId = replyModelMessage ? replyModelProvider(replyModelMessage, autoRoutes) : undefined
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
  const appFrame = (part: DynamicToolUIPart) => (
    <Message
      key={`mcp-app-${part.toolCallId}`}
      className="mx-auto flex w-full max-w-3xl flex-col px-2 empty:hidden md:px-10"
    >
      {builtMcpAppId(part) && !newestAppCalls.has(part.toolCallId)
        ? <p className="mt-2 text-xs text-muted-foreground">This App has a newer version below.</p>
        : builtAppSummary(part) ? null : <McpAppFrame part={part} />}
    </Message>
  )
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
          ? [{ key: JSON.stringify(["reasoning", item.message.id, groupIndex]), text: group.text, isStreaming: group.isStreaming, durationMs: group.durationMs }]
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
    !isLiveGroup && stepItems.length > 0 && stepRowCount >= COLLAPSED_STEP_RUN_MIN_ROWS
    && !stepsNeedAttention(stepItems, connectionCardParts)
  // A task on another computer outlives the turn that started it and may still
  // need the person, so its row stays in view below a folded run.
  const pinnedRemoteThreads = collapseSteps ? remoteThreadStarts : []
  const pinnedRemoteIds = pinnedRemoteThreads.length > 0 ? new Set(pinnedRemoteThreads.map(({ part }) => part.toolCallId)) : NO_PINNED_REMOTE_THREADS
  const replyStartedAt = stepsStartedAt ?? (lastRealItem ? getMessageCreated(lastRealItem.message) : null)
  const stepCountLabel = stepRowCount ? `${stepRowCount} ${stepRowCount === 1 ? "step" : "steps"}` : null
  const replyWorkedLabel = replyStartedAt !== null && stepsEndedAt !== null && stepsEndedAt > replyStartedAt
    ? `Worked for ${formatToolCallDuration(stepsEndedAt - replyStartedAt)}`
    : null
  const replySummaryLabel = replyWorkedLabel
    ? `${replyWorkedLabel}${stepCountLabel ? ` · ${stepCountLabel}` : ""}`
    : stepRowCount ? stepRunLabel : ""
  const foldedReasoning = collapseSteps
    ? proseReasoning.map((reasoning) => (
      <Message
        key={`folded-reasoning-${reasoning.key}`}
        className="mx-auto flex w-full max-w-3xl flex-col items-start gap-2 px-2 md:px-10"
      >
        <ReasoningBlock disclosureKey={reasoning.key} text={reasoning.text} isStreaming={reasoning.isStreaming} durationMs={reasoning.durationMs} />
      </Message>
    ))
    : []

  const renderItem = (item: UIMessageWithIndex, groupIndex: number, hideReasoning?: boolean) => {
    const isLastMessage = isLastGroup && item.index === lastItem.index

    return (
      // A message whose parts all render nothing (empty reasoning, step
      // markers, hidden steps) must not take a slot in the list's spacing.
      <div key={item.message.id} className="[&:not(:has(:is(span,p,img,svg,button,pre,a,li,iframe,video,canvas,input,textarea,hr,table)))]:hidden">
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
      // Plain command, read and search runs fold into the App panel while it is live.
      if (panelLive) {
        run = null
        return
      }
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
      <AppCreationPartsContext.Provider value={creationParts}>
      <AppPanelFoldContext.Provider value={panelLive}>
      <PinnedRemoteThreadsContext.Provider value={pinnedRemoteIds}>
      <ConnectionCardPartsContext.Provider value={connectionCardParts}>
      <ActionContextMenu
        actions={replyMenuActions}
        contentClassName="w-56"
        // Override Trigger's select-none so replies stay selectable and copyable.
        className="!select-text"
        render={<div className="flex flex-col gap-2 group/message-group !select-text" style={{ userSelect: "text" }} />}
      >
      {/* The scroll area keeps the same 8px rhythm the parts inside a single
          message use, so a step row is spaced identically whether or not a
          message boundary happens to fall between it and the previous row. */}
      {/* A finished turn kept open (it needs the person, T2) still says how long it worked,
          on the same line the fold would use: lane, duration, quiet count (C7). */}
      {!isLiveGroup && resolvedReplyModel && !collapseSteps && replySummaryLabel ? <div data-testid="completed-work-rail" data-completed-work-rail="open" className="mx-auto flex w-full max-w-3xl px-2 md:px-10">
        <div className="flex min-h-6 items-center gap-2 text-xs text-muted-foreground">
          <LeadingLane />
          <span>{replyWorkedLabel ?? replySummaryLabel}</span>
          {replyWorkedLabel && stepCountLabel && !textRail ? <RailMeta>{stepCountLabel}</RailMeta> : null}
        </div>
      </div> : null}
      {stepItems.length > 0 ? (
        collapseSteps ? (
          <CompletedStepRun
            label={(resolvedReplyModel ? replyWorkedLabel : null) ?? stepRunLabel}
            // "2 steps" is quiet metadata beside the duration, not a middle-dot string (C7).
            count={((resolvedReplyModel ? replyWorkedLabel : null) ?? stepRunLabel).startsWith("Worked for") ? stepCountLabel : null}
            modelLabel={null}
          >
            <div className="flex flex-col gap-2">
              {renderItems(stepItems, 0)}
              {foldedReasoning}
            </div>
          </CompletedStepRun>
        ) : (
          <LiveSteps active={isLiveGroup && !panelLive}>
            {/* The App panel replaces ordinary steps. Release their held height
                as they fold away, otherwise an empty rail pushes the panel down. */}
            {renderItems(stepItems, 0, panelLive)}
          </LiveSteps>
        )
      ) : null}
      {creationRuns.map(run => <Message key={`creation-${run.id}`} className="mx-auto flex w-full max-w-3xl flex-col px-2 md:px-10"><AppBuilderStep run={run} startedAt={getMessageCreated(items[0]!.message)} completedAt={getMessageCompleted(lastItem.message)} activity={run === creationRuns.at(-1) ? panelActivity : null} active={creationLive && (run === creationRuns.at(-1) || Boolean(run.preparation && isToolPartInFlight(run.preparation)) || run.builds.some(isToolPartInFlight))} /></Message>)}
      {mcpAppParts.map(appFrame)}
      {pinnedRemoteThreads.map(({ start, part }) => (
        <Message key={`remote-thread-${start.key}`} className="mx-auto flex w-full max-w-3xl flex-col px-2 md:px-10">
          <RemoteThreadRunLine start={start} part={part} />
        </Message>
      ))}
      {renderItems(proseItems, stepItems.length, collapseSteps || panelLive)}
      {groupSkillCards.length > 0 ? (
        <div data-created-skills="" className="mx-auto mt-1 flex w-full max-w-3xl flex-col gap-2 px-2 md:px-10">
          {groupSkillCards.map((card) => <CreatedSkillCard key={card.kind === "ready" ? card.skillId : card.key} card={card} />)}
        </div>
      ) : null}
      {lastTextMessage && !isStreaming && (
        <div className="mx-auto flex w-full max-w-3xl flex-wrap items-center gap-2 px-2 md:px-8">
          <div className={cn("flex items-center gap-2 transition-opacity duration-150 ease-out motion-reduce:transition-none group-hover/message-group:opacity-100 group-focus-within/message-group:opacity-100 pointer-coarse:opacity-100", forkingMessageId && forkingMessageId === lastRealItem?.message.id ? "opacity-100" : "opacity-0")}>
          <MessageActions data-testid="reply-actions" className="flex gap-0">
            <CopyMessageButton messages={renderableItems.map((item) => item.message)} />
            {lastRealItem && onForkAtMessage ? (
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
              </>
            ) : null}
          </MessageActions>
           <MessageTimestamp message={lastItem.message} />
          </div>
          {/* Keep caption ink readable (DESIGN.md V1/V2); hierarchy comes from size,
              not compounded opacity. Hidden actions retain their layout slot. */}
          {!isLiveGroup && resolvedReplyModel ? <span
            data-testid="reply-model"
            className="inline-flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground dark:text-foreground/70 opacity-0 transition-opacity duration-150 ease-out motion-reduce:transition-none group-hover/message-group:opacity-100 group-focus-within/message-group:opacity-100 pointer-coarse:opacity-100"
          >
            <span className="sr-only">Replied with </span>
            <span aria-hidden="true" className="flex size-3 shrink-0 items-center justify-center">
              {replyModelProviderId ? <ProviderIcon providerId={replyModelProviderId} size={12} /> : null}
            </span>
            <span className="truncate">{resolvedReplyModel}</span>
          </span> : null}
          {/* <MessageSources messages={items.map((item) => item.message)} /> */}
        </div>
      )}
      </ActionContextMenu>
      </ConnectionCardPartsContext.Provider>
      </PinnedRemoteThreadsContext.Provider>
      </AppPanelFoldContext.Provider>
      </AppCreationPartsContext.Provider>
    </DevProfiler>
  )
}

function sameMessageGroupProps(left: AssistantMessageGroupProps, right: AssistantMessageGroupProps): boolean {
  return left.isLastGroup === right.isLastGroup
    && left.isStreaming === right.isStreaming
    && left.newestAppCallIds === right.newestAppCallIds
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
  /** The turn's error is explained elsewhere (a confirmed usage block); do not render it again. */
  sessionErrorHandled?: boolean
}

/**
 * The turn's "Working 12s" line stays on screen for the whole run, including
 * while a tool row shows its own live step: the row says what is happening
 * now, the line says the turn is still going and how long it has been working,
 * including follow-ups sent mid-run. Hiding it between steps made the chat
 * look finished.
 */
export function shouldShowMessageListLoading(status: ThreadStatus, messageCount: number) {
  return status === "streaming" || (status === "submitted" && messageCount > 0)
}

export function shouldShowRunReconnecting(status: ThreadStatus, syncDegraded: boolean) {
  if (!syncDegraded) return false
  return status === "submitted" || status === "streaming" || status === "retrying"
}

export function MessageList({ messages, messageIdReplacements, status, activityStatus, retryStatus, syncHealth, viewport, sessionErrorHandled = false }: MessageListProps) {
  const { workspaceId, sessionId, onStopSubagentSession, resolveReplyModelTitle, autoRoutes, resolveAutoRouteName } = useMessageList()
  const liveReplyModel = useLiveReplyModel()
  // Only this turn's reply: before it starts there is no model to show, never the previous turn's.
  const workingModel = React.useMemo<WorkingModel | null>(() => {
    if (!liveReplyModel) return null
    const lastUser = messages.findLastIndex((message) => message.role === "user")
    const reply = messages.slice(lastUser + 1).findLast((message) => message.role === "assistant")
    const label = reply ? replyModelLabel(reply, resolveReplyModelTitle, autoRoutes, resolveAutoRouteName) : null
    if (!reply || !label) return null
    const providerId = replyModelProvider(reply, autoRoutes)
    return providerId ? { label, providerId } : { label }
  }, [liveReplyModel, messages, resolveReplyModelTitle, autoRoutes, resolveAutoRouteName])
  const runningShells = useBackgroundShellStore((state) => state.booksByWorkspaceId[workspaceId]?.running)
  const backgroundShells = React.useMemo(
    () => sessionBackgroundShells(runningShells, sessionId),
    [runningShells, sessionId],
  )
  const [stoppingBackground, setStoppingBackground] = React.useState(false)
  const workspace = useWorkspaceMaybe()
  const tasks = React.useMemo(() => activeDelegatedTasks(messages), [messages])
  const newestAppCallIds = React.useMemo(() => newestBuiltAppCallIds(messages), [messages])
  const delegatedIds = React.useMemo(() => [...new Set(messages.flatMap(message => message.parts)
    .filter(isToolUIPart).filter(isTaskToolPart).map(taskChildSessionId).filter((id): id is string => Boolean(id)))], [messages])
  const backgroundCount = useSessionActivityStore(state => delegatedIds.filter(id =>
    state.recordsByWorkspaceId[workspaceId]?.[id]?.runActive).length)
  // The run is paused while it, or a helper it waits on, asks the person for
  // an approval or answer. Background helpers do not hold up the run.
  const foregroundHelperIds = React.useMemo(() => [...new Set(messages.flatMap(message => message.parts)
    .filter(isToolUIPart).filter(isTaskToolPart).filter(part => part.input?.background !== true)
    .map(taskChildSessionId).filter((id): id is string => Boolean(id)))], [messages])
  const runWaits = useSessionActivityStore(useShallow(state => [sessionId, ...foregroundHelperIds]
    .map(id => state.recordsByWorkspaceId[workspaceId]?.[id]?.waits ?? NO_WAITS)))

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
  const appRunActive = runActive || activityStatus === "thinking" || activityStatus === "responding" || activityStatus === "compacting" || activityStatus === "waiting"
  // The App panel replaces the Working line and the thinking rows while it builds.
  const appPanelLive = React.useMemo(() => (appRunActive || status === "submitted") && appBuildInProgress(messages), [appRunActive, status, messages])
  const syncDegraded = syncHealth?.degraded === true
  const activityActive = runActive || tasks.length > 0
  const runStartedAtRef = React.useRef<number | null>(null)
  const [runElapsedSeconds, setRunElapsedSeconds] = React.useState(0)
  // Anchor the counter to the user message that started the run (server
  // timestamp), so switching sessions and back doesn't reset it to 0 on
  // remount, and a follow-up sent mid-run doesn't restart it. Optimistic
  // messages without metadata fall back to first-mount wall clock.
  const runStartedAt = React.useMemo(() => runActive ? getRunStartedAt(messages) : null, [messages, runActive])
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
    const waits = runWaits.flat()
    const updateElapsed = () => {
      const startedAt = runStartedAtRef.current
      if (startedAt === null) return
      // Time spent waiting for the person's approval or answer is not work.
      const now = Date.now()
      setRunElapsedSeconds(Math.max(0, Math.floor((now - startedAt - getWaitedMs(waits, startedAt, now)) / 1000)))
    }
    updateElapsed()
    const interval = window.setInterval(updateElapsed, 1000)
    return () => window.clearInterval(interval)
  }, [activityActive, runStartedAt, syncDegraded, runWaits])
  const latestUserMessageId = React.useMemo(() => messages.findLast((message) => message.role === "user")?.id, [messages])
  // Steps that render nothing are removed before layout, so they leave no gap.
  const remoteThreads = useRemoteThreadsEnabled()
  const visibleMessages = React.useMemo(() => dedupeRenderedTurnErrors(withoutSilentSteps(messages, remoteThreads)), [messages, remoteThreads]);
  const items = React.useMemo(() => groupMessages(visibleMessages, status), [visibleMessages, status]);
  // groupMessages indexes the visible transcript. Comparing those positions
  // with the unfiltered transcript marks the live turn historical as soon as
  // a silent script or duplicate error is removed.
  const lastVisibleIndex = visibleMessages.length - 1;
  const error = useSessionErrorMessage();
  const hasSessionErrorMessage = React.useMemo(() => messages.some(isSessionErrorMessage), [messages])
  const latestAssistantToolParts = React.useMemo(
    () => collectLatestAssistantToolParts(messages),
    [messages],
  )
  const waiting = activityStatus === "waiting" || activityStatus === "compacting" || childBlocked
  const showReconnecting = !waiting && !retryStatus && shouldShowRunReconnecting(status, syncDegraded)
  const noNewActivity = hasNoNewActivity({
    active: activityActive && activityStatus !== "error", waiting, retrying: status === "retrying" || Boolean(retryStatus),
    disconnected: syncDegraded, lastProgressAt, now: Date.now(),
  })
  // Silence alone never hides the line: a slow first token or a quiet tool is
  // still a busy run. The effect below re-checks status in the background, and
  // Reconnecting takes over only when the run can no longer be confirmed.
  const showLoading = !waiting && !showReconnecting
    && shouldShowMessageListLoading(status, messages.length)
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
  const createdSkills = useCreatedSkillsModel(messages, appRunActive && !syncDegraded)

  return (
    <CreatedSkillsContext.Provider value={createdSkills}>
    <ParentRunActiveContext.Provider value={appRunActive}>
    <AppPanelLiveContext.Provider value={appPanelLive}>
    <BuiltAppPreviewSync key={sessionId} messages={messages} active={runActive}>
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
              isLastGroup={item.messages.at(-1)?.index === lastVisibleIndex}
              isStreaming={isStreaming && item.messages.at(-1)?.index === lastVisibleIndex}
              newestAppCallIds={newestAppCallIds}
            />
          )
        }

        const isLastMessage = item.index === lastVisibleIndex
        const isLastStep =
          !visibleMessages[item.index + 1] || visibleMessages[item.index + 1].role !== item.message.role

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
        {!runActive && backgroundCount > 0 && <div data-background-agents className="mx-auto flex w-full max-w-3xl items-center gap-3 px-2 py-2 text-sm text-muted-foreground md:px-10">
          <span>{syncDegraded ? "Background activity — reconnecting…" : `${backgroundCount} ${backgroundCount === 1 ? "agent" : "agents"} running`}</span>
          {/* Stops only the background helpers; the chat itself is already idle. */}
          {onStopSubagentSession && !syncDegraded ? (
            <button
              type="button"
              disabled={stoppingBackground}
              className="cursor-pointer text-xs text-muted-foreground/70 underline-offset-2 transition-colors hover:text-foreground hover:underline disabled:cursor-default disabled:opacity-50"
              onClick={() => {
                const records = useSessionActivityStore.getState().recordsByWorkspaceId[workspaceId]
                const running = delegatedIds.filter((id) => records?.[id]?.runActive)
                setStoppingBackground(true)
                void Promise.allSettled(running.map((id) => onStopSubagentSession(id)))
                  .finally(() => setStoppingBackground(false))
              }}
            >
              {stoppingBackground ? "Stopping…" : backgroundCount === 1 ? "Stop" : "Stop all"}
            </button>
          ) : null}
        </div>}
        {/* One rule for commands left running in the background: while the turn
            runs, the count joins its Working line; otherwise it takes that
            line's place on its own. One line either way, so the chat does not
            move when the turn ends and the count stays. */}
        {showLoading && !appPanelLive && <LoadingMessage elapsedSeconds={runElapsedSeconds} starting={status === "submitted"} backgroundShells={backgroundShells} backgroundStale={syncDegraded} model={workingModel} />}
        {showReconnecting && <ReconnectingMessage lastConfirmedAt={syncHealth?.lastConfirmedAt ?? null} />}
        {!showLoading && backgroundShells.length > 0 && <BackgroundTasksMessage shells={backgroundShells} stale={syncDegraded} />}
        {retryStatus ? <RetryMessage status={retryStatus} /> : null}
        {error && !hasSessionErrorMessage && !sessionErrorHandled ? <ErrorMessage error={error} /> : null}
      </ProgressiveMessageList>
    </CurrentToolLifecycleProvider>
    </BuiltAppPreviewSync>
    </AppPanelLiveContext.Provider>
    </ParentRunActiveContext.Provider>
    </CreatedSkillsContext.Provider>
  )
}

/** Same model, same object: text streaming must not re-render every group's cards. */
function sameCreatedSkills(left: CreatedSkillsModel, right: CreatedSkillsModel): boolean {
  return JSON.stringify([left.cards, [...left.shareLabels], [...left.savedNames]])
    === JSON.stringify([right.cards, [...right.shareLabels], [...right.savedNames]])
}

/**
 * Created skills for the whole conversation, plus what the person learned by
 * checking (read-only) after a share went unconfirmed.
 */
function useCreatedSkillsModel(messages: UIMessage[], live: boolean): CreatedSkillsContextValue {
  const { onOpenLibraryDetail } = useMessageList()
  const [checked, setChecked] = React.useState<ReadonlyMap<string, ConfirmedSkillAccess>>(() => new Map())
  const next = React.useMemo(() => {
    const collected = collectCreatedSkills(messages, { live })
    return checked.size === 0 ? collected : {
      ...collected,
      cards: collected.cards.map((card) => {
        const access = card.kind === "ready" ? checked.get(card.pluginId) : undefined
        if (!access || card.kind !== "ready") return card
        // A check answers an unconfirmed share; anything still running stays as it is.
        return { ...card, access, pending: card.pending?.state === "unverified" ? null : card.pending }
      }),
    }
  }, [messages, live, checked])
  // Keep the previous object while nothing changed (derived state, not a ref).
  const [stable, setStable] = React.useState<CreatedSkillsModel>(next)
  const unchanged = stable === next || sameCreatedSkills(stable, next)
  if (!unchanged) setStable(next)
  const model = unchanged ? stable : next
  const onCheckSharing = React.useCallback(async (pluginId: string) => {
    try {
      const access = await readCreatedSkillAccess(pluginId)
      setChecked((current) => new Map(current).set(pluginId, access))
    } catch (cause) {
      console.warn("[created-skill] checking sharing failed", cause)
    }
  }, [])
  return React.useMemo(() => ({ ...model, onOpenSkill: onOpenLibraryDetail, onCheckSharing }), [model, onOpenLibraryDetail, onCheckSharing])
}
