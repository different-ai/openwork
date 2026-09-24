"use client"

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import type { DynamicToolUIPart } from "ai"
import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge"
import type { McpUiStyles, McpUiStyleVariableKey } from "@modelcontextprotocol/ext-apps"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"

import { connectionActionAppResourceUri, legacyConnectionActionAppResourceUri } from "@openwork/types/connection-action-app"
import { isConnectionDiscoveryTool } from "@/components/tools/error-attribution"
import { AppChatArtifact } from "@/react-app/domains/apps/app-chat-artifact"
import { createConnectionActionController, hasHostConnectionActions, standardMcpToolResult } from "./mcp-connection-action"
import { openDesktopUrl } from "@/app/lib/desktop"
import { mcpAppDiscoverySignature, scheduleMcpAppDiscovery } from "@/app/lib/mcp-app-discovery-scheduler"
import {
  OpenworkServerError,
  type OpenworkMcpAppLaunchReference,
  type OpenworkMcpAppResource,
} from "@/app/lib/openwork-server"
import { useMessageList } from "./message-list-provider"
import { createMcpAppActions, type McpAppOrigin } from "./mcp-app-origin"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { t } from "@/i18n"
import {
  formatMcpAppDiagnostic,
  safeMcpAppDiagnosticMessage,
  type McpAppDiagnostic,
  type McpAppDiagnosticStage,
} from "./mcp-app-diagnostics"

const MIN_HEIGHT = 1
const MAX_HEIGHT = 800
const DEFAULT_HEIGHT = 320
const SIZE_EVENT_INTERVAL_MS = 100
const SANDBOX_READY_TIMEOUT_MS = 10_000
const RESOURCE_ACCEPT_TIMEOUT_MS = 1_000
const MAX_RESOURCE_SEND_ATTEMPTS = 2
const INITIALIZE_TIMEOUT_MS = 10_000
const MAX_CONCURRENT_APP_STARTUPS = 2
const pendingAppStartups = new Set<() => void>()
let activeAppStartups = 0

function drainAppStartups() {
  while (activeAppStartups < MAX_CONCURRENT_APP_STARTUPS) {
    const start = pendingAppStartups.values().next().value
    if (!start) return
    pendingAppStartups.delete(start)
    start()
  }
}

function enqueueAppStartup(start: (release: () => void) => void): () => void {
  let active = false
  let released = false
  const release = () => {
    if (released) return
    released = true
    pendingAppStartups.delete(run)
    if (active) activeAppStartups -= 1
    queueMicrotask(drainAppStartups)
  }
  const run = () => {
    active = true
    activeAppStartups += 1
    start(release)
  }
  pendingAppStartups.add(run)
  drainAppStartups()
  return release
}

const ACTIONABLE_MCP_APP_RESOLUTION_CODES = new Set([
  "ambiguous_tool",
  "invalid_resource",
  "invalid_resource_csp",
  "invalid_resource_mime",
  "invalid_resource_uri",
  "invalid_launch_reference",
  "mcp_unreachable",
  "mcp_auth_required",
  "mcp_access_denied",
  "resource_read_failed",
  "resource_too_large",
  "server_unavailable",
  "tool_denied",
  "tool_not_found",
  "tool_not_visible",
  "tool_resource_mismatch",
  "unsupported_resource_permissions",
])

export type PreservedMcpAppResult = {
  content: Array<Record<string, unknown>>
  isError?: boolean
  structuredContent?: Record<string, unknown>
  _meta?: Record<string, unknown>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function sameMcpAppValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => sameMcpAppValue(value, right[index]))
  }
  if (!isRecord(left) || !isRecord(right)) return false
  const keys = Object.keys(left)
  return keys.length === Object.keys(right).length
    && keys.every(key => Object.hasOwn(right, key) && sameMcpAppValue(left[key], right[key]))
}

function normalizeMcpAppHeight(height: number, minimum: number): number {
  return Math.min(MAX_HEIGHT, Math.max(minimum, Math.ceil(Number.isFinite(height) ? height : DEFAULT_HEIGHT)))
}

function preservedResult(part: DynamicToolUIPart): PreservedMcpAppResult | null {
  if (isConnectionDiscoveryTool(part.toolName) && (!isRecord(part.input) || (part.input.intent !== "connect" && part.input.type !== "connectors"))) return null
  const openwork = isRecord(part.callProviderMetadata?.openwork) ? part.callProviderMetadata.openwork : null
  const result = openwork && isRecord(openwork.mcpResult)
    ? openwork.mcpResult
    : openwork && isRecord(openwork.mcpApp)
      ? openwork.mcpApp
      : null
  if (!result || !Array.isArray(result.content)) return null
  const content = result.content.filter(isRecord) as Array<Record<string, unknown>>
  if (content.length !== result.content.length) return null
  return {
    content,
    ...(typeof result.isError === "boolean" ? { isError: result.isError } : {}),
    ...(isRecord(result.structuredContent) ? { structuredContent: result.structuredContent } : {}),
    ...(isRecord(result._meta) ? { _meta: result._meta } : {}),
  }
}

export function hasPreservedMcpAppResult(part: DynamicToolUIPart): boolean {
  return preservedResult(part) !== null
}

