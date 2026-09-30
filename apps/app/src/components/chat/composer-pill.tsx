import * as React from "react"
import { Check, Copy } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  ATTACHMENT_CHIP_CLASS,
  ATTACHMENT_CHIP_ICON_CLASS,
  ATTACHMENT_CHIP_META_CLASS,
  ATTACHMENT_CHIP_NAME_CLASS,
  CHIP_ICONS,
  COMPOSER_BADGE_CLASS,
  COMPOSER_BADGE_LABEL_CLASS,
  COMPOSER_BADGE_META_CLASS,
  attachmentChipIcon,
  attachmentChipMeta,
  composerBadgeSlotClass,
  composerPillBadge,
  lineCount,
  pastedTextBadge,
  type ChipIcon,
  type ComposerBadge,
} from "@/react-app/domains/session/surface/composer/composer-chips"
import type { ComposerPill } from "@/react-app/domains/session/surface/composer/composer-pills"
import { cn } from "@/lib/utils"

export function ChipIconSvg(props: { icon: ChipIcon; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={props.className}
    >
      {CHIP_ICONS[props.icon].map(([tag, attrs], index) => React.createElement(tag, { key: index, ...attrs }))}
    </svg>
  )
}

function BadgeSlot(props: { badge: ComposerBadge }) {
  const { slot } = props.badge
  const logoUrls = "logoUrls" in slot ? slot.logoUrls : []
  const [failed, setFailed] = React.useState(0)
  const logo = logoUrls[failed]
  if ("initial" in slot) return <span className={composerBadgeSlotClass(props.badge, false)}>{slot.initial}</span>
  if (logo) {
    return (
      <span className={composerBadgeSlotClass(props.badge, true)}>
        <img src={logo} alt="" decoding="async" className="size-3.5 object-contain" onError={() => setFailed((current) => current + 1)} />
      </span>
    )
  }
  return (
    <span className={composerBadgeSlotClass(props.badge, false)}>
      <ChipIconSvg icon={"icon" in slot ? slot.icon : slot.fallback} className="size-3" />
    </span>
  )
}

/** A badge drawn outside the editor, identical to its composer chip. */
export function ComposerBadgeChip(props: { badge: ComposerBadge; className?: string; open?: boolean }) {
  return (
    <span className={cn(COMPOSER_BADGE_CLASS, props.className)} title={props.badge.title} data-composer-badge={props.badge.kind}>
      <BadgeSlot badge={props.badge} />
      <span className={COMPOSER_BADGE_LABEL_CLASS}>{props.badge.label}</span>
      {props.badge.meta ? <span className={COMPOSER_BADGE_META_CLASS}>{props.badge.meta}</span> : null}
      {props.badge.disclosure ? (
        <ChipIconSvg icon="chevron" className={cn("size-3 shrink-0 text-muted-foreground transition-transform duration-150 ease-out motion-reduce:transition-none", props.open && "rotate-90")} />
      ) : null}
    </span>
  )
}

export function ComposerPillChip(props: { pill: ComposerPill; className?: string }) {
  return <ComposerBadgeChip badge={composerPillBadge(props.pill)} className={props.className} />
}

const PREVIEW_LINES = 6

/**
 * Pasted text stays one badge in the sent message. Its chevron opens a preview
 * in place: counts, Copy, and the first lines.
 */
export function PastedTextChip(props: { text: string }) {
  const [open, setOpen] = React.useState(false)
  const [copied, setCopied] = React.useState(false)
  const lines = props.text.split(/\r\n|\r|\n/)
  const total = lineCount(props.text)
  const more = Math.max(0, total - PREVIEW_LINES)
  React.useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), 1500)
    return () => window.clearTimeout(timer)
  }, [copied])
  return (
    <>
      <button
        type="button"
        className="inline rounded-lg align-middle focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
        aria-expanded={open}
        aria-label={open ? "Hide pasted text" : "Show pasted text"}
        onClick={() => setOpen((current) => !current)}
      >
        <ComposerBadgeChip badge={pastedTextBadge(total)} open={open} className="mx-0" />
      </button>
      {open ? (
        <span className="my-1.5 block w-full rounded-lg border border-border bg-background px-3 py-2 text-left" data-pasted-text-preview>
          <span className="flex items-center justify-between gap-3">
            <span className="text-[11px] text-muted-foreground">
              {total} line{total === 1 ? "" : "s"} · {props.text.length.toLocaleString()} characters
            </span>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={() => {
                void navigator.clipboard.writeText(props.text).then(() => setCopied(true))
              }}
            >
              {copied ? <Check /> : <Copy />}
              {copied ? "Copied" : "Copy"}
            </Button>
          </span>
          <span className="mt-1 block overflow-hidden whitespace-pre-wrap break-words font-mono text-xs leading-5 text-foreground">
            {lines.slice(0, PREVIEW_LINES).join("\n")}
          </span>
          {more > 0 ? (
            <span className="mt-1 block text-[11px] text-muted-foreground">{more} more line{more === 1 ? "" : "s"}</span>
          ) : null}
        </span>
      ) : null}
    </>
  )
}

/** A non-image attachment: type icon, name, type and size. */
export function AttachmentFileChip(props: {
  filename: string
  mime: string
  bytes?: number
  onOpen?: () => void
  /** Extra actions (download, reveal) inside the chip's edge. */
  actions?: React.ReactNode
  className?: string
}) {
  const content = (
    <>
      <span className={ATTACHMENT_CHIP_ICON_CLASS}>
        <ChipIconSvg icon={attachmentChipIcon(props.filename, props.mime)} className="size-4" />
      </span>
      <span className="min-w-0">
        <span className={ATTACHMENT_CHIP_NAME_CLASS}>{props.filename}</span>
        <span className={ATTACHMENT_CHIP_META_CLASS}>{attachmentChipMeta(props)}</span>
      </span>
    </>
  )
  return (
    <span className={cn(ATTACHMENT_CHIP_CLASS, props.actions ? "pr-1" : null, props.className)} title={props.filename} data-attachment-chip>
      {props.onOpen ? (
        <button
          type="button"
          className="flex min-w-0 items-center gap-2 text-left transition-opacity hover:opacity-80"
          onClick={props.onOpen}
          title={`Open ${props.filename} in Artifacts`}
        >
          {content}
        </button>
      ) : (
        <span className="flex min-w-0 items-center gap-2">{content}</span>
      )}
      {props.actions}
    </span>
  )
}
