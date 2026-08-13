"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import type { DynamicToolUIPart } from "ai"
import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"

import { OpenworkServerError, type OpenworkMcpAppResource, type OpenworkMcpAppToolResult } from "@/app/lib/openwork-server"
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
const INITIALIZE_TIMEOUT_MS = 10_000

type PreservedMcpAppResult = {
  content: Array<Record<string, unknown>>
  structuredContent?: Record<string, unknown>
  _meta?: Record<string, unknown>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function preservedResult(part: DynamicToolUIPart): PreservedMcpAppResult | null {
  const openwork = isRecord(part.callProviderMetadata?.openwork) ? part.callProviderMetadata.openwork : null
  const result = openwork && isRecord(openwork.mcpApp) ? openwork.mcpApp : null
  if (!result || !Array.isArray(result.content)) return null
  const content = result.content.filter(isRecord) as Array<Record<string, unknown>>
  if (content.length !== result.content.length) return null
  return {
    content,
    ...(isRecord(result.structuredContent) ? { structuredContent: result.structuredContent } : {}),
    ...(isRecord(result._meta) ? { _meta: result._meta } : {}),
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

export function McpAppFrame({ part }: { part: DynamicToolUIPart }) {
  const { openworkServerClient, workspaceId } = useWorkspace()
  const result = useMemo(() => preservedResult(part), [part])
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const [app, setApp] = useState<OpenworkMcpAppResource | null>(null)
  const [height, setHeight] = useState(DEFAULT_HEIGHT)
  const [error, setError] = useState<McpAppDiagnostic | null>(null)
  const [detailsCopied, setDetailsCopied] = useState(false)

  useEffect(() => {
    let cancelled = false
    setApp(null)
    setError(null)
    setDetailsCopied(false)
    if (!result || !openworkServerClient || !workspaceId) return () => { cancelled = true }
    const startedAt = performance.now()
    void openworkServerClient.resolveMcpApp(workspaceId, part.toolName)
      .then(({ app: resolved }) => {
        if (cancelled) return
        if (resolved) {
          setApp(resolved)
          return
        }
        const diagnostic: McpAppDiagnostic = {
          code: "MCP_APP_RESOURCE_NOT_FOUND",
          stage: "resource-resolution",
          message: "The completed tool result referenced an interactive view, but the current tool definition did not resolve to an MCP App resource.",
          toolName: part.toolName,
          elapsedMs: Math.round(performance.now() - startedAt),
          checkpoints: ["resolve-started", "resolve-empty"],
        }
        console.error(`[OpenWork MCP App] ${diagnostic.code}`, diagnostic)
        setError(diagnostic)
      })
      .catch((cause) => {
        if (!cancelled) {
          const diagnostic: McpAppDiagnostic = {
            code: "MCP_APP_RESOURCE_RESOLUTION_FAILED",
            ...(cause instanceof OpenworkServerError ? { causeCode: cause.code } : {}),
            stage: "resource-resolution",
            message: safeMcpAppDiagnosticMessage(cause, "The interactive view resource could not be resolved."),
            toolName: part.toolName,
            elapsedMs: Math.round(performance.now() - startedAt),
            checkpoints: ["resolve-started"],
          }
          console.error(`[OpenWork MCP App] ${diagnostic.code}`, diagnostic)
          setError(diagnostic)
        }
      })
    return () => { cancelled = true }
  }, [openworkServerClient, part.toolName, result, workspaceId])

  useEffect(() => {
    const iframe = iframeRef.current
    if (!app || !result || !iframe || !iframe.contentWindow || !openworkServerClient || !workspaceId) return
    let disposed = false
    let lastSizeEventAt = 0
    const startedAt = performance.now()
    const checkpoints: string[] = []
    let sandboxDocument: McpAppDiagnostic["sandboxDocument"]
    const checkpoint = (name: string) => checkpoints.push(`${name}+${Math.round(performance.now() - startedAt)}ms`)
    const fail = (
      code: string,
      stage: McpAppDiagnosticStage,
      cause: unknown,
      fallback: string,
      sandboxOrigin?: string,
    ) => {
      if (disposed) return
      const diagnostic: McpAppDiagnostic = {
        code,
        stage,
        message: safeMcpAppDiagnosticMessage(cause, fallback),
        toolName: part.toolName,
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
      { serverTools: {} },
      {
        hostContext: {
          theme: document.documentElement.classList.contains("dark") ? "dark" : "light",
          displayMode: "inline",
        },
      },
    )
    let initializeTimer: number | undefined
    let initialized = false
    let proxyReady = false
    const sandboxReadyTimer = window.setTimeout(() => {
      fail(
        "MCP_APP_SANDBOX_PROXY_TIMEOUT",
        "sandbox-proxy",
        null,
        "The sandbox proxy did not report that it was ready within 5 seconds.",
        sandbox.expectedOrigin,
      )
    }, SANDBOX_READY_TIMEOUT_MS)

    bridge.onsizechange = ({ height: requestedHeight }) => {
      const now = Date.now()
      if (now - lastSizeEventAt < SIZE_EVENT_INTERVAL_MS || !Number.isFinite(requestedHeight)) return
      lastSizeEventAt = now
      setHeight(Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.ceil(requestedHeight ?? DEFAULT_HEIGHT))))
    }
    bridge.onrequestteardown = () => {
      setApp(null)
    }
    bridge.oncalltool = async ({ name, arguments: args }) => mcpToolResult(
      await openworkServerClient.callMcpAppTool(workspaceId, {
        serverName: app.serverName,
        name,
        arguments: args,
      }),
    )
    bridge.oninitialized = () => {
      initialized = true
      checkpoint("app-initialized")
      if (initializeTimer !== undefined) window.clearTimeout(initializeTimer)
      void bridge.sendToolInput({
        arguments: isRecord(part.input) ? part.input : {},
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
    const handleSandboxMessage = (event: MessageEvent) => {
      if (event.source !== iframe.contentWindow
        || event.origin !== sandbox.expectedOrigin
        || !isRecord(event.data)) return
      if (event.data.method === "ui/notifications/sandbox-resource-loaded") {
        event.stopImmediatePropagation()
        const params = isRecord(event.data.params) ? event.data.params : {}
        sandboxDocument = {
          readyState: typeof params.readyState === "string" ? params.readyState : null,
          hasHtmlRoot: typeof params.hasHtmlRoot === "boolean" ? params.hasHtmlRoot : null,
          scriptCount: typeof params.scriptCount === "number" ? params.scriptCount : null,
        }
        checkpoint("resource-document-loaded")
        return
      }
      if (event.data.method === "ui/notifications/sandbox-resource-accepted") {
        event.stopImmediatePropagation()
        checkpoint("resource-accepted")
        return
      }
      if (event.data.method === "ui/notifications/sandbox-diagnostic") {
        event.stopImmediatePropagation()
        const params = isRecord(event.data.params) ? event.data.params : {}
        fail(
          typeof params.code === "string" ? params.code : "MCP_APP_SANDBOX_RESOURCE_FAILED",
          "resource-delivery",
          typeof params.message === "string" ? params.message : null,
          "The sandbox could not load the MCP App resource.",
          sandbox.expectedOrigin,
        )
        return
      }
      if (event.data.method !== "ui/notifications/sandbox-proxy-ready") return
      event.stopImmediatePropagation()
      if (proxyReady) return
      proxyReady = true
      checkpoint("sandbox-proxy-ready")
      window.clearTimeout(sandboxReadyTimer)
      const transport = new PostMessageTransport(iframe.contentWindow!, iframe.contentWindow!)
      void bridge.connect(transport)
        .then(() => {
          checkpoint("bridge-connected")
          return bridge.sendSandboxResourceReady({
            html: secureMcpAppHtml(app),
            csp: app.csp,
            sandbox: "allow-scripts allow-same-origin",
          })
        })
        .then(() => {
          checkpoint("resource-sent")
          if (!initialized) {
            initializeTimer = window.setTimeout(() => {
              const message = sandboxDocument
                ? "The HTML document loaded, but the MCP App did not send ui/notifications/initialized within 10 seconds."
                : "The resource was sent to the sandbox, but its document did not report loading or complete MCP Apps initialization within 10 seconds."
              fail(
                "MCP_APP_INITIALIZE_TIMEOUT",
                "app-initialization",
                null,
                message,
                sandbox.expectedOrigin,
              )
            }, INITIALIZE_TIMEOUT_MS)
          }
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
    window.addEventListener("message", handleSandboxMessage)
    checkpoint("sandbox-navigation-started")
    iframe.src = sandbox.url

    return () => {
      disposed = true
      window.removeEventListener("message", handleSandboxMessage)
      window.clearTimeout(sandboxReadyTimer)
      if (initializeTimer !== undefined) window.clearTimeout(initializeTimer)
      void Promise.race([
        bridge.teardownResource({}),
        new Promise<void>((resolve) => window.setTimeout(resolve, 500)),
      ]).catch(() => undefined).finally(() => bridge.close().catch(() => undefined))
    }
  }, [app, openworkServerClient, part.input, result, workspaceId])

  if (!result || (!app && !error)) return null
  if (error) {
    const details = formatMcpAppDiagnostic(error)
    return (
      <div className="mt-2 text-xs text-muted-foreground" role="status">
        <p>Interactive view unavailable. The normal tool result is still available. {error.message}</p>
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

  return (
    <div
      className={cn(
        "mt-3 overflow-hidden rounded-xl bg-background",
        app?.prefersBorder && "border border-border",
      )}
      data-mcp-app-resource={app?.resourceUri}
    >
      <iframe
        ref={iframeRef}
        title={`${part.toolName} interactive view`}
        sandbox="allow-scripts allow-same-origin"
        referrerPolicy="no-referrer"
        className="block w-full border-0 bg-transparent"
        style={{ height }}
      />
    </div>
  )
}