export function gatewayMcpAppLaunch(meta: unknown): OpenworkMcpAppLaunchReference | null {
  if (!isRecord(meta) || !isRecord(meta["openwork/mcpApp"])) return null
  const launch = meta["openwork/mcpApp"]
  if ((launch.connectionId !== undefined && typeof launch.connectionId !== "string")
    || typeof launch.toolName !== "string"
    || typeof launch.resourceUri !== "string"
    || !isRecord(launch.arguments)) return null
  return {
    ...(typeof launch.connectionId === "string" ? { connectionId: launch.connectionId } : {}),
    toolName: launch.toolName,
    resourceUri: launch.resourceUri,
    arguments: launch.arguments,
  }
}

export function buildMcpAppCsp(app: OpenworkMcpAppResource): string {
  const resources = app.csp.resourceDomains.join(" ")
  const withResources = (source: string) => resources ? `${source} ${resources}` : source
  const sourceList = (values: string[]) => values.length ? values.join(" ") : "'none'"
  return [
    "default-src 'none'",
    `script-src ${withResources("'unsafe-inline'")}`,
    `style-src ${withResources("'unsafe-inline'")}`,
    `img-src ${withResources("data: blob:")}`,
    `font-src ${withResources("data:")}`,
    `media-src ${withResources("blob:")}`,
    `connect-src ${sourceList(app.csp.connectDomains)}`,
    `frame-src ${sourceList(app.csp.frameDomains)}`,
    `base-uri ${sourceList(app.csp.baseUriDomains)}`,
    "object-src 'none'",
    "form-action 'none'",
  ].join("; ")
}

function escapeAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;")
}

export function secureMcpAppHtml(app: OpenworkMcpAppResource): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(buildMcpAppCsp(app))}">`
  const html = /<html(?:\s[^>]*)?>/i.exec(app.html)
  if (html?.index !== undefined) {
    const prefix = app.html.slice(0, html.index).replace(/^\uFEFF/, "")
    if (!/^\s*(?:<!doctype\s+html\s*>)?\s*$/i.test(prefix)) {
      throw new Error("The MCP App document contains executable markup before its HTML root.")
    }
    const htmlEnd = html.index + html[0].length
    const head = /<head(?:\s[^>]*)?>/i.exec(app.html)
    if (head?.index !== undefined) {
      if (head.index < htmlEnd || app.html.slice(htmlEnd, head.index).trim()) {
        throw new Error("The MCP App document contains markup before its policy-bearing head.")
      }
      const headEnd = head.index + head[0].length
      return `${app.html.slice(0, headEnd)}${meta}${app.html.slice(headEnd)}`
    }
    const body = /<body(?:\s[^>]*)?>/i.exec(app.html)
    if (body?.index !== undefined && (body.index < htmlEnd || app.html.slice(htmlEnd, body.index).trim())) {
      throw new Error("The MCP App document contains markup before its policy-bearing head.")
    }
    return `${app.html.slice(0, htmlEnd)}<head>${meta}</head>${app.html.slice(htmlEnd)}`
  }
  return `<!doctype html><html><head>${meta}</head><body>${app.html}</body></html>`
}

/**
 * Maps the app's live design tokens onto the standard MCP Apps style
 * vocabulary so first-party and third-party cards render with the same
 * palette, type, and radii as the surrounding chat.
 */
const HOST_STYLE_SOURCES: Partial<Record<McpUiStyleVariableKey, string>> = {
  "--color-background-primary": "--dls-surface",
  "--color-background-secondary": "--dls-surface-muted",
  "--color-background-tertiary": "--dls-hover",
  "--color-background-inverse": "--dls-accent",
  "--color-background-success": "--green-3",
  "--color-background-warning": "--amber-3",
  "--color-background-danger": "--red-3",
  "--color-background-info": "--blue-3",
  "--color-text-primary": "--dls-text-primary",
  "--color-text-secondary": "--dls-text-secondary",
  "--color-text-inverse": "--dls-accent-fg",
  "--color-text-success": "--green-11",
  "--color-text-warning": "--amber-11",
  "--color-text-danger": "--red-11",
  "--color-text-info": "--blue-11",
  "--color-border-primary": "--dls-border",
  "--color-border-secondary": "--dls-border",
  "--color-border-success": "--green-a6",
  "--color-border-warning": "--amber-a6",
  "--color-border-danger": "--red-a6",
  "--color-border-info": "--blue-a6",
  "--border-radius-lg": "--dls-radius",
  "--shadow-sm": "--dls-card-shadow",
}

function hostStyleVariables(): McpUiStyles {
  const computed = getComputedStyle(document.documentElement)
  const entries: Array<[string, string]> = []
  for (const [target, source] of Object.entries(HOST_STYLE_SOURCES)) {
    const value = computed.getPropertyValue(source).trim()
    if (value) entries.push([target, value])
  }
  const bodyFont = getComputedStyle(document.body).fontFamily
  if (bodyFont) entries.push(["--font-sans", bodyFont])
  // The SDK types variables as a full Record purely for schema generation;
  // hosts send subsets by design, so this narrow cast is the intended shape.
  return Object.fromEntries(entries) as McpUiStyles
}

