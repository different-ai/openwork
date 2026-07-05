export type DetectedArch = "arm64" | "x64"
export type DetectedOS = "macos" | "windows" | "linux"
export type DetectedPlatform = {
  os: DetectedOS
  arch: DetectedArch | null
  osVersion: string | null
  source: "ua-ch" | "webgl" | "ua"
}

type UADataValues = { platform?: string; platformVersion?: string; architecture?: string; bitness?: string }
type NavigatorUAData = { getHighEntropyValues(hints: string[]): Promise<UADataValues> }

declare global {
  interface Navigator {
    userAgentData?: NavigatorUAData
  }
}

function osFromUserAgent(userAgent: string): DetectedOS {
  if (userAgent.includes("win")) return "windows"
  if (userAgent.includes("linux") && !userAgent.includes("android")) return "linux"
  return "macos"
}

function osFromPlatform(platform: string, fallback: DetectedOS): DetectedOS {
  if (/win/i.test(platform)) return "windows"
  if (/linux/i.test(platform)) return "linux"
  if (/mac/i.test(platform)) return "macos"
  return fallback
}

function archFromUAData(values: UADataValues): DetectedArch | null {
  const architecture = values.architecture?.toLowerCase()
  if (architecture === "arm") return "arm64"
  if (architecture === "x86" && values.bitness === "64") return "x64"
  return null
}

function majorVersion(platformVersion?: string): number | null {
  const match = platformVersion?.match(/^\d+/)
  if (!match) return null
  return Number(match[0])
}

function osVersionFromUAData(os: DetectedOS, platformVersion?: string): string | null {
  const major = majorVersion(platformVersion)
  if (major === null) return null
  if (os === "macos") return `macOS ${major}`
  if (os === "windows") {
    if (major >= 13) return "Windows 11"
    if (major >= 1) return "Windows 10"
  }
  return null
}

function archFromRenderer(renderer: string): DetectedArch | null {
  if (/apple/i.test(renderer)) return "arm64"
  if (/intel|amd|radeon/i.test(renderer)) return "x64"
  return null
}

function archFromUserAgent(userAgent: string): DetectedArch | null {
  if (/aarch64|arm64/.test(userAgent)) return "arm64"
  if (/x86_64|win64|x64/.test(userAgent)) return "x64"
  return null
}

export async function detectPlatform(): Promise<DetectedPlatform | null> {
  if (typeof navigator === "undefined") return null

  let userAgent = ""
  try {
    userAgent = navigator.userAgent.toLowerCase()
  } catch {}
  const baselineOS = osFromUserAgent(userAgent)

  try {
    const userAgentData = navigator.userAgentData
    if (userAgentData) {
      const values = await userAgentData.getHighEntropyValues(["platform", "platformVersion", "architecture", "bitness"])
      const os = values.platform ? osFromPlatform(values.platform, baselineOS) : baselineOS
      return {
        os,
        arch: archFromUAData(values),
        osVersion: osVersionFromUAData(os, values.platformVersion),
        source: "ua-ch",
      }
    }
  } catch {}

  if (baselineOS === "macos") {
    try {
      if (typeof document !== "undefined") {
        const canvas = document.createElement("canvas")
        const gl = canvas.getContext("webgl")
        const debugInfo = gl?.getExtension("WEBGL_debug_renderer_info")
        const value: unknown = gl && debugInfo ? gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) : null
        const renderer = typeof value === "string" ? value : ""
        return { os: "macos", arch: archFromRenderer(renderer), osVersion: null, source: "webgl" }
      }
    } catch {}
  }

  return { os: baselineOS, arch: archFromUserAgent(userAgent), osVersion: null, source: "ua" }
}
