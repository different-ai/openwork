import * as React from "react"
import { X } from "lucide-react"

import { ImageLightbox } from "@/components/chat/image-lightbox"
import { cn } from "@/lib/utils"

type ImageAttachmentBadgeProps = {
  src: string
  alt: string
  onRemove?: () => void
  className?: string
}

export function ImageAttachmentBadge({
  src,
  alt,
  onRemove,
  className,
}: ImageAttachmentBadgeProps) {
  const [open, setOpen] = React.useState(false)

  return (
    <div className={cn("relative inline-flex shrink-0", className)}>
      <button
        type="button"
        className="h-10 w-10 overflow-hidden rounded-xl border border-border/70 bg-background/50 transition-opacity hover:opacity-90"
        onClick={() => setOpen(true)}
        aria-label={`Expand ${alt}`}
        title={alt}
      >
        <img
          src={src}
          alt={alt}
          loading="lazy"
          decoding="async"
          className="h-full w-full object-cover"
        />
      </button>
      {onRemove ? (
        <button
          type="button"
          className="absolute -right-1.5 -top-1.5 inline-flex h-5 w-5 items-center justify-center rounded-full border border-border bg-background text-muted-foreground shadow-sm transition-colors hover:bg-muted hover:text-foreground"
          onClick={(event) => {
            event.stopPropagation()
            onRemove()
          }}
          aria-label={`Remove ${alt}`}
          title="Remove"
        >
          <X className="size-3" />
        </button>
      ) : null}
      <ImageLightbox src={src} alt={alt} open={open} onOpenChange={setOpen} />
    </div>
  )
}