export function isActionableMcpAppResolutionError(cause: unknown): boolean {
  return cause instanceof OpenworkServerError && ACTIONABLE_MCP_APP_RESOLUTION_CODES.has(cause.code)
}

function isRetiredFirstPartyConfirmation(toolName: string, result: PreservedMcpAppResult | null): boolean {
  const launch = gatewayMcpAppLaunch(result?._meta)
  if (result?._meta?.["openwork/mcpApp"] !== undefined && !launch) return false
  if (launch?.connectionId !== undefined) return false
  if (/^(?:openwork_|openwork-cloud_)(?:create_skill|update_skill|plugin_flow)$/.test(toolName)) return true
  return /^(?:openwork_|openwork-cloud_)execute_capability$/.test(toolName)
    && (launch?.resourceUri === "ui://openwork/skill-created/v1/view.html"
      || launch?.resourceUri === "ui://openwork/plugin-flow/v1/view.html")
}

const CHAT_MCP_APP_UNAVAILABLE_NOTICE = "Interactive view unavailable. The normal tool result is still available."

export function McpAppDiagnosticNotice({ error, notice, onRetry }: { error: McpAppDiagnostic; notice: string; onRetry?: () => void }) {
  const [detailsCopied, setDetailsCopied] = useState(false)
  const details = formatMcpAppDiagnostic(error)
  return (
    <div className="mt-2 text-xs text-muted-foreground" role="status">
      <p>{notice} {error.message}</p>
      {error.causeCode === "server_unavailable" || error.causeCode === "mcp_unreachable" ? (
        <p className="mt-1">The connection was not ready. Retry, or check the connection under Settings &gt; Library.</p>
      ) : null}
      {onRetry ? (
        <Button type="button" variant="link" size="xs" className="mt-1 px-0" onClick={onRetry}>{t("common.retry")}</Button>
      ) : null}
      <details className="mt-1">
        <summary className="cursor-pointer select-none">Technical details ({error.code})</summary>
        <p className="mt-1">Copy these details when reporting the rendering problem.</p>
        <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-2 font-mono text-[11px] text-foreground">{details}</pre>
        <button
          type="button"
          className="mt-1 underline underline-offset-2"
          onClick={() => {
            if (!navigator.clipboard) return
            void navigator.clipboard.writeText(details)
              .then(() => setDetailsCopied(true))
              .catch(() => setDetailsCopied(false))
          }}
        >
          {detailsCopied ? "Copied" : "Copy details"}
        </button>
      </details>
    </div>
  )
}

export type McpAppSandboxViewProps = {
  origin: McpAppOrigin
  app: OpenworkMcpAppResource
  /** Tool name used for host diagnostics and the iframe title. */
  toolName: string
  /** Arguments the host reports to the app as its launch input. */
  inputArguments: Record<string, unknown>
  /** Tool result delivered to the app once it initializes. */
  result: PreservedMcpAppResult
  connectionController?: ReturnType<typeof createConnectionActionController> | null
  updateMode?: "replace" | "notify"
  onReady?: () => void
  /** Notice prefix shown when the sandboxed view cannot render. */
  unavailableNotice: string
  onRequestTeardown?: () => void
  /** Starting iframe height, letting a host restore the last measured size across remounts. */
  initialHeight?: number
  /** Reports app-requested size changes so a host can persist them past this view's lifetime. */
  onHeightChange?: (height: number) => void
  /** Dashboard widgets own their chrome and may be shorter than chat cards. */
  presentation?: "inline" | "dashboard"
  /** Let the dashboard restore visible recovery controls if the sandbox fails. */
  onError?: () => void
  onRetry?: () => void
}

/**
 * Chat-independent MCP App renderer: sandboxes one resolved app resource and
 * bridges it to the workspace MCP App host. Chat messages and dashboard tiles
 * share this exact pipeline so rendering and diagnostics stay identical.
 */
