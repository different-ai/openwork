import {
  defaultObjectSizing,
  getShaderColorFromString,
  meshGradientFragmentShader,
  ShaderFitOptions,
  type MeshGradientParams,
} from "@paper-design/shaders"
import type { JSX } from "solid-js"
import { resolvePaperMeshGradientConfig } from "../../common/paper"
import { SolidShaderMount } from "./shader-mount"

type SharedMeshProps = Pick<
  MeshGradientParams,
  "fit" | "rotation" | "scale" | "originX" | "originY" | "offsetX" | "offsetY" | "worldWidth" | "worldHeight"
>

export interface PaperMeshGradientProps
  extends Omit<JSX.HTMLAttributes<HTMLDivElement>, "ref">,
    Partial<SharedMeshProps> {
  ref?: (element: HTMLDivElement) => void
  seed?: string
  fill?: boolean
  colors?: string[]
  distortion?: number
  swirl?: number
  grainMixer?: number
  grainOverlay?: number
  speed?: number
  frame?: number
  minPixelRatio?: number
  maxPixelCount?: number
  webGlContextAttributes?: WebGLContextAttributes
  width?: string | number
  height?: string | number
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
  fit = defaultObjectSizing.fit,
  rotation = defaultObjectSizing.rotation,
  scale = defaultObjectSizing.scale,
  originX = defaultObjectSizing.originX,
  originY = defaultObjectSizing.originY,
  offsetX = defaultObjectSizing.offsetX,
  offsetY = defaultObjectSizing.offsetY,
  worldWidth = defaultObjectSizing.worldWidth,
  worldHeight = defaultObjectSizing.worldHeight,
  minPixelRatio,
  maxPixelCount,
  webGlContextAttributes,
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
    <SolidShaderMount
      {...props}
      width={width ?? (fill ? "100%" : undefined)}
      height={height ?? (fill ? "100%" : undefined)}
      speed={resolved.speed}
      frame={resolved.frame}
      minPixelRatio={minPixelRatio}
      maxPixelCount={maxPixelCount}
      webGlContextAttributes={webGlContextAttributes}
      fragmentShader={meshGradientFragmentShader}
      uniforms={{
        u_colors: resolved.colors.map(getShaderColorFromString),
        u_colorsCount: resolved.colors.length,
        u_distortion: resolved.distortion,
        u_swirl: resolved.swirl,
        u_grainMixer: resolved.grainMixer,
        u_grainOverlay: resolved.grainOverlay,
        u_fit: ShaderFitOptions[fit],
        u_rotation: rotation,
        u_scale: scale,
        u_offsetX: offsetX,
        u_offsetY: offsetY,
        u_originX: originX,
        u_originY: originY,
        u_worldWidth: worldWidth,
        u_worldHeight: worldHeight,
      }}
    />
  )
}
