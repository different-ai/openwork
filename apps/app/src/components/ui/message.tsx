import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { MarkdownBlock } from "@/components/markdown/markdown"
import { cn } from "@/lib/utils"
import { motion } from "motion/react"

const messageContentClassName =
  "rounded-lg p-2 text-foreground leading-relaxed bg-secondary prose wrap-break-word whitespace-normal"

export type MessageProps = {
  children: React.ReactNode
  className?: string
} & React.HTMLProps<HTMLDivElement>

const Message = ({ children, className, ...props }: MessageProps) => (
  <div className={cn("flex gap-3", className)} {...props}>
    {children}
  </div>
)

export type MessageAvatarProps = {
  src: string
  alt: string
  fallback?: string
  delayMs?: number
  className?: string
}

const MessageAvatar = ({
  src,
  alt,
  fallback,
  delayMs,
  className,
}: MessageAvatarProps) => {
  return (
    <Avatar className={cn("h-8 w-8 shrink-0", className)}>
      <AvatarImage src={src} alt={alt} />
      {fallback && (
        <AvatarFallback delay={delayMs}>{fallback}</AvatarFallback>
      )}
    </Avatar>
  )
}

export type MessageContentProps = {
  children: React.ReactNode
  markdown?: boolean
  isStreaming?: boolean
  className?: string
} & React.ComponentProps<typeof motion.div>

const MessageContent = ({
  children,
  markdown = false,
  className,
  isStreaming,
  ...props
}: MessageContentProps) => {
  if (markdown) {
    return (
      <MarkdownBlock
        className={cn(messageContentClassName, className)}
        text={children as string}
        streaming={isStreaming}
        {...props}
      />
    )
  }

  return (
    <motion.div
      className={cn(messageContentClassName, className)}
      {...props}
    >
      {children}
    </motion.div>
  )
}

export type MessageActionsProps = {
  children: React.ReactNode
  className?: string
} & React.HTMLProps<HTMLDivElement>

const MessageActions = ({
  children,
  className,
  ...props
}: MessageActionsProps) => (
  <div
    className={cn("text-muted-foreground flex items-center gap-2", className)}
    {...props}
  >
    {children}
  </div>
)

export type MessageActionProps = {
  className?: string
  tooltip: React.ReactNode
  children: React.ReactElement
  side?: "top" | "bottom" | "left" | "right"
} & React.ComponentProps<typeof Tooltip>

const MessageAction = ({
  tooltip,
  children,
  className,
  side = "top",
  ...props
}: MessageActionProps) => {
  return (
    <Tooltip {...props}>
      <TooltipTrigger render={children} />
      <TooltipContent side={side} className={className}>
        {tooltip}
      </TooltipContent>
    </Tooltip>
  )
}

export { Message, MessageAvatar, MessageContent, MessageActions, MessageAction }