export function McpAppSandboxView({ origin, app, toolName, inputArguments, result, connectionController, updateMode = "replace", onReady, unavailableNotice, onRequestTeardown, initialHeight, onHeightChange, presentation = "inline", onError, onRetry }: McpAppSandboxViewProps) {
  const openworkServerClient = origin.client
  const workspaceId = origin.workspaceId
  const readOnly = origin.readOnly
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const [height, setHeightState] = useState(() => normalizeMcpAppHeight(initialHeight ?? DEFAULT_HEIGHT, MIN_HEIGHT))
  const heightRef = useRef(height)
  const reportedHeightRef = useRef<number | null>(null)
  const [error, setError] = useState<McpAppDiagnostic | null>(null)
  const [retryAttempt, setRetryAttempt] = useState(0)
  const teardownRef = useRef(onRequestTeardown)
  teardownRef.current = onRequestTeardown
  const onHeightChangeRef = useRef(onHeightChange)
  onHeightChangeRef.current = onHeightChange
  const onErrorRef = useRef(onError)
  onErrorRef.current = onError
  const onReadyRef = useRef(onReady)
  onReadyRef.current = onReady
  const toolDeliveryRef = useRef({ inputArguments, result })
  const deliverToolDataRef = useRef<(() => Promise<void>) | null>(null)
  const replacementInput = updateMode === "replace" ? inputArguments : null
  const replacementResult = updateMode === "replace" ? result : null
  const setHeight = (next: number) => {
    if (heightRef.current !== next) {
      heightRef.current = next
      setHeightState(next)
    }
    if (reportedHeightRef.current !== next && onHeightChangeRef.current) {
      reportedHeightRef.current = next
      onHeightChangeRef.current(next)
    }
  }

  useLayoutEffect(() => {
    const next = { inputArguments, result }
    if (sameMcpAppValue(toolDeliveryRef.current, next)) return
    toolDeliveryRef.current = next
    void deliverToolDataRef.current?.()
  }, [inputArguments, result])

  useLayoutEffect(() => {
    const iframe = iframeRef.current
    if (!iframe || !iframe.contentWindow || !openworkServerClient || !workspaceId) return
    let disposed = false
    const actions = createMcpAppActions(origin, app)
    let lastSizeEventAt = 0
    const startedAt = performance.now()
    const checkpoints: string[] = []
    let sandboxDocument: McpAppDiagnostic["sandboxDocument"]
    let failed = false
    let stopSandbox: (() => void) | undefined
    const checkpoint = (name: string) => checkpoints.push(`${name}+${Math.round(performance.now() - startedAt)}ms`)
    const fail = (
      code: string,
      stage: McpAppDiagnosticStage,
      cause: unknown,
      fallback: string,
      sandboxOrigin?: string,
    ) => {
      if (disposed || failed) return
      failed = true
      actions.dispose()
      stopSandbox?.()
      const diagnostic: McpAppDiagnostic = {
        code,
        stage,
        message: safeMcpAppDiagnosticMessage(cause, fallback),
        toolName,
        resourceUri: app.resourceUri,
        ...(sandboxOrigin ? { sandboxOrigin } : {}),
        elapsedMs: Math.round(performance.now() - startedAt),
        checkpoints: [...checkpoints],
        ...(sandboxDocument ? { sandboxDocument } : {}),
      }
      console.error(`[OpenWork MCP App] ${code}`, diagnostic)
      setError(diagnostic)
      onErrorRef.current?.()
    }
    checkpoint("resource-resolved")
    if (!readOnly && !app.launchId) {
      fail("MCP_APP_LAUNCH_CONTEXT_MISSING", "resource-resolution", null,
        "This App has no live launch context. Update OpenWork and reopen the App before using its actions.")
      return
    }
    const sandbox = openworkServerClient.mcpAppSandbox(app, window.location.origin)
    if (sandbox.expectedOrigin === window.location.origin) {
      fail(
        "MCP_APP_SANDBOX_ORIGIN_INVALID",
        "sandbox-proxy",
        null,
        "The sandbox resolved to the same origin as the OpenWork host.",
        sandbox.expectedOrigin,
      )
      return
    }
    const bridge = new AppBridge(
      null,
      { name: "OpenWork", version: "1.0.0" },
      readOnly ? {} : { serverTools: {}, openLinks: {} },
      {
        hostContext: {
          theme: document.documentElement.classList.contains("dark") ? "dark" : "light",
          displayMode: "inline",
          availableDisplayModes: ["inline"],
          styles: { variables: hostStyleVariables() },
          ...(!readOnly && connectionController && hasHostConnectionActions(app)
            ? { experimental: { "openwork/connection-actions": true } } : {}),
        },
      },
    )
    // Unregistered requests use the SDK's MethodNotFound response. Its default
    // display-mode handler returns our current inline mode without changing it.
    if (!readOnly) bridge.onopenlink = async ({ url }) => {
      try {
        actions.assertActive()
        await openDesktopUrl(url)
        return {}
      } catch (cause) {
        console.error("[OpenWork MCP App] MCP_APP_OPEN_LINK_BLOCKED", {
          toolName,
          message: safeMcpAppDiagnosticMessage(cause, "The link could not be opened."),
        })
        return { isError: true }
      }
    }
    let resourceDeliveryTimer: number | undefined
    let initializeTimer: number | undefined
    let initialized = false
    let resourceAccepted = false
    let resourceSendAttempts = 0
    let sandboxReadyTimer: number | undefined
    let releaseStartup: (() => void) | undefined
    let navigationStarted = false
    let connected = false

    let pendingHeight: number | null = null
    let sizeSettleTimer: number | undefined
    const applyHeight = (requestedHeight: number) => {
      if (sizeSettleTimer !== undefined) window.clearTimeout(sizeSettleTimer)
      sizeSettleTimer = undefined
      pendingHeight = null
      lastSizeEventAt = Date.now()
      setHeight(normalizeMcpAppHeight(requestedHeight, MIN_HEIGHT))
    }
    bridge.onsizechange = ({ height: requestedHeight }) => {
      if (disposed || failed) return
      if (!Number.isFinite(requestedHeight) || requestedHeight === undefined || requestedHeight <= 0) return
      // Before the app initializes, the guest is measuring an empty shell.
      // Keep the remembered height rather than collapsing to the shell size
      // and growing back a moment later; growth is still honored.
      if (!initialized && requestedHeight < heightRef.current) return
      if (Date.now() - lastSizeEventAt >= SIZE_EVENT_INTERVAL_MS) {
        applyHeight(requestedHeight)
        return
      }
      // Throttled: keep the newest value and apply it on the trailing edge so
      // the final post-render measurement is never dropped.
      pendingHeight = requestedHeight
      sizeSettleTimer ??= window.setTimeout(() => {
        sizeSettleTimer = undefined
        if (pendingHeight !== null && !disposed && !failed) applyHeight(pendingHeight)
        pendingHeight = null
      }, SIZE_EVENT_INTERVAL_MS)
    }
    bridge.onrequestteardown = () => {
      if (disposed || failed) return
      disposed = true
      stopSandbox?.()
      teardownRef.current?.()
    }
    if (!readOnly) bridge.oncalltool = async ({ name, arguments: args, _meta }) => {
      try {
        const userInteraction = _meta?.["openwork/userInteraction"] === true
        if (connectionController) return await connectionController.callTool(actions, app, name, args, userInteraction)
        return standardMcpToolResult(await actions.callTool(name, args, userInteraction))
      } catch (cause) {
        if (cause instanceof OpenworkServerError && ["missing_launch_context", "stale_launch_context", "inactive_session"].includes(cause.code)) {
          fail("MCP_APP_LAUNCH_CONTEXT_STALE", "resource-resolution", cause, "Reopen the App in its original conversation before trying again.")
        }
        throw cause
      }
    }
    let delivering = false
    let delivered: typeof toolDeliveryRef.current | null = null
    let ready = false
    const deliverToolData = async () => {
      if (!initialized || delivering || disposed || failed) return
      delivering = true
      try {
        while (!disposed && !failed) {
          const next = toolDeliveryRef.current
          if (!sameMcpAppValue(delivered, next)) {
            await bridge.sendToolInput({ arguments: next.inputArguments })
            if (disposed || failed) return
            await bridge.sendToolResult({
              content: next.result.content as CallToolResult["content"],
              ...(typeof next.result.isError === "boolean" ? { isError: next.result.isError } : {}),
              ...(next.result.structuredContent ? { structuredContent: next.result.structuredContent } : {}),
              ...(next.result._meta ? { _meta: next.result._meta } : {}),
            })
            if (disposed || failed) return
            delivered = next
          }
          if (next !== toolDeliveryRef.current) continue
          if (!ready) {
            ready = true
            onReadyRef.current?.()
          }
          if (next === toolDeliveryRef.current) return
        }
      } catch (cause) {
        fail(
          "MCP_APP_TOOL_RESULT_DELIVERY_FAILED",
          "tool-result-delivery",
          cause,
          "The tool result could not be delivered to the initialized view.",
          sandbox.expectedOrigin,
        )
      } finally {
        delivering = false
      }
    }
    deliverToolDataRef.current = deliverToolData
    bridge.oninitialized = () => {
      if (disposed || failed || initialized) return
      initialized = true
      releaseStartup?.()
      checkpoint("app-initialized")
      if (resourceDeliveryTimer !== undefined) window.clearTimeout(resourceDeliveryTimer)
      if (initializeTimer !== undefined) window.clearTimeout(initializeTimer)
      void deliverToolData()
    }
    const startInitializeTimer = () => {
      if (initialized || initializeTimer !== undefined) return
      initializeTimer = window.setTimeout(() => {
        const message = sandboxDocument
          ? "The HTML document loaded, but the MCP App did not send ui/notifications/initialized within 10 seconds."
          : "The sandbox accepted the resource, but the MCP App did not complete initialization within 10 seconds."
        fail(
          "MCP_APP_INITIALIZE_TIMEOUT",
          "app-initialization",
          null,
          message,
          sandbox.expectedOrigin,
        )
      }, INITIALIZE_TIMEOUT_MS)
    }
    const markResourceAccepted = () => {
      resourceAccepted = true
      if (resourceDeliveryTimer !== undefined) window.clearTimeout(resourceDeliveryTimer)
      startInitializeTimer()
    }
    const handleSandboxDiagnosticMessage = (event: MessageEvent) => {
      if (disposed || failed || !navigationStarted
        || event.source !== iframe.contentWindow
        || event.origin !== sandbox.expectedOrigin
        || !isRecord(event.data)) return
      if (event.data.method === "ui/notifications/sandbox-resource-loaded") {
        const params = isRecord(event.data.params) ? event.data.params : {}
        sandboxDocument = {
          readyState: typeof params.readyState === "string" ? params.readyState : null,
          hasHtmlRoot: typeof params.hasHtmlRoot === "boolean" ? params.hasHtmlRoot : null,
          scriptCount: typeof params.scriptCount === "number" ? params.scriptCount : null,
        }
        checkpoint("resource-document-loaded")
        markResourceAccepted()
        return
      }
      if (event.data.method === "ui/notifications/sandbox-resource-accepted") {
        checkpoint("resource-accepted")
        markResourceAccepted()
        return
      }
      if (event.data.method === "ui/notifications/sandbox-diagnostic") {
        const params = isRecord(event.data.params) ? event.data.params : {}
        const code = typeof params.code === "string" ? params.code : "MCP_APP_SANDBOX_RESOURCE_FAILED"
        checkpoint("sandbox-diagnostic")
        fail(
          code,
          code === "MCP_APP_DOCUMENT_RUNTIME_ERROR" ? "app-initialization" : "resource-delivery",
          typeof params.message === "string" ? params.message : null,
          "The sandbox could not load the MCP App resource.",
          sandbox.expectedOrigin,
        )
      }
    }
    const handleSandboxReady = (event: MessageEvent) => {
      if (disposed || failed || !navigationStarted
        || event.source !== iframe.contentWindow
        || event.origin !== sandbox.expectedOrigin
        || !isRecord(event.data)
        || event.data.method !== "ui/notifications/sandbox-proxy-ready") return
      window.removeEventListener("message", handleSandboxReady)
      checkpoint("sandbox-proxy-ready")
      if (sandboxReadyTimer !== undefined) window.clearTimeout(sandboxReadyTimer)
      const transport = new PostMessageTransport(iframe.contentWindow!, iframe.contentWindow!)
      const deliverResource = async () => {
        if (disposed || failed) return
        resourceSendAttempts += 1
        try {
          await bridge.sendSandboxResourceReady({
            html: secureMcpAppHtml(app),
            csp: app.csp,
            sandbox: "allow-scripts",
          })
          checkpoint(resourceSendAttempts === 1 ? "resource-sent" : `resource-resent-${resourceSendAttempts}`)
          if (disposed || failed || resourceAccepted || initialized) return
          resourceDeliveryTimer = window.setTimeout(() => {
            if (disposed || failed || resourceAccepted || initialized) return
            if (resourceSendAttempts < MAX_RESOURCE_SEND_ATTEMPTS) {
              void deliverResource()
              return
            }
            fail(
              "MCP_APP_RESOURCE_ACCEPT_TIMEOUT",
              "resource-delivery",
              null,
              "The sandbox proxy did not acknowledge the MCP App resource after two delivery attempts.",
              sandbox.expectedOrigin,
            )
          }, RESOURCE_ACCEPT_TIMEOUT_MS)
        } catch (cause) {
          fail(
            "MCP_APP_RESOURCE_DELIVERY_FAILED",
            "resource-delivery",
            cause,
            "The host could not deliver the MCP App HTML to the sandbox.",
            sandbox.expectedOrigin,
          )
        }
      }
      void bridge.connect(transport)
        .then(() => {
          if (disposed || failed) return bridge.close().catch(() => undefined)
          connected = true
          checkpoint("bridge-connected")
          return deliverResource()
        })
        .catch((cause) => {
          fail(
            "MCP_APP_RESOURCE_DELIVERY_FAILED",
            "resource-delivery",
            cause,
            "The host could not deliver the MCP App HTML to the sandbox.",
            sandbox.expectedOrigin,
          )
        })
    }
    let stopped = false
    stopSandbox = () => {
      if (stopped) return
      stopped = true
      if (deliverToolDataRef.current === deliverToolData) deliverToolDataRef.current = null
      actions.dispose()
      releaseStartup?.()
      window.removeEventListener("message", handleSandboxDiagnosticMessage)
      window.removeEventListener("message", handleSandboxReady)
      if (sandboxReadyTimer !== undefined) window.clearTimeout(sandboxReadyTimer)
      if (resourceDeliveryTimer !== undefined) window.clearTimeout(resourceDeliveryTimer)
      if (initializeTimer !== undefined) window.clearTimeout(initializeTimer)
      if (sizeSettleTimer !== undefined) window.clearTimeout(sizeSettleTimer)
      if (connected) {
        let teardownTimer: number | undefined
        void Promise.race([
          bridge.teardownResource({}),
          new Promise<void>((resolve) => { teardownTimer = window.setTimeout(resolve, 500) }),
        ]).catch(() => undefined).finally(() => {
          if (teardownTimer !== undefined) window.clearTimeout(teardownTimer)
          return bridge.close().catch(() => undefined)
        })
      } else {
        void bridge.close().catch(() => undefined)
      }
      if (navigationStarted) iframe.removeAttribute("src")
    }
    window.addEventListener("message", handleSandboxDiagnosticMessage)
    window.addEventListener("message", handleSandboxReady)
    checkpoint("sandbox-startup-queued")
    releaseStartup = enqueueAppStartup((release) => {
      releaseStartup = release
      navigationStarted = true
      checkpoint("sandbox-navigation-started")
      iframe.setAttribute("sandbox", sandbox.sandbox)
      iframe.src = sandbox.url
      sandboxReadyTimer = window.setTimeout(() => {
        fail(
          "MCP_APP_SANDBOX_PROXY_TIMEOUT",
          "sandbox-proxy",
          null,
          "The sandbox proxy did not report that it was ready within 10 seconds.",
          sandbox.expectedOrigin,
        )
      }, SANDBOX_READY_TIMEOUT_MS)
    })

    return () => {
      disposed = true
      stopSandbox?.()
    }
  }, [app, replacementInput, openworkServerClient, replacementResult, toolName, workspaceId, readOnly, origin, origin.sessionId, origin.engine, presentation, updateMode, connectionController, retryAttempt])

  if (error) return <McpAppDiagnosticNotice error={error} notice={unavailableNotice} onRetry={onRetry ?? (() => {
    setError(null)
    setRetryAttempt((attempt) => attempt + 1)
  })} />
  return (
    <div
      className={cn(
        presentation === "dashboard" ? "overflow-hidden" : "mt-3 overflow-hidden rounded-xl bg-background",
        presentation !== "dashboard" && app.prefersBorder && "border border-border",
      )}
      data-mcp-app-resource={app.resourceUri}
    >
      <iframe
        ref={iframeRef}
        title={`${toolName} interactive view`}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        className="block w-full border-0 bg-transparent"
        style={{ height: normalizeMcpAppHeight(height, MIN_HEIGHT) }}
      />
    </div>
  )
}

