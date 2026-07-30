/* @refresh skip */

import * as React from "react"
import { createRoot } from "react-dom/client"
import {
  UI_ARTIFACT_PROJECT_SCHEMA_VERSION,
  uiArtifactFrameBridgeEnvelopeSchema,
  uiArtifactHostBridgeEnvelopeSchema,
  type UiArtifactFrameBridgeEnvelope,
  type UiArtifactHostBridgeEnvelope,
  type UiArtifactInstanceState,
  type UiArtifactIntentRequest,
  type UiArtifactIntentResult,
} from "@openwork/types/ui-artifact-project"

declare global {
  var __OPENWORK_ARTIFACT_REACT__: typeof React | undefined
}

const BRIDGE_PROTOCOL = "openwork.ui-artifact-bridge"
const MAX_INITIALIZE_BYTES = 1_100_000
const MAX_BRIDGE_BYTES = 96_000
const MAX_MESSAGES_PER_SECOND = 48
const INTENT_TIMEOUT_MS = 15_000

type ArtifactRuntimeProps = {
  data: unknown
  state: UiArtifactInstanceState["state"]
  runtime: {
    invoke: (intentId: string, payload: UiArtifactIntentRequest["payload"]) => Promise<UiArtifactIntentResult>
    replaceState: (next: UiArtifactInstanceState["state"]) => void
  }
}

type ArtifactModule = {
  default: React.ComponentType<ArtifactRuntimeProps>
}

