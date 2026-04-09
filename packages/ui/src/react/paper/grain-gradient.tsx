"use client"

import {
  defaultObjectSizing,
  defaultPatternSizing,
  type GrainGradientShape,
} from "@paper-design/shaders"
import { GrainGradient, type GrainGradientProps } from "@paper-design/shaders-react"
import { resolvePaperGrainGradientConfig } from "../../common/paper"

export interface PaperGrainGradientProps
  extends Omit<
    GrainGradientProps,
    "colorBack" | "colors" | "softness" | "intensity" | "noise" | "shape" | "speed" | "frame"
  > {
  seed?: string
  fill?: boolean
  colorBack?: string
  colors?: string[]
  softness?: number
  intensity?: number
  noise?: number
  shape?: GrainGradientProps["shape"]
  speed?: number
  frame?: number
}

export function PaperGrainGradient({
  seed,
  fill = true,
  colorBack,
  colors,
  softness,
  intensity,
  noise,
  shape,
  speed,
  frame,
  fit,
  rotation,
  scale,
  originX,
  originY,
  offsetX,
  offsetY,
  worldWidth,
  worldHeight,
  width,
  height,
  ...props
}: PaperGrainGradientProps) {
  const resolved = resolvePaperGrainGradientConfig({
    seed,
    colorBack,
    colors,
    softness,
    intensity,
    noise,
    shape,
    speed,
    frame,
  })

  const sizingDefaults = getSizingDefaults(resolved.shape)

  return (
    <GrainGradient
      {...props}
      width={width ?? (fill ? "100%" : undefined)}
      height={height ?? (fill ? "100%" : undefined)}
      fit={fit ?? sizingDefaults.fit}
      rotation={rotation ?? sizingDefaults.rotation}
      scale={scale ?? sizingDefaults.scale}
      originX={originX ?? sizingDefaults.originX}
      originY={originY ?? sizingDefaults.originY}
      offsetX={offsetX ?? sizingDefaults.offsetX}
      offsetY={offsetY ?? sizingDefaults.offsetY}
      worldWidth={worldWidth ?? sizingDefaults.worldWidth}
      worldHeight={worldHeight ?? sizingDefaults.worldHeight}
      colorBack={resolved.colorBack}
      colors={resolved.colors}
      softness={resolved.softness}
      intensity={resolved.intensity}
      noise={resolved.noise}
      shape={resolved.shape}
      speed={resolved.speed}
      frame={resolved.frame}
    />
  )
}

function getSizingDefaults(shape: GrainGradientShape) {
  switch (shape) {
    case "wave":
    case "dots":
    case "truchet":
      return defaultPatternSizing
    default:
      return defaultObjectSizing
  }
}
