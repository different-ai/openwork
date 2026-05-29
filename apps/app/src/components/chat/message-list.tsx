"use memo";

import * as React from "react"
import {
  AlertTriangle,
  Check,
  Copy,
  FileIcon,
  Split,
  Undo2,
} from "lucide-react"
import {
  AnimatePresence,
  LayoutGroup,
  motion,
} from "motion/react"
import { PaperGrainGradient } from "@openwork/ui/react"
import {
  DynamicToolUIPart,
  isFileUIPart,
  ToolUIPart,
  type FileUIPart,
  type UIMessage,
} from "ai"
import { ApplyPatchTool } from "@/components/tools/apply-patch"
import { BashTool } from "@/components/tools/bash"
import { EditTool } from "@/components/tools/edit"
import { ReadFileTool, WriteFileTool } from "@/components/tools/file"
import { GlobTool } from "@/components/tools/glob"
import { GrepTool } from "@/components/tools/grep"
import { LspTool } from "@/components/tools/lsp"
import { QuestionTool } from "@/components/tools/question"
import { SkillTool } from "@/components/tools/skill"
import { TodoWriteTool } from "@/components/tools/todowrite"
import { WebfetchTool } from "@/components/tools/webfetch"
import { WebsearchTool } from "@/components/tools/websearch"
import { useMessageList, useSessionErrorMessage } from "@/components/chat/message-list-provider"
import { ArtifactList } from "@/components/chat/artifact"
import { TaskSuggestions } from "@/components/chat/task-suggestions"
import {
  DescriptiveButton,
  DescriptiveButtonContent,
  DescriptiveButtonDescription,
  DescriptiveButtonIcon,
  DescriptiveButtonTitle,
} from "@/components/descriptive-button"
import { Button } from "@/components/ui/button"
import { Image } from "@/components/ui/image"
import {
  Message,
  MessageAction,
  MessageActions,
  MessageContent,
} from "@/components/ui/message"
import {
  Steps,
  StepsContent,
  StepsTrigger,
} from "@/components/ui/steps"
import { Tool } from "@/components/ui/tool"
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
  isTodoWriteToolPart,
  isWebFetchToolPart,
  isWebSearchToolPart,
  isWriteToolPart,
} from "@/lib/build-in-tools"
import type { ThreadStatus } from "@/lib/messages"
import { cn } from "@/lib/utils"
import { groupMessages, isMessageGroup, getLastTextPart, getAssistantRenderGroups, getFileTitle, getMediaBadge, type UIMessageWithIndex, getMessagesText } from "./utils"

interface ToolMessageProps {
  part: ToolUIPart | DynamicToolUIPart
}

const ToolMessage = ({ part }: ToolMessageProps) => {
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

  return <Tool toolPart={part} />
}

const isEmptyMessage = (message: UIMessage): boolean => message.parts.length === 0

interface FileMessageProps {
  part: FileUIPart
  tone: "assistant" | "user"
}

function FileMessage({ part, tone }: FileMessageProps) {
  const title = getFileTitle(part)
  const badge = getMediaBadge(part)
  const isImage = part.mediaType.startsWith("image/") && part.url

  if (isImage) {
    return (
      <Image
        src={part.url}
        alt={title}
        loading="lazy"
        decoding="async"
        className="size-full object-cover"
      />
    )
  }

  return (
    <DescriptiveButton className="px-2 py-1 items-center gap-2">
      <DescriptiveButtonIcon>
        <FileIcon className="size-6 shrink-0" />
      </DescriptiveButtonIcon>
      <DescriptiveButtonContent className="gap-0">
        <DescriptiveButtonTitle>{title}</DescriptiveButtonTitle>
        {badge ? (
          <DescriptiveButtonDescription className="text-xs">
            {badge}
          </DescriptiveButtonDescription>
        ) : null}
      </DescriptiveButtonContent>
    </DescriptiveButton>
  )
}

function EmptyMessage({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "mx-auto flex w-full max-w-3xl flex-col items-start gap-2 px-2 md:px-10 text-muted-foreground",
        className
      )}
      {...props}
    >
      Empty message
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
}

