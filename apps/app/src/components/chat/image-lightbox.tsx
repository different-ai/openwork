import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"

type ImageLightboxProps = {
  src: string
  alt: string
  open: boolean
  onOpenChange: (open: boolean) => void
}

/** Full-size image viewer shared by sent, queued, and draft image attachments. */
export function ImageLightbox({ src, alt, open, onOpenChange }: ImageLightboxProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-image-lightbox=""
        className="max-h-[95vh] w-auto max-w-[95vw] overflow-hidden border-none bg-transparent p-0 shadow-none ring-0 lg:w-max lg:max-w-[95vw]"
      >
        <DialogTitle className="sr-only">{alt}</DialogTitle>
        <img src={src} alt={alt} className="max-h-[92vh] w-auto max-w-full rounded-xl object-contain" />
      </DialogContent>
    </Dialog>
  )
}
