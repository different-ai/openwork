import * as React from "react"

import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog"
import { cn } from "@/lib/utils"

export type GeneratedImageLike = {
  src?: string
  base64?: string
  uint8Array?: Uint8Array
  mediaType?: string
}

export type ImageProps = GeneratedImageLike &
  Omit<React.ComponentProps<"img">, "src"> & {
    alt: string
    previewMaxHeight?: number
    previewMaxWidth?: number
  }

const DEFAULT_PREVIEW_MAX_HEIGHT = 160
const DEFAULT_PREVIEW_MAX_WIDTH = 280

function getImageSrc({
  base64,
  mediaType,
}: Pick<GeneratedImageLike, "base64" | "mediaType">) {
  if (base64 && mediaType) {
    return `data:${mediaType};base64,${base64}`
  }
  return undefined
}

export const Image = ({
  src,
  base64,
  uint8Array,
  mediaType = "image/png",
  className,
  alt,
  previewMaxHeight = DEFAULT_PREVIEW_MAX_HEIGHT,
  previewMaxWidth = DEFAULT_PREVIEW_MAX_WIDTH,
  onLoad,
  style,
  ...props
}: ImageProps) => {
  const [objectUrl, setObjectUrl] = React.useState<string | undefined>(undefined)
  const [open, setOpen] = React.useState(false)

  React.useEffect(() => {
    if (uint8Array && mediaType) {
      const blob = new Blob([uint8Array as BlobPart], { type: mediaType })
      const url = URL.createObjectURL(blob)
      setObjectUrl(url)
      return () => {
        URL.revokeObjectURL(url)
      }
    }
    setObjectUrl(undefined)
    return
  }, [uint8Array, mediaType])

  const base64Src = getImageSrc({ base64, mediaType })
  const imageSrc = src ?? base64Src ?? objectUrl

  if (!imageSrc) {
    return (
      <div
        aria-label={alt}
        role="img"
        className={cn(
          "h-24 w-40 animate-pulse overflow-hidden rounded-md bg-gray-100 dark:bg-neutral-800",
          className
        )}
        {...props}
      />
    )
  }

  const constrained = previewMaxHeight > 0 || previewMaxWidth > 0
  const previewStyle = constrained
    ? {
        ...style,
        ...(previewMaxHeight > 0 ? { maxHeight: previewMaxHeight } : {}),
        ...(previewMaxWidth > 0 ? { maxWidth: previewMaxWidth } : {}),
      }
    : style

  const image = (
    <img
      src={imageSrc}
      alt={alt}
      className={cn(
        "h-auto w-auto overflow-hidden rounded-md object-contain",
        constrained ? null : "max-w-full",
        className
      )}
      role="img"
      style={previewStyle}
      onLoad={onLoad}
      {...props}
    />
  )

  if (!constrained) {
    return image
  }

  return (
    <>
      <button
        type="button"
        className="inline-block max-w-full cursor-zoom-in rounded-md text-left transition-opacity hover:opacity-90"
        onClick={() => setOpen(true)}
        aria-label={`Expand ${alt}`}
        title={alt}
      >
        {image}
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90vh] w-auto max-w-[min(90vw,56rem)] overflow-hidden border-none bg-transparent p-0 shadow-none sm:max-w-[min(90vw,56rem)]">
          <DialogTitle className="sr-only">{alt}</DialogTitle>
          <img
            src={imageSrc}
            alt={alt}
            className="max-h-[85vh] w-auto max-w-full rounded-xl object-contain"
          />
        </DialogContent>
      </Dialog>
    </>
  )
}