/**
 * OpenWork's own connection App is presented natively by this host (the
 * connection card in the transcript); the Den App remains for external hosts.
 * The retired v1 resource is never embedded either.
 */
export function isNativeConnectionAppLaunch(part: DynamicToolUIPart): boolean {
  const result = preservedResult(part)
  const launch = gatewayMcpAppLaunch(result?._meta)
  if (!launch) return /^(?:openwork_|openwork-cloud_)connection_action$/.test(part.toolName)
  return /^(?:openwork_|openwork-cloud_)/.test(part.toolName) && !launch.connectionId
    && (launch.resourceUri === connectionActionAppResourceUri || launch.resourceUri === legacyConnectionActionAppResourceUri)
}

export function McpAppFrame({ part }: { part: DynamicToolUIPart }) {
  const result = preservedResult(part)
  if (isRetiredFirstPartyConfirmation(part.toolName, result)) return null
  if (isNativeConnectionAppLaunch(part)) return null
  return <EmbeddedMcpAppFrame part={part} />
}

function EmbeddedMcpAppFrame({ part }: { part: DynamicToolUIPart }) {
  const { mcpAppOrigin: nextOrigin, uiStateOwner, readOnly, getConnectionDecision, onMcpReconnect } = useMessageList()
  const origin = useMemo(() => nextOrigin, [nextOrigin?.client, nextOrigin?.workspaceId, nextOrigin?.sessionId, nextOrigin?.engine, nextOrigin?.readOnly])
  const openworkServerClient = origin?.client
  const workspaceId = origin?.workspaceId
  const nextResult = preservedResult(part)
  const nextResultSignature = mcpAppDiscoverySignature(nextResult)
  const resultCache = useRef<{ signature: string; value: PreservedMcpAppResult | null }>({
    signature: nextResultSignature,
    value: nextResult,
  })
  if (resultCache.current.signature !== nextResultSignature) {
    resultCache.current = { signature: nextResultSignature, value: nextResult }
  }
  const result = resultCache.current.value
  const draft = useMemo(() => {
    if (part.toolName !== "save_artifact_view" && !part.toolName.endsWith("_save_artifact_view")
      && !/^(?:openwork_|openwork-cloud_)?preview_artifact_/.test(part.toolName)) return null
    const reference = result?._meta?.["openwork/appDraft"]
    if (!isRecord(reference) || typeof reference.appId !== "string" || typeof reference.revisionId !== "string"
      || typeof reference.title !== "string" || (reference.receiptId !== undefined && typeof reference.receiptId !== "string")) return null
    return { appId: reference.appId, revisionId: reference.revisionId, title: reference.title, receiptId: reference.receiptId }
  }, [part.toolName, result])
  const launch = useMemo(() => gatewayMcpAppLaunch(result?._meta), [result])
  const scope = uiStateOwner ?? JSON.stringify([origin?.workspaceId, origin?.sessionId])
  const sourceConnectionId = launch?.resourceUri === "ui://openwork/connection-action/v2/view.html"
    && launch.toolName === "connection_action" && !launch.connectionId
    && typeof launch.arguments.connectionId === "string" ? launch.arguments.connectionId : null
  const source = useMemo<{ connectionId: string | null; sessionId: string | null }>(
    () => ({ connectionId: null, sessionId: origin?.sessionId ?? null }),
    [scope, origin?.client, origin?.workspaceId, origin?.sessionId, origin?.engine, part.toolCallId])
  source.connectionId ??= sourceConnectionId
  const initialConnectionId = source.connectionId
  const hostRef = useRef({ scope, blocked: readOnly === true, decision: getConnectionDecision?.(part.toolCallId) ?? null, onReconnect: onMcpReconnect })
  hostRef.current = { scope, blocked: readOnly === true || origin?.readOnly === true || initialConnectionId !== sourceConnectionId,
    decision: getConnectionDecision?.(part.toolCallId) ?? null, onReconnect: onMcpReconnect }
  const connectionController = useMemo(() => initialConnectionId
    ? createConnectionActionController({ scope, sessionId: source.sessionId, toolCallId: part.toolCallId,
      connectionId: initialConnectionId, current: () => hostRef.current }) : null,
  [scope, source, part.toolCallId, initialConnectionId])
  connectionController?.observeBinding()
  const [app, setApp] = useState<OpenworkMcpAppResource | null>(null)
  const [error, setError] = useState<McpAppDiagnostic | null>(null)
  const [resolveToken, setResolveToken] = useState(0)
  const consumedRetryToken = useRef(0)
  // The sandbox view unmounts on every preserved-result change; keep the last
  // measured height here so the rebuilt iframe does not snap back to default.
  const heightRef = useRef(DEFAULT_HEIGHT)
  const nextInputArguments = launch?.arguments ?? (isRecord(part.input) ? part.input : {})
  const nextInputSignature = mcpAppDiscoverySignature(nextInputArguments)
  const inputCache = useRef({ signature: nextInputSignature, value: nextInputArguments })
  if (inputCache.current.signature !== nextInputSignature) {
    inputCache.current = { signature: nextInputSignature, value: nextInputArguments }
  }
  const inputArguments = inputCache.current.value
  // Retire the old view in the same commit, before the passive resolution effect runs.
  const resolution = useMemo(() => ({}), [origin, part.toolName, part.toolCallId, result, inputArguments, resolveToken])
  const resolvedFor = useRef<object | null>(null)

  useEffect(() => {
    let cancelled = false
    let launchId: string | undefined
    const release = () => {
      if (launchId && openworkServerClient && workspaceId) {
        void openworkServerClient.releaseMcpApp(workspaceId, launchId).catch(() => undefined)
      }
    }
    setApp(null)
    setError(null)
    if (draft || !result || !openworkServerClient || !workspaceId || !origin) return () => { cancelled = true }
    const startedAt = performance.now()
    const checkpoints = ["resolve-started"]
    const manual = consumedRetryToken.current !== resolveToken
    consumedRetryToken.current = resolveToken
    const cancelDiscovery = scheduleMcpAppDiscovery(origin, part.toolName, launch, manual,
        (resolved) => {
          launchId = resolved?.launchId
          if (cancelled) { release(); return }
          // A preserved MCP result is neutral transport data. A null resolution
          // means the current tool definition does not advertise an MCP App, so
          // ordinary tools such as save_artifact_view render only their normal
          // result without claiming an unavailable interactive view.
          resolvedFor.current = resolution
          setApp(resolved)
        },
        (cause) => {
          if (cancelled) return
          checkpoints.push(`resolve-failed+${Math.round(performance.now() - startedAt)}ms`)
          if (launch || isActionableMcpAppResolutionError(cause)) {
            const diagnostic: McpAppDiagnostic = {
              code: "MCP_APP_RESOURCE_RESOLUTION_FAILED",
              ...(cause instanceof OpenworkServerError ? { causeCode: cause.code } : {}),
              stage: "resource-resolution",
              message: safeMcpAppDiagnosticMessage(cause, "The interactive view resource could not be resolved."),
              toolName: part.toolName,
              elapsedMs: Math.round(performance.now() - startedAt),
              checkpoints: [...checkpoints],
            }
            console.error(`[OpenWork MCP App] ${diagnostic.code}`, diagnostic)
            setError(diagnostic)
          }
        })
    return () => {
      cancelled = true
      cancelDiscovery()
      release()
    }
  }, [draft, launch, openworkServerClient, part.toolName, result, workspaceId, origin, resolution])

  if (draft) return <AppChatArtifact key={`${draft.appId}:${draft.revisionId}:${draft.receiptId}`} {...draft} />
  const viewId = result?._meta?.artifactViewId
  const revisionId = result?._meta?.viewRevisionId
  if (app && resolvedFor.current === resolution && typeof viewId === "string" && typeof revisionId === "string" && app.resourceUri === `ui://openwork/artifacts/${viewId}/views/${revisionId}/index.html`) {
    const artifact = result?.structuredContent?.artifact
    const title = typeof result?._meta?.appTitle === "string" ? result._meta.appTitle : isRecord(artifact) && typeof artifact.title === "string" ? artifact.title : "App preview"
    const receiptId = isRecord(artifact) && typeof artifact.receiptId === "string" ? artifact.receiptId : undefined
    return <AppChatArtifact key={`${viewId}:${revisionId}:${receiptId}`} appId={viewId} revisionId={revisionId} title={title} receiptId={receiptId} />
  }
  if (!result) return null
  if (!origin) return <p role="status">This App is missing its conversation origin. Reopen the conversation to use it.</p>
  if (error) return <McpAppDiagnosticNotice error={error} notice={CHAT_MCP_APP_UNAVAILABLE_NOTICE} onRetry={() => setResolveToken((token) => token + 1)} />
  if (!app || resolvedFor.current !== resolution) return null
  return (
    <McpAppSandboxView
      origin={origin}
      app={app}
      toolName={part.toolName}
      inputArguments={inputArguments}
      result={result}
      connectionController={connectionController}
      unavailableNotice={CHAT_MCP_APP_UNAVAILABLE_NOTICE}
      onRequestTeardown={() => {
        if (app.launchId) void origin.client.releaseMcpApp(origin.workspaceId, app.launchId).catch(() => undefined)
        setApp(null)
      }}
      initialHeight={heightRef.current}
      onHeightChange={(next) => { heightRef.current = next }}
    />
  )
}
