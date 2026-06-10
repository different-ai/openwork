import { cn } from "@/lib/utils"
import * as React from "react"

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
  }

const DEFAULT_PREVIEW_MAX_HEIGHT = 100

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
  onLoad,
  ...props
}: ImageProps) => {
  const [objectUrl, setObjectUrl] = React.useState<string | undefined>(undefined)
  const [expanded, setExpanded] = React.useState(false)
  const [canExpand, setCanExpand] = React.useState(false)
  const imageRef = React.useRef<HTMLImageElement | null>(null)

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

  const updateCanExpand = React.useCallback((image: HTMLImageElement) => {
    if (previewMaxHeight <= 0) {
      setCanExpand(false)
      return
    }

    if (!image.naturalWidth || !image.naturalHeight) {
      setCanExpand(false)
      return
    }

    const renderedWidth = image.clientWidth || image.getBoundingClientRect().width
    const renderedHeight = renderedWidth > 0
      ? (image.naturalHeight / image.naturalWidth) * renderedWidth
      : image.naturalHeight

    setCanExpand(renderedHeight > previewMaxHeight)
  }, [previewMaxHeight])

  React.useEffect(() => {
    setExpanded(false)
  }, [imageSrc])

  React.useEffect(() => {
    const image = imageRef.current
    if (!image) return

    updateCanExpand(image)

    if (globalThis.ResizeObserver === undefined) return

    const observer = new ResizeObserver(() => updateCanExpand(image))
    observer.observe(image)
    return () => observer.disconnect()
  }, [imageSrc, updateCanExpand])

  if (!imageSrc) {
    return (
      <div
        aria-label={alt}
        role="img"
        className={cn(
          "h-auto max-w-full animate-pulse overflow-hidden rounded-md bg-gray-100 dark:bg-neutral-800",
          className
        )}
        {...props}
      />
    )
  }

  const image = (
    <img
      ref={imageRef}
      src={imageSrc}
      alt={alt}
      className={cn("h-auto max-w-full overflow-hidden rounded-md", className)}
      role="img"
      onLoad={(event) => {
        updateCanExpand(event.currentTarget)
        onLoad?.(event)
      }}
      {...props}
    />
  )

  if (previewMaxHeight <= 0) {
    return image
  }

  return (
    <div className="inline-flex max-w-full flex-col items-start gap-1">
      <div
        className="relative max-w-full overflow-hidden rounded-md"
        style={expanded ? undefined : { maxHeight: previewMaxHeight }}
      >
        {image}
        {!expanded && canExpand ? (
          <div className="absolute inset-x-0 bottom-0 flex justify-center bg-gradient-to-t from-background via-background/90 to-transparent pb-2 pt-8">
            <button
              type="button"
              className="rounded-full border border-border bg-background/95 px-3 py-1 text-xs font-medium text-foreground shadow-sm transition-colors hover:bg-muted"
              onClick={() => setExpanded(true)}
            >
              Show full image
            </button>
          </div>
        ) : null}
      </div>
      {expanded && canExpand ? (
        <button
          type="button"
          className="rounded-full border border-border px-3 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          onClick={() => setExpanded(false)}
        >
          Show less
        </button>
      ) : null}
    </div>
  )
}
