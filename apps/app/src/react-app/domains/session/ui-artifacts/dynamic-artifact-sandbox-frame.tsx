import * as React from "react"
import { AlertTriangle, LoaderCircle } from "lucide-react"
import {
  UI_ARTIFACT_PROJECT_SCHEMA_VERSION,
  UI_ARTIFACT_SHAPE_SPECS,
  uiArtifactHostBridgeEnvelopeSchema,
  uiArtifactInstanceStateSchema,
  uiArtifactIntentResultSchema,
  uiArtifactPinnedBuildSchema,
  type UiArtifactAttachment,
  type UiArtifactHostBridgeEnvelope,
  type UiArtifactInstanceState,
  type UiArtifactIntentRequest,
  type UiArtifactIntentResult,
  type UiArtifactPinnedBuild,
  type UiArtifactStateUpdate,
} from "@openwork/types/ui-artifact-project"

import { cn } from "@/lib/utils"
import {
  DYNAMIC_ARTIFACT_MAX_BRIDGE_BYTES as MAX_BRIDGE_BYTES,
  DYNAMIC_ARTIFACT_MAX_INITIALIZE_BYTES as MAX_INITIALIZE_BYTES,
  buildDynamicArtifactSrcDoc,
  dynamicArtifactSerializedByteLength as serializedByteLength,
  parseDynamicArtifactFrameMessage,
  sanitizeDynamicArtifactError,
  verifyDynamicArtifactBuildDigest,
} from "./dynamic-artifact-bridge"
import runtimeAssetUrl from "./dynamic-artifact-frame-runtime.tsx?worker&url"

const BRIDGE_PROTOCOL = "openwork.ui-artifact-bridge"
const MAX_MESSAGES_PER_SECOND = 48

type FrameState = "error" | "loading" | "ready"

type DynamicArtifactSandboxFrameProps = {
  attachment: UiArtifactAttachment
  className?: string
  host: DynamicArtifactRendererHost
  onFrameStateChange?: (state: FrameState) => void
  onStateChange?: (state: UiArtifactInstanceState) => void
  onStagePrompt: (prompt: string) => void
  refreshToken?: number
  workspaceId: string
}

type LoadedArtifact = {
  build: UiArtifactPinnedBuild
  state: UiArtifactInstanceState
}

export type DynamicArtifactRendererHost = {
  load: () => Promise<LoadedArtifact>
  replaceState: (update: UiArtifactStateUpdate) => Promise<UiArtifactInstanceState>
  stageIntent: (request: UiArtifactIntentRequest) => Promise<UiArtifactIntentResult>
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

class HostArtifactErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: string | null }
> {
  state: { error: string | null } = { error: null }

  static getDerivedStateFromError(error: unknown) {
    return { error: sanitizeDynamicArtifactError(error) }
  }

  componentDidCatch(error: unknown) {
    console.error("[dynamic-artifact-host] render failed", sanitizeDynamicArtifactError(error))
  }

  render() {
    if (this.state.error) {
      return <FrameError message={this.state.error} />
    }
    return this.props.children
  }
}

function FrameError({ message }: { message: string }) {
  return (
    <div className="flex min-h-36 items-center gap-3 rounded-xl border border-red-6/35 bg-red-3/20 px-4 py-3 text-sm">
      <AlertTriangle className="size-4 shrink-0 text-red-10" aria-hidden="true" />
      <div className="min-w-0">
        <p className="font-medium text-red-11">Artifact unavailable</p>
        <p className="mt-0.5 break-words text-xs text-muted-foreground">{message}</p>
      </div>
    </div>
  )
}

