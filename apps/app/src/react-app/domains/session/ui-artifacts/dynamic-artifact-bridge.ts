import {
  uiArtifactFrameBridgeEnvelopeSchema,
  type UiArtifactFrameBridgeEnvelope,
  type UiArtifactPinnedBuild,
} from "@openwork/types/ui-artifact-project"

export const DYNAMIC_ARTIFACT_MAX_INITIALIZE_BYTES = 1_100_000
export const DYNAMIC_ARTIFACT_MAX_BRIDGE_BYTES = 96_000
const VITE_REFRESH_PREAMBLE = "globalThis.$RefreshReg$=()=>{};globalThis.$RefreshSig$=()=>type=>type;"
const VITE_REFRESH_PREAMBLE_HASH = "'sha256-UdqoyTJsJVmqS5BkZgs+Nf0XMZGeABWzvccmLU73T3E='"

export function dynamicArtifactSerializedByteLength(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

export function sanitizeDynamicArtifactError(value: unknown) {
  const text = value instanceof Error ? value.message : String(value)
  return text
    .replace(/https?:\/\/\S+/gi, "[url]")
    .replace(/\b(?:file|blob):\S+/gi, "[resource]")
    .replace(/(?:[A-Za-z]:\\|\/)(?:[^\s/\\]+[/\\])+[^\s]*/g, "[path]")
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 800) || "Artifact runtime failed"
}

function stableArtifactJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null"
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableArtifactJson).join(",")}]`
  }
  const entries = Object.entries(value).sort(([left], [right]) => (
    left < right ? -1 : left > right ? 1 : 0
  ))
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableArtifactJson(entry)}`).join(",")}}`
}

export async function verifyDynamicArtifactBuildDigest(build: UiArtifactPinnedBuild) {
  const canonical = stableArtifactJson({
    bundle: build.bundle,
    manifest: build.manifest,
    styles: build.styles,
    data: build.data,
    dataSchema: build.dataSchema,
  })
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical))
  const actual = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
  return actual === build.build.buildDigest
}

export function parseDynamicArtifactFrameMessage(
  value: unknown,
  expected: { instanceId: string; nonce: string; afterSeq: number },
): UiArtifactFrameBridgeEnvelope | null {
  if (dynamicArtifactSerializedByteLength(value) > DYNAMIC_ARTIFACT_MAX_BRIDGE_BYTES) {
    return null
  }
  const parsed = uiArtifactFrameBridgeEnvelopeSchema.safeParse(value)
  if (
    !parsed.success ||
    parsed.data.instanceId !== expected.instanceId ||
    parsed.data.nonce !== expected.nonce ||
    parsed.data.seq <= expected.afterSeq
  ) {
    return null
  }
  return parsed.data
}

function escapeHtmlAttribute(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
}

export function buildDynamicArtifactSrcDoc(assetUrl: string) {
  const escapedAssetUrl = escapeHtmlAttribute(assetUrl)
  const cspAssetUrl = new URL(assetUrl)
  const isDevelopmentModule = (
    cspAssetUrl.searchParams.has("worker_file") ||
    cspAssetUrl.searchParams.get("type") === "module"
  )
  const scriptType = isDevelopmentModule ? ' type="module"' : ""
  cspAssetUrl.search = ""
  cspAssetUrl.hash = ""
  const scriptSource = isDevelopmentModule ? cspAssetUrl.origin : cspAssetUrl.href
  const scriptPolicy = [
    scriptSource,
    "blob:",
    ...(isDevelopmentModule ? [VITE_REFRESH_PREAMBLE_HASH] : []),
  ].join(" ")
  const csp = [
    "default-src 'none'",
    `script-src ${scriptPolicy}`,
    `script-src-elem ${scriptPolicy}`,
    "connect-src 'none'",
    "frame-src 'none'",
    "child-src 'none'",
    "worker-src 'none'",
    "object-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    "style-src 'unsafe-inline'",
    "img-src data: blob:",
    "media-src data: blob:",
    "font-src data:",
  ].join("; ")

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="${escapeHtmlAttribute(csp)}">
    <meta name="referrer" content="no-referrer">
    <style>
      :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, sans-serif; }
      * { box-sizing: border-box; }
      html, body, #root { width: 100%; height: 100%; max-height: 100%; margin: 0; overflow: hidden; }
      #root { contain: layout paint; }
      body { background: transparent; color: CanvasText; }
      .openwork-artifact-loading { display: grid; min-height: 160px; place-content: center; gap: 8px; }
      .openwork-artifact-loading span { width: 120px; height: 10px; border-radius: 999px; background: color-mix(in srgb, CanvasText 12%, transparent); }
      .openwork-artifact-loading span:nth-child(2) { width: 180px; }
      .openwork-artifact-error { display: flex; min-height: 140px; flex-direction: column; justify-content: center; gap: 6px; padding: 20px; color: #b42318; }
      .openwork-artifact-error span { color: color-mix(in srgb, CanvasText 72%, transparent); font-size: 13px; }
    </style>
  </head>
  <body>
    <div id="root"></div>
    ${isDevelopmentModule ? `<script>${VITE_REFRESH_PREAMBLE}</script>` : ""}
    <script${scriptType} src="${escapedAssetUrl}"></script>
  </body>
</html>`
}
