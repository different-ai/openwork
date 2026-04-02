"use client"

import { MeshGradient, type MeshGradientProps } from "@paper-design/shaders-react"
import { resolvePaperMeshGradientConfig } from "../../common/paper"

export interface PaperMeshGradientProps
  extends Omit<
    MeshGradientProps,
    "colors" | "distortion" | "swirl" | "grainMixer" | "grainOverlay" | "speed" | "frame"
  > {
  seed?: string
  fill?: boolean
  colors?: string[]
  distortion?: number
  swirl?: number
  grainMixer?: number
  grainOverlay?: number
  speed?: number
  frame?: number
}

export function PaperMeshGradient({
  seed,
  fill = true,
  colors,
  distortion,
  swirl,
  grainMixer,
  grainOverlay,
  speed,
  frame,
  width,
  height,
  ...props
}: PaperMeshGradientProps) {
  const resolved = resolvePaperMeshGradientConfig({
    seed,
    colors,
    distortion,
    swirl,
    grainMixer,
    grainOverlay,
    speed,
    frame,
  })

  return (
    <MeshGradient
      {...props}
      width={width ?? (fill ? "100%" : undefined)}
      height={height ?? (fill ? "100%" : undefined)}
      colors={resolved.colors}
      distortion={resolved.distortion}
      swirl={resolved.swirl}
      grainMixer={resolved.grainMixer}
      grainOverlay={resolved.grainOverlay}
      speed={resolved.speed}
      frame={resolved.frame}
    />
  )
}