function DynamicArtifactSandboxFrameInner(props: DynamicArtifactSandboxFrameProps) {
  const iframeRef = React.useRef<HTMLIFrameElement>(null)
  const iframeInitializedRef = React.useRef(false)
  const [loaded, setLoaded] = React.useState<LoadedArtifact | null>(null)
  const [frameState, setFrameState] = React.useState<FrameState>("loading")
  const [error, setError] = React.useState<string | null>(null)
  const [iframeGeneration, setIframeGeneration] = React.useState(0)
  const height = UI_ARTIFACT_SHAPE_SPECS[props.attachment.presentation.shape].frameHeight
  const runtimeUrl = React.useMemo(
    () => {
      const url = new URL(runtimeAssetUrl, window.location.href)
      if (import.meta.env.DEV) {
        // Bust failed opaque-frame module fetches across Vite config/HMR
        // transitions while keeping production pinned to one built asset.
        url.searchParams.set("openwork-runtime", "2")
      }
      return url.href
    },
    [],
  )
  const srcDoc = React.useMemo(() => buildDynamicArtifactSrcDoc(runtimeUrl), [runtimeUrl])

  React.useEffect(() => {
    props.onFrameStateChange?.(frameState)
  }, [frameState, props.onFrameStateChange])

  React.useEffect(() => {
    let cancelled = false
    setLoaded(null)
    setError(null)
    setFrameState("loading")
    setIframeGeneration(0)
    iframeInitializedRef.current = false

    void props.host.load().then(async ({ build: buildValue, state: stateValue }) => {
      if (cancelled) {
        return
      }

      const build = uiArtifactPinnedBuildSchema.safeParse(buildValue)
      const state = uiArtifactInstanceStateSchema.safeParse(stateValue)
      if (
        !build.success ||
        !state.success ||
        !await verifyDynamicArtifactBuildDigest(build.data) ||
        new TextEncoder().encode(build.data.bundle).byteLength !== build.data.build.bundleBytes ||
        build.data.build.slug !== props.attachment.slug ||
        build.data.manifest.slug !== props.attachment.slug ||
        build.data.build.projectRevision !== props.attachment.projectRevision ||
        build.data.build.buildDigest !== props.attachment.buildDigest ||
        build.data.manifest.presentation.placement !== props.attachment.presentation.placement ||
        build.data.manifest.presentation.shape !== props.attachment.presentation.shape ||
        props.attachment.workspaceId !== props.workspaceId ||
        state.data.projectRevision !== props.attachment.projectRevision ||
        state.data.workspaceId !== props.workspaceId ||
        state.data.slug !== props.attachment.slug ||
        state.data.instanceId !== props.attachment.instanceId
      ) {
        setFrameState("error")
        setError("The pinned artifact revision could not be verified.")
        return
      }

      setLoaded({ build: build.data, state: state.data })
      props.onStateChange?.(state.data)
    }).catch((loadError: unknown) => {
      if (!cancelled) {
        setFrameState("error")
        setError(sanitizeDynamicArtifactError(loadError))
      }
    })

    return () => {
      cancelled = true
    }
  }, [
    props.attachment.buildDigest,
    props.attachment.instanceId,
    props.attachment.projectRevision,
    props.attachment.slug,
    props.attachment.stateRevision,
    props.host,
    props.onStateChange,
    props.refreshToken,
    props.workspaceId,
  ])

  React.useEffect(() => {
    const iframe = iframeRef.current
    if (!iframe || !loaded || iframeGeneration !== 1) {
      return
    }

    let disposed = false
    let inboundSeq = -1
    let outboundSeq = 1
    let state = loaded.state
    let stateWritePending = false
    let queuedState: { value: UiArtifactStateUpdate["state"] } | null = null
    const nonce = crypto.randomUUID()
    const allowInbound = createRateGate()
    const allowOutbound = createRateGate()
    const channel = new MessageChannel()

    const send = (
      message: Omit<UiArtifactHostBridgeEnvelope, "instanceId" | "nonce" | "protocol" | "schemaVersion" | "seq">,
    ): boolean => {
      if (disposed || !allowOutbound()) {
        return false
      }
      const envelope = {
        protocol: BRIDGE_PROTOCOL,
        schemaVersion: UI_ARTIFACT_PROJECT_SCHEMA_VERSION,
        instanceId: props.attachment.instanceId,
        nonce,
        seq: outboundSeq,
        ...message,
      }
      outboundSeq += 1
      const parsed = uiArtifactHostBridgeEnvelopeSchema.safeParse(envelope)
      if (!parsed.success || serializedByteLength(parsed.data) > MAX_BRIDGE_BYTES) {
        return false
      }
      channel.port1.postMessage(parsed.data)
      return true
    }

    const sendState = (next: UiArtifactInstanceState) => {
      state = next
      props.onStateChange?.(next)
      if (!send({ type: "host.state", payload: next })) {
        setFrameState("error")
        setError("The artifact bridge exceeded its safe message limit.")
      }
    }

    const persistState = async (desiredState: UiArtifactStateUpdate["state"]) => {
      if (stateWritePending) {
        queuedState = { value: desiredState }
        return
      }

      stateWritePending = true
      let nextDesired: { value: UiArtifactStateUpdate["state"] } | null = { value: desiredState }
      while (nextDesired && !disposed) {
        try {
          const nextValue = await props.host.replaceState({
            state: nextDesired.value,
            expectedRevision: state.stateRevision,
          })
          const next = uiArtifactInstanceStateSchema.safeParse(nextValue)
          if (!next.success) {
            throw new Error("Artifact state response was invalid")
          }
          sendState(next.data)
        } catch (writeError) {
          setError(sanitizeDynamicArtifactError(writeError))
          try {
            const canonical = await props.host.load()
            const validated = uiArtifactInstanceStateSchema.safeParse(canonical.state)
            if (!validated.success) {
              throw new Error("Artifact state recovery response was invalid")
            }
            sendState(validated.data)
          } catch (reloadError) {
            setFrameState("error")
            setError(sanitizeDynamicArtifactError(reloadError))
            queuedState = null
            break
          }
        }
        nextDesired = queuedState
        queuedState = null
      }
      stateWritePending = false
    }

    const onMessage = (event: MessageEvent<unknown>) => {
      if (
        disposed ||
        !allowInbound() ||
        serializedByteLength(event.data) > MAX_BRIDGE_BYTES
      ) {
        return
      }

      const message = parseDynamicArtifactFrameMessage(event.data, {
        instanceId: props.attachment.instanceId,
        nonce,
        afterSeq: inboundSeq,
      })
      if (!message) {
        return
      }
      inboundSeq = message.seq

      if (message.type === "artifact.ready") {
        setFrameState("ready")
        return
      }

      if (message.type === "artifact.error") {
        setFrameState("error")
        setError(sanitizeDynamicArtifactError(message.payload.message))
        return
      }

      if (message.type === "artifact.state-update") {
        void persistState(message.payload.state)
        return
      }

      if (message.type === "artifact.intent") {
        const request = message.payload
        void props.host.stageIntent(request).then((result) => {
          const validated = uiArtifactIntentResultSchema.safeParse(result)
          if (!validated.success) {
            throw new Error("Artifact intent response was invalid")
          }
          if (!send({ type: "host.intent-result", payload: validated.data })) {
            setFrameState("error")
            setError("The artifact bridge exceeded its safe message limit.")
            return
          }
          if (validated.data.ok) {
            props.onStagePrompt(validated.data.prompt)
          }
        }).catch((intentError: unknown) => {
          const message = sanitizeDynamicArtifactError(intentError)
          setError(message)
          if (!send({
            type: "host.intent-result",
            payload: {
              protocol: "openwork.ui-artifact-intent-result",
              schemaVersion: UI_ARTIFACT_PROJECT_SCHEMA_VERSION,
              ok: false,
              intentId: request.intentId,
              code: "unavailable",
              message,
              stateRevision: state.stateRevision,
            },
          })) {
            setFrameState("error")
            setError("The artifact bridge exceeded its safe message limit.")
          }
        })
      }
    }

    channel.port1.addEventListener("message", onMessage)
    channel.port1.start()

    const initialize = {
      protocol: BRIDGE_PROTOCOL,
      schemaVersion: UI_ARTIFACT_PROJECT_SCHEMA_VERSION,
      instanceId: props.attachment.instanceId,
      nonce,
      seq: 0,
      type: "host.initialize",
      payload: {
        attachment: props.attachment,
        build: loaded.build,
        data: loaded.build.data,
        state,
      },
    }
    const parsedInitialize = uiArtifactHostBridgeEnvelopeSchema.safeParse(initialize)
    if (
      !parsedInitialize.success ||
      serializedByteLength(parsedInitialize.data) > MAX_INITIALIZE_BYTES
    ) {
      channel.port1.close()
      channel.port2.close()
      setFrameState("error")
      setError("Artifact initialization exceeded the safe runtime limit.")
      return
    }
    iframe.contentWindow?.postMessage(parsedInitialize.data, "*", [channel.port2])

    return () => {
      disposed = true
      channel.port1.removeEventListener("message", onMessage)
      channel.port1.close()
      channel.port2.close()
    }
  }, [
    loaded,
    iframeGeneration,
    props.attachment,
    props.host,
    props.onStateChange,
    props.onStagePrompt,
    props.workspaceId,
    srcDoc,
  ])

  if (error && frameState === "error") {
    return <FrameError message={error} />
  }

  return (
    <div
      className={cn("relative overflow-hidden rounded-xl border border-border bg-background", props.className)}
      data-ui-artifact-frame-state={frameState}
      data-ui-artifact-frame-shape={props.attachment.presentation.shape}
      style={{ height }}
    >
      {frameState === "loading" ? (
        <div className="absolute inset-0 z-10 grid place-items-center bg-background/80 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-2">
            <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />
            Loading pinned artifact…
          </span>
        </div>
      ) : null}
      {loaded ? (
        <iframe
          ref={iframeRef}
          title={props.attachment.title}
          className="h-full w-full border-0 bg-transparent"
          sandbox="allow-scripts"
          allow=""
          referrerPolicy="no-referrer"
          srcDoc={srcDoc}
          onLoad={() => {
            if (iframeInitializedRef.current) {
              setIframeGeneration(-1)
              setFrameState("error")
              setError("Artifact navigation was blocked and the runtime was closed.")
              return
            }
            iframeInitializedRef.current = true
            setIframeGeneration(1)
          }}
        />
      ) : null}
    </div>
  )
}

export function DynamicArtifactSandboxFrame(props: DynamicArtifactSandboxFrameProps) {
  return (
    <HostArtifactErrorBoundary>
      <React.Suspense fallback={(
        <div className="grid min-h-36 place-items-center text-xs text-muted-foreground">
          Loading artifact…
        </div>
      )}>
        <DynamicArtifactSandboxFrameInner {...props} />
      </React.Suspense>
    </HostArtifactErrorBoundary>
  )
}
