import type { CSSProperties, HTMLAttributes } from "react"
import { getSeededPaperMeshGradientConfig } from "../../common/paper"

export interface StaticSeededGradientProps
  extends HTMLAttributes<HTMLDivElement> {
  seed: string
}

/**
 * A CSS-only approximation of the seeded Paper mesh palette.
 *
 * Use this for repeated surfaces such as catalog rows. Unlike PaperMeshGradient,
 * it creates no canvas or WebGL context, so large lists stay within browser GPU
 * limits while retaining the same deterministic color identity.
 */
export function StaticSeededGradient({
  seed,
  className,
  style,
  ...props
}: StaticSeededGradientProps) {
  const { colors, frame } = getSeededPaperMeshGradientConfig(seed)
  const [light, dark, accent, highlight] = colors
  const angle = 115 + (frame % 55)
  const backgroundStyle: CSSProperties = {
    backgroundColor: light,
    backgroundImage: [
      `radial-gradient(circle at 18% 16%, ${light} 0%, transparent 52%)`,
      `radial-gradient(circle at 82% 22%, ${accent} 0%, transparent 50%)`,
      `radial-gradient(circle at 72% 88%, ${highlight} 0%, transparent 54%)`,
      `linear-gradient(${angle}deg, ${dark} 0%, ${accent} 48%, ${highlight} 100%)`,
    ].join(", "),
    ...style,
  }

  return (
    <div
      {...props}
      aria-hidden={props["aria-hidden"] ?? true}
      className={className}
      data-seed={seed}
      data-static-paper-gradient=""
      style={backgroundStyle}
    />
  )
}
