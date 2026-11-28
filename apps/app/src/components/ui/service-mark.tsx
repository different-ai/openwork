import { useState } from "react"
import { cn } from "@/lib/utils"

export const GITHUB_SERVICE_MARK = "/ext-github.svg"

export function ServiceMark({ name, iconUrl }: { name: string; iconUrl: string | null | undefined }) {
  const [failedIcon, setFailedIcon] = useState<string | null>(null)
  const showImage = Boolean(iconUrl) && iconUrl !== failedIcon
  return (
    <span
      aria-hidden="true"
      className={cn("flex size-6 shrink-0 items-center justify-center overflow-hidden rounded-md", !showImage && "bg-muted text-xs font-medium text-foreground")}
    >
      {showImage && iconUrl ? <img src={iconUrl} alt="" className={cn("size-4 object-contain", iconUrl === GITHUB_SERVICE_MARK && "dark:invert")} onError={() => setFailedIcon(iconUrl)} /> : name.charAt(0).toUpperCase()}
    </span>
  )
}