export const AssistantMessage = React.memo(
  ({ message }: AssistantMessageProps) => {
    const { showThinking } = useMessageList()
    const assistantRenderGroups = React.useMemo(
      () => getAssistantRenderGroups(message.parts, showThinking),
      [message.parts, showThinking]
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
                >
                  {group.text}
                </MessageContent>
              )
            }

            if (group.kind === "reasoning") {
              return (
                <MessageContent
                  key={`reasoning-${index}`}
                  className="text-muted-foreground prose w-full min-w-0 flex-1 rounded-lg bg-transparent p-0"
                  markdown
                >
                  {group.text}
                </MessageContent>
              )
            }

            if (group.kind === "file") {
              return (
                <div key={`file-${index}`} className="w-full">
                  <FileMessage part={group.part} tone="assistant" />
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

function renderUserTextWithSkillChips(text: string) {
  if (!USER_SKILL_TOKEN_RE.test(text)) return text
  let offset = 0
  return text.split(USER_SKILL_TOKEN_RE).map((segment) => {
    const key = `${offset}:${segment}`
    offset += segment.length
    const skillMatch = segment.match(/^(?:Load )?\[skill ([^\]]+)\](?: and follow its instructions\.)?$/)
    if (skillMatch?.[1]) return <UserSkillChip key={key} name={skillMatch[1]} />
    return <React.Fragment key={key}>{segment}</React.Fragment>
  })
}

export const UserMessage = React.memo(
  ({ message, isStreaming }: UserMessageProps) => {
    const { onRevertToUserMessage, onForkAtMessage } = useMessageList()

    return (
      <Message
        className="mx-auto flex w-full max-w-3xl flex-col items-end gap-2 px-2 md:px-10"
        data-message-id={message.id}
        data-message-role={message.role}
      >
        <div className="group flex w-full flex-col items-end gap-1">
          {message.parts.filter(isFileUIPart).map((part, index) => (
            <FileMessage key={`${part.url}-${index}`} part={part} tone="user" />
          ))}
          {message.parts.some((part) => part.type === "text" && part.text) ? (
            <MessageContent
              layoutId={message.id}
              className="bg-muted text-foreground max-w-[85%] rounded-3xl px-5 py-2.5 whitespace-pre-wrap sm:max-w-[75%]"
            >
              {renderUserTextWithSkillChips(message.parts.map((part) => (part.type === "text" ? part.text : "")).join(""))}
            </MessageContent>
          ) : null}
          {!isStreaming && (
            <MessageActions
              className={cn(
                "flex gap-0 opacity-0 transition-opacity duration-150 group-hover:opacity-100"
              )}
            >
              <CopyMessageButton messages={[message]} />
              <MessageAction tooltip="Branch in new chat">
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => onForkAtMessage(message.id)}
                >
                  <Split className="rotate-90" />
                </Button>
              </MessageAction>
              <MessageAction tooltip="Revert">
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => onRevertToUserMessage(message.id)}
                >
                  <Undo2 />
                </Button>
              </MessageAction>
            </MessageActions>
          )}
        </div>
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
}

export const MessageComponent = React.memo(
  ({ message, isLastMessage, isStreaming, isLastStep }: MessageComponentProps) => {
    if (isEmptyMessage(message) && !isStreaming) {
      return (
        <EmptyMessage
          data-message-id={message.id}
          data-message-role={message.role}
        />
      )
    }

    if (message.role === "assistant") {
      return (
        <AssistantMessage
          message={message}
          isLastMessage={isLastMessage}
          isStreaming={isStreaming}
          isLastStep={isLastStep}
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

const LoadingMessage = React.memo(() => (
  <Message className="mx-auto flex w-full max-w-3xl flex-col items-start gap-2 px-2 md:px-10">
    <div className="group flex w-full flex-col gap-0">
      <div className="flex items-center gap-1.5 px-1 py-1 text-sm text-muted-foreground">
        <div style={{ width: 20, height: 20, borderRadius: "50%", overflow: "hidden" }}>
          <PaperGrainGradient
            speed={12}
            softness={0.1}
            intensity={1}
            noise={0.05}
            shape="sphere"
            colors={["#818cf8", "#fb7185", "#fbbf24", "#34d399"]}
            colorBack="#ffffff00"
            style={{ backgroundColor: "#818cf8", width: "100%", height: "100%", borderRadius: "50%" }}
          />
        </div>
        <span>Thinking…</span>
      </div>
    </div>
  </Message>
))

LoadingMessage.displayName = "LoadingMessage"

interface ErrorMessageProps {
  error: string | null
}

const ErrorMessage = React.memo(({ error }: ErrorMessageProps) => (
  <Message className="not-prose mx-auto flex w-full max-w-3xl flex-col items-start gap-2 px-0 md:px-10">
    <div className="group flex w-full flex-col items-start gap-0">
      <div className="text-foreground flex min-w-0 flex-1 flex-row items-center gap-2 rounded-lg border-2 border-red-300 bg-red-300/20 px-2 py-1">
        <AlertTriangle size={16} className="text-destructive" />
        <p className="text-destructive">{error}</p>
      </div>
    </div>
  </Message>
))

ErrorMessage.displayName = "ErrorMessage"

const isMessageEmptyGroup = (messages: UIMessageWithIndex[]) =>
  messages.every(message => isEmptyMessage(message.message));

const getRenderableMessages = (messages: UIMessageWithIndex[]) =>
  messages.flatMap((item) => {
    const parts = item.message.parts.filter((part) => part.type === "text" || part.type === "file");

    return parts.length > 0 ? [{ ...item, message: { ...item.message, parts } }] : []
  })

interface AssistantMessageGroupProps {
  items: UIMessageWithIndex[]
  messages: UIMessage[]
  isStreaming: boolean
}

function MessageGroup({
  items,
  messages,
  isStreaming,
}: AssistantMessageGroupProps) {
  const { onRevertToUserMessage, onForkAtMessage } = useMessageList()
  const [open, setOpen] = React.useState(false)
  // Only run layout animations while the collapsible is expanding/collapsing.
  // Otherwise (e.g. while streaming) layout changes apply instantly.
  const [isAnimating, setIsAnimating] = React.useState(false)
  const layoutTransition = isAnimating
  ? { type: "spring" as const, bounce: 0.1, duration: 0.1 }
  : { duration: 0 }

  const lastItem = items[items.length - 1]

  if (!lastItem || isMessageEmptyGroup(items)) {
    if (isStreaming) {
      return null;
    }

    return <EmptyMessage />
  }

  const renderableItems = getRenderableMessages(items)
  const lastTextMessage = getLastTextPart(lastItem.message)

  return (
    <LayoutGroup>
      <div className="flex flex-col gap-2 group/message-group">
      <Steps
        className="mx-auto w-full max-w-3xl"
        open={open}
        onOpenChange={(next) => {
          setIsAnimating(true)
          setOpen(next)
        }}
      >
        <StepsTrigger className="px-2 md:px-10">
          {items.length} steps
        </StepsTrigger>
        <StepsContent>
          {items.map((item, groupIndex) => {
            const isLastMessage = item.index === messages.length - 1
            const isLastStep = groupIndex === items.length - 1

            return (
              <motion.div
                key={`${groupIndex}-${item.message.id}`}
                layoutId={`msg-${item.message.id}`}
                layout
                transition={layoutTransition}
                onLayoutAnimationComplete={() => setIsAnimating(false)}
              >
                <MessageComponent
                  message={item.message}
                  isLastMessage={isLastMessage}
                  isStreaming={isLastMessage && isStreaming}
                  isLastStep={isLastStep}
                />
              </motion.div>
            )
          })}
        </StepsContent>
      </Steps>
      <AnimatePresence initial={false}>
        {!open ? renderableItems.map(({ index, message }) => (
          <motion.div
            key={message.id}
            layoutId={`msg-${message.id}`}
            layout
            transition={layoutTransition}
            onLayoutAnimationComplete={() => setIsAnimating(false)}
          >
            <MessageComponent
              message={message}
              isStreaming={index === messages.length - 1 && isStreaming}
              isLastMessage={index === messages.length - 1}
              isLastStep={index === items.length}
            />
          </motion.div>
        )) : null}
      </AnimatePresence>
      <ArtifactList messages={items.map((item) => item.message)} />
      {lastTextMessage && !isStreaming && (
        <div className="mx-auto flex w-full max-w-3xl flex-wrap items-center gap-2 px-2 opacity-0 transition-opacity duration-150 group-hover/message-group:opacity-100 md:px-8">
          <MessageActions className="flex gap-0">
            <CopyMessageButton messages={renderableItems.map((item) => item.message)} />
            <MessageAction tooltip="Branch in new chat">
              <Button
                variant="ghost"
                size="icon"
                onClick={() => onForkAtMessage(lastItem.message.id)}
              >
                <Split className="rotate-90" />
              </Button>
            </MessageAction>
            <MessageAction tooltip="Revert">
              <Button
                variant="ghost"
                size="icon"
                onClick={() => onRevertToUserMessage(lastItem.message.id)}
              >
                <Undo2 />
              </Button>
            </MessageAction>
          </MessageActions>
          {/* <MessageSources messages={items.map((item) => item.message)} /> */}
        </div>
      )}
      {renderableItems.length === 0 && !isStreaming ? <EmptyMessage /> : null}
      </div>
    </LayoutGroup>
  )
}

interface MessageListProps {
  messages: UIMessage[]
  status: ThreadStatus
}

export function MessageList({ messages, status }: MessageListProps) {
  const isStreaming = status === "streaming" || status === "retrying"
  const items = React.useMemo(() => groupMessages(messages, status), [messages, status]);
  const error = useSessionErrorMessage();

  return (
    <div className={cn("flex flex-col gap-2 @container/message-list")}>
      {messages.length === 0 && <TaskSuggestions className="mx-auto w-full max-w-3xl shrink-0 px-3 pb-3 md:px-5 md:pb-5 grow" />}

      {items.map((item) => {
        if (isMessageGroup(item)) {
          return (
            <MessageGroup
              key={item.messages[0]?.message.id ?? "empty-assistant-group"}
              items={item.messages}
              messages={messages}
              isStreaming={isStreaming}
            />
          )
        }

        const isLastMessage = item.index === messages.length - 1
        const isLastStep =
          !messages[item.index + 1] || messages[item.index + 1].role !== item.message.role

        return (
          <div key={item.message.id}>
            <MessageComponent
              message={item.message}
              isLastMessage={isLastMessage}
              isStreaming={isLastMessage && isStreaming}
              isLastStep={isLastStep}
            />
          </div>
        )
      })}

      {status === "streaming" && <LoadingMessage />}
      {error ? <ErrorMessage error={error} /> : null}
    </div>
  )
}