function serializedByteLength(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

function isArtifactModule(value: unknown): value is ArtifactModule {
  return Boolean(
    value &&
    typeof value === "object" &&
    "default" in value &&
    typeof value.default === "function",
  )
}

function sanitizeError(value: unknown) {
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

function createRateGate() {
  let startedAt = performance.now()
  let count = 0

  return () => {
    const now = performance.now()
    if (now - startedAt >= 1_000) {
      startedAt = now
      count = 0
    }
    count += 1
    return count <= MAX_MESSAGES_PER_SECOND
  }
}

class ArtifactErrorBoundary extends React.Component<
  { children: React.ReactNode; report: (error: unknown) => void },
  { error: string | null }
> {
  state: { error: string | null } = { error: null }

  static getDerivedStateFromError(error: unknown) {
    return { error: sanitizeError(error) }
  }

  componentDidCatch(error: unknown) {
    this.props.report(error)
  }

  render() {
    if (this.state.error) {
      return (
        <div role="alert" className="openwork-artifact-error">
          <strong>Artifact unavailable</strong>
          <span>{this.state.error}</span>
        </div>
      )
    }

    return this.props.children
  }
}

function LoadingShell() {
  return (
    <div className="openwork-artifact-loading" aria-label="Loading artifact">
      <span />
      <span />
      <span />
    </div>
  )
}

function RuntimeReadyReporter({ onReady }: { onReady: () => void }) {
  React.useEffect(onReady, [onReady])
  return null
}

function bootRuntime(initial: UiArtifactHostBridgeEnvelope, port: MessagePort) {
  if (initial.type !== "host.initialize") {
    port.close()
    return
  }

  const { attachment, build } = initial.payload
  const intentIds = new Set(build.manifest.intents.map((intent) => intent.id))
  const allowInbound = createRateGate()
  const allowOutbound = createRateGate()
  const rootElement = document.getElementById("root")
  if (!rootElement) {
    port.close()
    return
  }
  document.documentElement.dataset.openworkArtifactShape = attachment.presentation.shape
  rootElement.dataset.openworkArtifactShape = attachment.presentation.shape

  let inboundSeq = initial.seq
  let outboundSeq = 0
  let currentState = initial.payload.state
  let currentData = initial.payload.data
  let disposed = false
  const pendingIntents = new Map<
    string,
    {
      resolve: (result: UiArtifactIntentResult) => void
      reject: (error: Error) => void
      timeout: ReturnType<typeof setTimeout>
    }
  >()
  const root = createRoot(rootElement)

  const send = (
    message: Omit<UiArtifactFrameBridgeEnvelope, "instanceId" | "nonce" | "protocol" | "schemaVersion" | "seq">,
  ): boolean => {
    if (disposed || !allowOutbound()) {
      return false
    }

    const envelope = {
      protocol: BRIDGE_PROTOCOL,
      schemaVersion: UI_ARTIFACT_PROJECT_SCHEMA_VERSION,
      instanceId: attachment.instanceId,
      nonce: initial.nonce,
      seq: outboundSeq,
      ...message,
    }
    outboundSeq += 1
    const parsed = uiArtifactFrameBridgeEnvelopeSchema.safeParse(envelope)
    if (!parsed.success || serializedByteLength(parsed.data) > MAX_BRIDGE_BYTES) {
      return false
    }
    port.postMessage(parsed.data)
    return true
  }

  const reportError = (error: unknown) => {
    send({
      type: "artifact.error",
      payload: { message: sanitizeError(error) },
    })
  }

  const blockNavigation = (event: Event) => {
    if (event.cancelable) {
      event.preventDefault()
    }
    event.stopImmediatePropagation()
    reportError("Artifact navigation was blocked")
  }
  const navigationValue: unknown = Reflect.get(globalThis, "navigation")
  if (
    navigationValue &&
    typeof navigationValue === "object" &&
    "addEventListener" in navigationValue &&
    typeof navigationValue.addEventListener === "function"
  ) {
    navigationValue.addEventListener("navigate", blockNavigation)
  }
  document.addEventListener("click", (event) => {
    if (event.target instanceof Element && event.target.closest("a[href], area[href]")) {
      blockNavigation(event)
    }
  }, true)
  document.addEventListener("submit", blockNavigation, true)

  const runtime: ArtifactRuntimeProps["runtime"] = {
    invoke: (intentId, payload) => {
      if (!intentIds.has(intentId)) {
        return Promise.reject(new Error("Unknown artifact intent"))
      }
      if (pendingIntents.has(intentId)) {
        return Promise.reject(new Error("Artifact intent is already pending"))
      }

      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          pendingIntents.delete(intentId)
          reject(new Error("Artifact intent staging timed out"))
        }, INTENT_TIMEOUT_MS)
        pendingIntents.set(intentId, { resolve, reject, timeout })
        const sent = send({
          type: "artifact.intent",
          payload: {
            intentId,
            payload,
            expectedStateRevision: currentState.stateRevision,
          },
        })
        if (!sent) {
          clearTimeout(timeout)
          pendingIntents.delete(intentId)
          reject(new Error("Artifact intent could not be staged"))
        }
      })
    },
    replaceState: (next) => {
      send({
        type: "artifact.state-update",
        payload: {
          state: next,
          expectedRevision: currentState.stateRevision,
        },
      })
    },
  }

  globalThis.__OPENWORK_ARTIFACT_REACT__ = React
  const bundleUrl = URL.createObjectURL(new Blob([build.bundle], { type: "text/javascript" }))
  const Artifact = React.lazy(async () => {
    const module: unknown = await import(/* @vite-ignore */ bundleUrl)
    if (!isArtifactModule(module)) {
      throw new Error("Compiled artifact must export a React component as default")
    }
    return module
  })

  const ready = () => {
    send({ type: "artifact.ready", payload: {} })
  }

  const render = () => {
    root.render(
      <ArtifactErrorBoundary report={reportError}>
        <React.Suspense fallback={<LoadingShell />}>
          <Artifact data={currentData} state={currentState.state} runtime={runtime} />
          <RuntimeReadyReporter onReady={ready} />
        </React.Suspense>
      </ArtifactErrorBoundary>,
    )
  }

  const onPortMessage = (event: MessageEvent<unknown>) => {
    if (
      disposed ||
      !allowInbound() ||
      serializedByteLength(event.data) > MAX_BRIDGE_BYTES
    ) {
      return
    }

    const parsed = uiArtifactHostBridgeEnvelopeSchema.safeParse(event.data)
    if (
      !parsed.success ||
      parsed.data.instanceId !== attachment.instanceId ||
      parsed.data.nonce !== initial.nonce ||
      parsed.data.seq <= inboundSeq
    ) {
      return
    }
    inboundSeq = parsed.data.seq

    if (parsed.data.type === "host.state") {
      currentState = parsed.data.payload
      render()
      return
    }

    if (parsed.data.type === "host.intent-result") {
      const pending = pendingIntents.get(parsed.data.payload.intentId)
      if (!pending) {
        return
      }
      pendingIntents.delete(parsed.data.payload.intentId)
      clearTimeout(pending.timeout)
      if (parsed.data.payload.ok) {
        pending.resolve(parsed.data.payload)
      } else {
        pending.reject(new Error(parsed.data.payload.message))
      }
    }
  }

  port.addEventListener("message", onPortMessage)
  port.start()

  const style = document.createElement("style")
  style.textContent = build.styles
  document.head.append(style)

  const onError = (event: ErrorEvent) => reportError(event.error ?? event.message)
  const onUnhandledRejection = (event: PromiseRejectionEvent) => reportError(event.reason)
  window.addEventListener("error", onError)
  window.addEventListener("unhandledrejection", onUnhandledRejection)

  window.addEventListener("pagehide", () => {
    disposed = true
    port.removeEventListener("message", onPortMessage)
    port.close()
    root.unmount()
    URL.revokeObjectURL(bundleUrl)
    delete document.documentElement.dataset.openworkArtifactShape
    delete globalThis.__OPENWORK_ARTIFACT_REACT__
    for (const pending of pendingIntents.values()) {
      clearTimeout(pending.timeout)
      pending.reject(new Error("Artifact runtime closed"))
    }
    pendingIntents.clear()
  }, { once: true })

  render()
}

const allowInitialize = createRateGate()
let initialized = false

if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("message", (event: MessageEvent<unknown>) => {
    if (
      initialized ||
      event.source !== window.parent ||
      event.ports.length !== 1 ||
      !allowInitialize() ||
      serializedByteLength(event.data) > MAX_INITIALIZE_BYTES
    ) {
      return
    }

    const parsed = uiArtifactHostBridgeEnvelopeSchema.safeParse(event.data)
    if (!parsed.success || parsed.data.type !== "host.initialize") {
      event.ports[0]?.close()
      return
    }

    initialized = true
    bootRuntime(parsed.data, event.ports[0])
  })
}

// Vite replaces `?worker&url` imports of this module with the built asset URL.
// Bun loads the source module directly during component tests, so keep a
// harmless default export available for that non-browser import path.
export default ""
