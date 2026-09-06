"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import type { DynamicToolUIPart } from "ai"
import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge"
import type { McpUiStyles, McpUiStyleVariableKey } from "@modelcontextprotocol/ext-apps"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"

import { connectorCatalogSchema } from "@openwork/types/connection-action-app"
import { ConnectorCatalogCard } from "./connector-catalog"
import { ConnectionCard } from "./connection-card"
import { reconnectActionFromChatToolResult } from "@/components/tools/error-attribution"
import { AppChatArtifact } from "@/react-app/domains/apps/app-chat-artifact"
import { openDesktopUrl } from "@/app/lib/desktop"
import { mcpAppResolutionRetryDelayMs } from "@/app/lib/mcp-app-resolution"
import {
  OpenworkServerError,
  type OpenworkMcpAppLaunchReference,
  type OpenworkMcpAppResource,
  type OpenworkMcpAppToolResult,
} from "@/app/lib/openwork-server"
import { useWorkspace } from "@/react-app/shell/workspace-provider"
import { cn } from "@/lib/utils"
import {
  formatMcpAppDiagnostic,
  safeMcpAppDiagnosticMessage,
  type McpAppDiagnostic,
  type McpAppDiagnosticStage,
} from "./mcp-app-diagnostics"

const MIN_HEIGHT = 160
const MAX_HEIGHT = 800
const DEFAULT_HEIGHT = 320
const SIZE_EVENT_INTERVAL_MS = 100
const SANDBOX_READY_TIMEOUT_MS = 5_000
const RESOURCE_ACCEPT_TIMEOUT_MS = 1_000
const MAX_RESOURCE_SEND_ATTEMPTS = 2
const INITIALIZE_TIMEOUT_MS = 10_000

