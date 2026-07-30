import { describe, expect, test } from "bun:test"
import {
  UI_ARTIFACT_PROJECT_SCHEMA_VERSION,
  type UiArtifactAttachment,
} from "@openwork/types/ui-artifact-project"

import {
  dynamicArtifactStateSummary,
  mergeDynamicArtifactPrompt,
  parseUiArtifactAttachment,
} from "../src/react-app/domains/session/ui-artifacts/dynamic-artifact-attachment"
import {
  buildDynamicArtifactSrcDoc,
  parseDynamicArtifactFrameMessage,
  sanitizeDynamicArtifactError,
} from "../src/react-app/domains/session/ui-artifacts/dynamic-artifact-bridge"
import { useDynamicArtifactSelectionStore } from "../src/react-app/domains/session/ui-artifacts/dynamic-artifact-selection-store"

const DIGEST = "a".repeat(64)
const ATTACHMENT = {
  protocol: "openwork.ui-artifact-attachment",
  schemaVersion: UI_ARTIFACT_PROJECT_SCHEMA_VERSION,
  workspaceId: "workspace-test",
  slug: "launch-radar",
  title: "Launch Radar",
  projectRevision: DIGEST,
  buildDigest: "b".repeat(64),
  instanceId: "launch-radar-test",
  presentation: {
    placement: "both",
    shape: "collection",
  },
  buildPath: `/workspace/workspace-test/ui-artifacts/launch-radar/builds/${DIGEST}`,
  stateRevision: "c".repeat(64),
} satisfies UiArtifactAttachment

describe("dynamic artifact attachment discovery", () => {
  test("finds an exact v2 receipt in any allowed completed-tool wrapper branch", () => {
    const wrapped = {
      structuredContent: { harmless: true },
      result: {
        protocol: "openwork.ui-artifact-publish-receipt",
        schemaVersion: 2,
        attachment: ATTACHMENT,
        build: {},
        publishedAt: "2026-07-28T12:00:00.000Z",
      },
    }
    expect(parseUiArtifactAttachment(wrapped)).toEqual(ATTACHMENT)
    expect(parseUiArtifactAttachment({
      content: [
        { type: "text", text: "{\"message\":\"not an artifact\"}" },
        { type: "text", text: JSON.stringify({ attachment: ATTACHMENT }) },
      ],
    })).toEqual(ATTACHMENT)
  })

  test("fails closed for a lookalike protocol and oversized envelope", () => {
    expect(parseUiArtifactAttachment({
      ...ATTACHMENT,
      protocol: "untrusted.ui-artifact-attachment",
    })).toBeNull()
    expect(parseUiArtifactAttachment({
      result: ATTACHMENT,
      padding: "x".repeat(70_000),
    })).toBeNull()
  })
})

describe("dynamic artifact bridge policy", () => {
  const ready = {
    protocol: "openwork.ui-artifact-bridge",
    schemaVersion: UI_ARTIFACT_PROJECT_SCHEMA_VERSION,
    instanceId: ATTACHMENT.instanceId,
    nonce: "0123456789abcdef",
    seq: 4,
    type: "artifact.ready",
    payload: {},
  }

  test("accepts only the bound instance, nonce, and next monotonic sequence", () => {
    expect(parseDynamicArtifactFrameMessage(ready, {
      instanceId: ATTACHMENT.instanceId,
      nonce: ready.nonce,
      afterSeq: 3,
    })?.type).toBe("artifact.ready")
    expect(parseDynamicArtifactFrameMessage(ready, {
      instanceId: ATTACHMENT.instanceId,
      nonce: ready.nonce,
      afterSeq: 4,
    })).toBeNull()
    expect(parseDynamicArtifactFrameMessage(ready, {
      instanceId: "other-instance",
      nonce: ready.nonce,
      afterSeq: 3,
    })).toBeNull()
  })

  test("emits a no-network, exact-runtime CSP and sanitizes runtime errors", () => {
    const runtimeUrl = "https://app.test/assets/artifact-runtime.abc123.js"
    const srcDoc = buildDynamicArtifactSrcDoc(runtimeUrl)
    expect(srcDoc).toContain(`script-src ${runtimeUrl} blob:`)
    expect(srcDoc).toContain(`<script src="${runtimeUrl}"></script>`)
    expect(srcDoc).toContain("connect-src 'none'")
    expect(srcDoc).toContain("form-action 'none'")
    expect(srcDoc).not.toContain("allow-same-origin")
    expect(sanitizeDynamicArtifactError(new Error("failed at https://secret.test/token"))).not.toContain("secret.test")
  })

  test("allows Vite's development module graph only from the runtime origin", () => {
    const runtimeUrl = "http://localhost:25040/src/dynamic-artifact-frame-runtime.tsx?worker_file&type=module"
    const srcDoc = buildDynamicArtifactSrcDoc(runtimeUrl)
    expect(srcDoc).toContain("script-src http://localhost:25040 blob:")
    expect(srcDoc).not.toContain("script-src http://localhost:25040/src/")
    expect(srcDoc).toContain("'sha256-UdqoyTJsJVmqS5BkZgs+Nf0XMZGeABWzvccmLU73T3E='")
    expect(srcDoc).toContain("globalThis.$RefreshSig$=()=>type=>type")
    expect(srcDoc).toContain(`<script type="module" src="${runtimeUrl.replaceAll("&", "&amp;")}"></script>`)
  })
})

describe("dynamic artifact studio UI state", () => {
  test("exposes deterministic state summary and workspace-scoped project selection", () => {
    expect(dynamicArtifactStateSummary({ watching: "apollo" })).toBe("watching-apollo")
    expect(mergeDynamicArtifactPrompt("Keep my draft", "Staged intent")).toBe(
      "Keep my draft\n\n---\n\nStaged intent",
    )
    useDynamicArtifactSelectionStore.getState().selectProject({
      workspaceId: ATTACHMENT.workspaceId,
      slug: ATTACHMENT.slug,
      attachment: ATTACHMENT,
    })
    expect(useDynamicArtifactSelectionStore.getState().selection?.slug).toBe("launch-radar")
    useDynamicArtifactSelectionStore.getState().clearSelection("another-workspace")
    expect(useDynamicArtifactSelectionStore.getState().selection?.slug).toBe("launch-radar")
    useDynamicArtifactSelectionStore.getState().clearSelection(ATTACHMENT.workspaceId)
    expect(useDynamicArtifactSelectionStore.getState().selection).toBeNull()
    useDynamicArtifactSelectionStore.getState().selectProject({
      workspaceId: ATTACHMENT.workspaceId,
      slug: ATTACHMENT.slug,
    })
    expect(useDynamicArtifactSelectionStore.getState().selection?.attachment).toEqual(ATTACHMENT)
    useDynamicArtifactSelectionStore.getState().selectProject({
      workspaceId: "another-workspace",
      slug: ATTACHMENT.slug,
    })
    expect(useDynamicArtifactSelectionStore.getState().selection?.attachment).toBeUndefined()
  })
})
