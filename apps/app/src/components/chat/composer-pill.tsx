import {
  composerPillClassName,
  composerPillLabel,
  composerPillTitle,
  type ComposerPill,
} from "@/react-app/domains/session/surface/composer/composer-pills"
import { cn } from "@/lib/utils"

/**
 * A composer pill rendered outside the editor, identical to its composer chip.
 * On a muted surface (the user message bubble) neutral chips lift to the page
 * background so they stay visible; tinted mention chips keep their color.
 */
export function ComposerPillChip(props: { pill: ComposerPill; surface?: "muted"; className?: string }) {
  const neutral = props.pill.kind !== "app" && props.pill.kind !== "computer"
  return (
    <span
      className={cn(
        composerPillClassName(props.pill),
        "mx-0.5 align-middle",
        props.surface === "muted" && neutral && "bg-background",
        props.className,
      )}
      title={composerPillTitle(props.pill)}
      data-composer-pill={props.pill.kind}
    >
      {composerPillLabel(props.pill)}
    </span>
  )
}
