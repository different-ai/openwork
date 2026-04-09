import {
  defaultObjectSizing,
  defaultPatternSizing,
  getShaderColorFromString,
  getShaderNoiseTexture,
  grainGradientFragmentShader,
  GrainGradientShapes,
  ShaderFitOptions,
  type GrainGradientParams,
} from "@paper-design/shaders"
import type { JSX } from "solid-js"
import { resolvePaperGrainGradientConfig } from "../../common/paper"
import { SolidShaderMount } from "./shader-mount"

type SharedGrainProps = Pick<
  GrainGradientParams,
  "fit" | "rotation" | "scale" | "originX" | "originY" | "offsetX" | "offsetY" | "worldWidth" | "worldHeight"
>

export interface PaperGrainGradientProps
  extends Omit<JSX.HTMLAttributes<HTMLDivElement>, "ref">,
    Partial<SharedGrainProps> {
  ref?: (element: HTMLDivElement) => void
  seed?: string
  fill?: boolean
  colorBack?: string
  colors?: string[]
  softness?: number
  intensity?: number
  noise?: number
  shape?: GrainGradientParams["shape"]
  speed?: number
  frame?: number
  minPixelRatio?: number
  maxPixelCount?: number
  webGlContextAttributes?: WebGLContextAttributes
  width?: string | number
  height?: string | number
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
  minPixelRatio,
  maxPixelCount,
  webGlContextAttributes,
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
    <SolidShaderMount
      {...props}
      width={width ?? (fill ? "100%" : undefined)}
      height={height ?? (fill ? "100%" : undefined)}
      speed={resolved.speed}
      frame={resolved.frame}
      minPixelRatio={minPixelRatio}
      maxPixelCount={maxPixelCount}
      webGlContextAttributes={webGlContextAttributes}
      fragmentShader={grainGradientFragmentShader}
      uniforms={{
        u_colorBack: getShaderColorFromString(resolved.colorBack),
        u_colors: resolved.colors.map(getShaderColorFromString),
        u_colorsCount: resolved.colors.length,
        u_softness: resolved.softness,
        u_intensity: resolved.intensity,
        u_noise: resolved.noise,
        u_shape: GrainGradientShapes[resolved.shape],
        u_noiseTexture: getShaderNoiseTexture(),
        u_fit: ShaderFitOptions[fit ?? sizingDefaults.fit],
        u_scale: scale ?? sizingDefaults.scale,
        u_rotation: rotation ?? sizingDefaults.rotation,
        u_offsetX: offsetX ?? sizingDefaults.offsetX,
        u_offsetY: offsetY ?? sizingDefaults.offsetY,
        u_originX: originX ?? sizingDefaults.originX,
        u_originY: originY ?? sizingDefaults.originY,
        u_worldWidth: worldWidth ?? sizingDefaults.worldWidth,
        u_worldHeight: worldHeight ?? sizingDefaults.worldHeight,
      }}
    />
  )
}

function getSizingDefaults(shape: NonNullable<GrainGradientParams["shape"]>) {
  switch (shape) {
    case "wave":
    case "dots":
    case "truchet":
      return defaultPatternSizing
    default:
      return defaultObjectSizing
  }
}