const ACTIONABLE_MCP_APP_RESOLUTION_CODES = new Set([
  "ambiguous_tool",
  "invalid_resource",
  "invalid_resource_csp",
  "invalid_resource_mime",
  "invalid_resource_uri",
  "invalid_launch_reference",
  "mcp_unreachable",
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
  structuredContent?: Record<string, unknown>
  _meta?: Record<string, unknown>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function preservedResult(part: DynamicToolUIPart): PreservedMcpAppResult | null {
  if (part.toolName === "openwork-cloud_search_capabilities" && (!isRecord(part.input) || (part.input.intent !== "connect" && part.input.type !== "connectors"))) return null
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
    ...(isRecord(result.structuredContent) ? { structuredContent: result.structuredContent } : {}),
    ...(isRecord(result._meta) ? { _meta: result._meta } : {}),
  }
}

export function hasPreservedMcpAppResult(part: DynamicToolUIPart): boolean {
  return preservedResult(part) !== null || connectorCatalogFromPart(part) !== null
}

export function connectorCatalogFromPart(part: DynamicToolUIPart) {
  if (part.toolName !== "openwork-cloud_search_capabilities" || part.state !== "output-available") return null
  if (!isRecord(part.input) || (part.input.intent !== "connect" && part.input.type !== "connectors")) return null
  let value: unknown = preservedResult(part)?.structuredContent ?? part.output
  if (typeof value === "string") {
    if (value.length > 128 * 1024) return null
    try { value = JSON.parse(value) } catch { return null }
  }
  if (!isRecord(value)) return null
  const parsed = connectorCatalogSchema.safeParse(value.connectorCatalog)
  return parsed.success ? parsed.data : null
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

function mcpToolResult(result: OpenworkMcpAppToolResult): CallToolResult {
  return result as CallToolResult
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
        <button type="button" className="mt-1 underline underline-offset-2" onClick={onRetry}>Retry</button>
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
  app: OpenworkMcpAppResource
  /** Tool name used for host diagnostics and the iframe title. */
  toolName: string
  /** Arguments the host reports to the app as its launch input. */
  inputArguments: Record<string, unknown>
  /** Tool result delivered to the app once it initializes. */
  result: PreservedMcpAppResult
  /** Notice prefix shown when the sandboxed view cannot render. */
  unavailableNotice: string
  onRequestTeardown?: () => void
  /** Starting iframe height, letting a host restore the last measured size across remounts. */
  initialHeight?: number
  /** Reports app-requested size changes so a host can persist them past this view's lifetime. */
  onHeightChange?: (height: number) => void
  /** Generated result views cannot call tools or open links. */
  readOnly?: boolean
}

/**
 * Chat-independent MCP App renderer: sandboxes one resolved app resource and
 * bridges it to the workspace MCP App host. Chat messages and dashboard tiles
 * share this exact pipeline so rendering and diagnostics stay identical.
 */
export function McpAppSandboxView({ app, toolName, inputArguments, result, unavailableNotice, onRequestTeardown, initialHeight, onHeightChange, readOnly = false }: McpAppSandboxViewProps) {
  const { openworkServerClient, workspaceId } = useWorkspace()
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const [height, setHeightState] = useState(initialHeight ?? DEFAULT_HEIGHT)
  const [error, setError] = useState<McpAppDiagnostic | null>(null)
  const teardownRef = useRef(onRequestTeardown)
  teardownRef.current = onRequestTeardown
  const onHeightChangeRef = useRef(onHeightChange)
  onHeightChangeRef.current = onHeightChange
  const setHeight = (next: number) => {
    setHeightState(next)
    onHeightChangeRef.current?.(next)
  }

  useEffect(() => {
    const iframe = iframeRef.current
    if (!iframe || !iframe.contentWindow || !openworkServerClient || !workspaceId) return
    let disposed = false
    let lastSizeEventAt = 0
    const startedAt = performance.now()
    const checkpoints: string[] = []
    let sandboxDocument: McpAppDiagnostic["sandboxDocument"]
    let failed = false
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
    }
    checkpoint("resource-resolved")
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
      readOnly ? {} : { serverTools: {} },
      {
        hostContext: {
          theme: document.documentElement.classList.contains("dark") ? "dark" : "light",
          displayMode: "inline",
          styles: { variables: hostStyleVariables() },
        },
      },
    )
    bridge.onopenlink = async ({ url }) => {
      if (readOnly) return { isError: true }
      try {
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
    const sandboxReadyTimer = window.setTimeout(() => {
      fail(
        "MCP_APP_SANDBOX_PROXY_TIMEOUT",
        "sandbox-proxy",
        null,
        "The sandbox proxy did not report that it was ready within 5 seconds.",
        sandbox.expectedOrigin,
      )
    }, SANDBOX_READY_TIMEOUT_MS)

    let pendingHeight: number | null = null
    let sizeSettleTimer: number | undefined
    const applyHeight = (requestedHeight: number) => {
      lastSizeEventAt = Date.now()
      setHeight(Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.ceil(requestedHeight))))
    }
    bridge.onsizechange = ({ height: requestedHeight }) => {
      if (!Number.isFinite(requestedHeight) || requestedHeight === undefined) return
      if (Date.now() - lastSizeEventAt >= SIZE_EVENT_INTERVAL_MS) {
        applyHeight(requestedHeight)
        return
      }
      // Throttled: keep the newest value and apply it on the trailing edge so
      // the final post-render measurement is never dropped.
      pendingHeight = requestedHeight
      sizeSettleTimer ??= window.setTimeout(() => {
        sizeSettleTimer = undefined
        if (pendingHeight !== null && !disposed) applyHeight(pendingHeight)
        pendingHeight = null
      }, SIZE_EVENT_INTERVAL_MS)
    }
    bridge.onrequestteardown = () => {
      teardownRef.current?.()
    }
    bridge.oncalltool = async ({ name, arguments: args }) => {
      if (readOnly) throw new Error("This app displays results and cannot call tools.")
      const request = { serverName: app.serverName, name, resourceUri: app.resourceUri, arguments: args }
      try {
        return mcpToolResult(await openworkServerClient.callMcpAppTool(workspaceId, request))
      } catch (cause) {
        if (!(cause instanceof OpenworkServerError) || cause.code !== "tool_requires_approval") throw cause
        const approved = window.confirm(`Allow this MCP App to call ${name} on ${app.serverName}?`)
        if (!approved) throw new Error("The user declined the MCP App tool call.")
        return mcpToolResult(await openworkServerClient.callMcpAppTool(workspaceId, { ...request, approved: true }))
      }
    }
    bridge.oninitialized = () => {
      initialized = true
      checkpoint("app-initialized")
      if (resourceDeliveryTimer !== undefined) window.clearTimeout(resourceDeliveryTimer)
      if (initializeTimer !== undefined) window.clearTimeout(initializeTimer)
      void bridge.sendToolInput({
        arguments: inputArguments,
      }).then(() => bridge.sendToolResult({
        content: result.content as CallToolResult["content"],
        ...(result.structuredContent ? { structuredContent: result.structuredContent } : {}),
        ...(result._meta ? { _meta: result._meta } : {}),
      })).catch((cause) => {
        fail(
          "MCP_APP_TOOL_RESULT_DELIVERY_FAILED",
          "tool-result-delivery",
          cause,
          "The tool result could not be delivered to the initialized view.",
          sandbox.expectedOrigin,
        )
      })
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
      if (event.source !== iframe.contentWindow
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
      if (event.source !== iframe.contentWindow
        || event.origin !== sandbox.expectedOrigin
        || !isRecord(event.data)
        || event.data.method !== "ui/notifications/sandbox-proxy-ready") return
      window.removeEventListener("message", handleSandboxReady)
      checkpoint("sandbox-proxy-ready")
      window.clearTimeout(sandboxReadyTimer)
      const transport = new PostMessageTransport(iframe.contentWindow!, iframe.contentWindow!)
      const deliverResource = async () => {
        resourceSendAttempts += 1
        try {
          await bridge.sendSandboxResourceReady({
            html: secureMcpAppHtml(app),
            csp: app.csp,
            sandbox: "allow-scripts allow-same-origin",
          })
          checkpoint(resourceSendAttempts === 1 ? "resource-sent" : `resource-resent-${resourceSendAttempts}`)
          if (resourceAccepted || initialized) return
          resourceDeliveryTimer = window.setTimeout(() => {
            if (resourceAccepted || initialized) return
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
    window.addEventListener("message", handleSandboxDiagnosticMessage)
    window.addEventListener("message", handleSandboxReady)
    checkpoint("sandbox-navigation-started")
    iframe.src = sandbox.url

    return () => {
      disposed = true
      window.removeEventListener("message", handleSandboxDiagnosticMessage)
      window.removeEventListener("message", handleSandboxReady)
      window.clearTimeout(sandboxReadyTimer)
      if (resourceDeliveryTimer !== undefined) window.clearTimeout(resourceDeliveryTimer)
      if (initializeTimer !== undefined) window.clearTimeout(initializeTimer)
      if (sizeSettleTimer !== undefined) window.clearTimeout(sizeSettleTimer)
      void Promise.race([
        bridge.teardownResource({}),
        new Promise<void>((resolve) => window.setTimeout(resolve, 500)),
      ]).catch(() => undefined).finally(() => bridge.close().catch(() => undefined))
    }
  }, [app, inputArguments, openworkServerClient, result, toolName, workspaceId, readOnly])

  if (error) return <McpAppDiagnosticNotice error={error} notice={unavailableNotice} />
  return (
    <div
      className={cn(
        "mt-3 overflow-hidden rounded-xl bg-background",
        app.prefersBorder && "border border-border",
      )}
      data-mcp-app-resource={app.resourceUri}
    >
      <iframe
        ref={iframeRef}
        title={`${toolName} interactive view`}
        sandbox="allow-scripts allow-same-origin"
        referrerPolicy="no-referrer"
        className="block w-full border-0 bg-transparent"
        style={{ height }}
      />
    </div>
  )
}

export function McpAppFrame({ part }: { part: DynamicToolUIPart }) {
  const result = preservedResult(part)
  const action = reconnectActionFromChatToolResult(part.toolName, result?.structuredContent ?? part.output, part.input)
  if (action) return <ConnectionCard part={part} action={action} />
  const catalog = connectorCatalogFromPart(part)
  if (catalog) return <ConnectorCatalogCard catalog={catalog} />
  return <EmbeddedMcpAppFrame part={part} />
}

function EmbeddedMcpAppFrame({ part }: { part: DynamicToolUIPart }) {
  const { openworkServerClient, workspaceId } = useWorkspace()
  const nextResult = preservedResult(part)
  const nextResultSignature = JSON.stringify(nextResult)
  const resultCache = useRef<{ signature: string; value: PreservedMcpAppResult | null }>({
    signature: nextResultSignature,
    value: nextResult,
  })
  if (resultCache.current.signature !== nextResultSignature) {
    resultCache.current = { signature: nextResultSignature, value: nextResult }
  }
  const result = resultCache.current.value
  const draft = useMemo(() => {
    if (part.toolName !== "save_artifact_view" && !part.toolName.endsWith("_save_artifact_view")) return null
    const reference = result?._meta?.["openwork/appDraft"]
    if (!isRecord(reference) || typeof reference.appId !== "string" || typeof reference.revisionId !== "string"
      || typeof reference.title !== "string" || (reference.receiptId !== undefined && typeof reference.receiptId !== "string")) return null
    return { appId: reference.appId, revisionId: reference.revisionId, title: reference.title, receiptId: reference.receiptId }
  }, [part.toolName, result])
  const launch = useMemo(() => gatewayMcpAppLaunch(result?._meta), [result])
  const [app, setApp] = useState<OpenworkMcpAppResource | null>(null)
  const [error, setError] = useState<McpAppDiagnostic | null>(null)
  const [resolveToken, setResolveToken] = useState(0)
  // The sandbox view unmounts on every preserved-result change; keep the last
  // measured height here so the rebuilt iframe does not snap back to default.
  const heightRef = useRef(DEFAULT_HEIGHT)
  const inputArguments = useMemo(
    () => launch?.arguments ?? (isRecord(part.input) ? part.input : {}),
    [launch, part.input],
  )

  useEffect(() => {
    let cancelled = false
    let retryTimer: number | undefined
    setApp(null)
    setError(null)
    if (draft || !result || !openworkServerClient || !workspaceId) return () => { cancelled = true }
    const startedAt = performance.now()
    const checkpoints = ["resolve-started"]
    const attempt = (attemptIndex: number) => {
      void openworkServerClient.resolveMcpApp(workspaceId, part.toolName, launch ?? undefined)
        .then(({ app: resolved }) => {
          if (cancelled) return
          // A preserved MCP result is neutral transport data. A null resolution
          // means the current tool definition does not advertise an MCP App, so
          // ordinary tools such as save_artifact_view render only their normal
          // result without claiming an unavailable interactive view.
          setApp(resolved)
        })
        .catch((cause) => {
          if (cancelled) return
          checkpoints.push(`resolve-failed-${attemptIndex + 1}+${Math.round(performance.now() - startedAt)}ms`)
          const retryDelayMs = mcpAppResolutionRetryDelayMs(cause, attemptIndex)
          if (retryDelayMs !== null) {
            retryTimer = window.setTimeout(() => attempt(attemptIndex + 1), retryDelayMs)
            return
          }
          if (isActionableMcpAppResolutionError(cause)) {
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
    }
    attempt(0)
    return () => {
      cancelled = true
      if (retryTimer !== undefined) window.clearTimeout(retryTimer)
    }
  }, [draft, launch, openworkServerClient, part.toolName, resolveToken, result, workspaceId])

  // A completed build opens a native artifact tab. Rendering still goes
  // through the authorized Apps API and the shared sandbox inside that tab.
  if (draft) return <AppChatArtifact key={`${draft.appId}:${draft.revisionId}:${draft.receiptId}`} {...draft} />
  const viewId = result?._meta?.artifactViewId
  const revisionId = result?._meta?.viewRevisionId
  if (app && typeof viewId === "string" && typeof revisionId === "string" && app.resourceUri === `ui://openwork/artifacts/${viewId}/views/${revisionId}/index.html`) {
    const artifact = result?.structuredContent?.artifact
    const title = typeof result?._meta?.appTitle === "string" ? result._meta.appTitle : isRecord(artifact) && typeof artifact.title === "string" ? artifact.title : "App preview"
    const receiptId = isRecord(artifact) && typeof artifact.receiptId === "string" ? artifact.receiptId : undefined
    return <AppChatArtifact key={`${viewId}:${revisionId}:${receiptId}`} appId={viewId} revisionId={revisionId} title={title} receiptId={receiptId} />
  }
  if (!result || (!app && !error)) return null
  if (error) return <McpAppDiagnosticNotice error={error} notice={CHAT_MCP_APP_UNAVAILABLE_NOTICE} onRetry={() => setResolveToken((token) => token + 1)} />
  if (!app) return null
  return (
    <McpAppSandboxView
      app={app}
      toolName={part.toolName}
      inputArguments={inputArguments}
      result={result}
      unavailableNotice={CHAT_MCP_APP_UNAVAILABLE_NOTICE}
      onRequestTeardown={() => setApp(null)}
      initialHeight={heightRef.current}
      onHeightChange={(next) => { heightRef.current = next }}
    />
  )
}
