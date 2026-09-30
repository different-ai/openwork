import * as React from "react"
import { resolveExtensionIconSrc } from "@/react-app/design-system/extension-icon-src"
import { cn } from "@/lib/utils"
import { sessionReferenceHref, type SessionReference, type SessionReferenceIdentity } from "./session-reference"

export const SESSION_REFERENCE_LINK_CLASS_NAME = "inline-flex max-w-full items-center gap-1 rounded-sm px-1 align-middle font-medium text-foreground underline decoration-border underline-offset-2 hover:bg-accent hover:decoration-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"

type SessionReferenceLinkProps = {
  reference: SessionReference
  openReference: (identity: SessionReferenceIdentity) => void
  children?: React.ReactNode
  className?: string
}

export function SessionReferenceLink({ reference, openReference, children, className }: SessionReferenceLinkProps) {
  const open = (event: React.MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault()
    event.stopPropagation()
    if (event.button === 0 || event.button === 1) openReference(reference)
  }

  return (
    <a
      href={sessionReferenceHref(reference)}
      aria-label={`Open ${reference.archived ? "archived task" : "task"}: ${reference.title}`}
      title={reference.title}
      className={cn(SESSION_REFERENCE_LINK_CLASS_NAME, className)}
      onClick={open}
      onAuxClick={open}
      onMouseDown={(event) => { if (event.button === 1) event.preventDefault() }}
    >
      <img
        src={resolveExtensionIconSrc("/openwork-sidebar-mark.svg")}
        alt=""
        aria-hidden="true"
        className="size-4 shrink-0 object-contain dark:invert"
      />
      <span className="min-w-0 max-w-64 truncate">{children ?? reference.title}</span>
    </a>
  )
}
