import { ShaderMount, type ShaderMountUniforms } from "@paper-design/shaders"
import { createEffect, onCleanup, onMount, splitProps, type JSX } from "solid-js"

type SolidShaderMountProps = Omit<JSX.HTMLAttributes<HTMLDivElement>, "ref"> & {
  ref?: (element: HTMLDivElement) => void
  fragmentShader: string
  uniforms: ShaderMountUniforms
  speed?: number
  frame?: number
  minPixelRatio?: number
  maxPixelCount?: number
  webGlContextAttributes?: WebGLContextAttributes
  width?: string | number
  height?: string | number
}

export function SolidShaderMount(props: SolidShaderMountProps) {
  const [local, rest] = splitProps(props, [
    "ref",
    "fragmentShader",
    "uniforms",
    "speed",
    "frame",
    "minPixelRatio",
    "maxPixelCount",
    "webGlContextAttributes",
    "width",
    "height",
    "style",
  ])

  let element: HTMLDivElement | undefined
  let shaderMount: ShaderMount | undefined

  onMount(() => {
    if (!element) {
      return
    }

    shaderMount = new ShaderMount(
      element,
      local.fragmentShader,
      local.uniforms,
      local.webGlContextAttributes,
      local.speed,
      local.frame,
      local.minPixelRatio,
      local.maxPixelCount,
    )

    onCleanup(() => {
      shaderMount?.dispose()
      shaderMount = undefined
    })
  })

  createEffect(() => {
    shaderMount?.setUniforms(local.uniforms)
  })

  createEffect(() => {
    shaderMount?.setSpeed(local.speed)
  })

  createEffect(() => {
    if (local.frame !== undefined) {
      shaderMount?.setFrame(local.frame)
    }
  })

  createEffect(() => {
    shaderMount?.setMinPixelRatio(local.minPixelRatio)
  })

  createEffect(() => {
    shaderMount?.setMaxPixelCount(local.maxPixelCount)
  })

  return (
    <div
      {...rest}
      ref={(node) => {
        element = node
        local.ref?.(node)
      }}
      style={mergeStyle(local.style, local.width, local.height)}
    />
  )
}

function mergeStyle(
  style: JSX.CSSProperties | string | undefined,
  width: string | number | undefined,
  height: string | number | undefined,
) {
  if (typeof style === "string") {
    return [
      width !== undefined ? `width:${toCssSize(width)}` : "",
      height !== undefined ? `height:${toCssSize(height)}` : "",
      style,
    ]
      .filter(Boolean)
      .join(";")
  }

  return {
    ...(style ?? {}),
    ...(width !== undefined ? { width: toCssSize(width) } : {}),
    ...(height !== undefined ? { height: toCssSize(height) } : {}),
  }
}

function toCssSize(value: string | number) {
  return typeof value === "number" ? `${value}px` : value
}
