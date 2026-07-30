import { describe, expect, test } from "bun:test"
import type { UIMessage } from "ai"
import {
  UI_ARTIFACT_RENDER_CAPABILITY,
  UI_ARTIFACT_USE_CAPABILITY,
  UI_ARTIFACT_PROTOCOL,
  UI_ARTIFACT_SCHEMA_VERSION,
  type UiArtifactRenderResult,
} from "@openwork/types/ui-artifact"
import {
  buildUiArtifactDecisionPrompt,
  isUiArtifactRenderInvocation,
  isUiArtifactRenderToolName,
  parseUiArtifactRenderResult,
  reconcileUiArtifactMessages,
} from "@/lib/ui-artifacts"

const RESULT = {
  protocol: UI_ARTIFACT_PROTOCOL,
  schemaVersion: UI_ARTIFACT_SCHEMA_VERSION,
  status: "rendered",
  artifact: {
    artifactId: "widgets.collection",
    instanceId: "test-glance",
    revision: 1,
    operation: "create",
    title: "Today",
    presentation: { placement: "inline", size: "standard" },
    source: { type: "mock", label: "Test" },
    data: {
      layout: "grid",
      widgets: [
        { id: "meetings", kind: "metric", label: "Meetings", value: "2", tone: "info" },
      ],
    },
  },
  narration: {
    summary: "Rendered one metric.",
    visibleFacts: ["Meetings: 2"],
  },
} satisfies UiArtifactRenderResult

describe("UI artifact tool result parsing", () => {
  test("recognizes direct and namespaced render tool names", () => {
    expect(isUiArtifactRenderToolName("render_artifact")).toBe(true)
    expect(isUiArtifactRenderToolName("use_artifact")).toBe(true)
    expect(isUiArtifactRenderToolName("ui-artifacts-demo_render_artifact")).toBe(true)
    expect(isUiArtifactRenderToolName("search_artifacts")).toBe(false)
    expect(isUiArtifactRenderToolName("untrusted_render_artifact")).toBe(false)
    expect(isUiArtifactRenderInvocation("openwork-cloud_execute_capability", {
      name: UI_ARTIFACT_RENDER_CAPABILITY,
    })).toBe(true)
    expect(isUiArtifactRenderInvocation("openwork-cloud_execute_capability", {
      name: UI_ARTIFACT_USE_CAPABILITY,
    })).toBe(true)
    expect(isUiArtifactRenderInvocation("openwork-cloud_execute_capability", {
      name: "mcp:calendar:list_events",
    })).toBe(false)
    expect(isUiArtifactRenderInvocation("untrusted_execute_capability", {
      name: UI_ARTIFACT_RENDER_CAPABILITY,
    })).toBe(false)
  })

  test("parses direct, JSON text, and MCP structured content envelopes", () => {
    expect(parseUiArtifactRenderResult(RESULT)?.artifact.instanceId).toBe("test-glance")
    expect(parseUiArtifactRenderResult(JSON.stringify(RESULT))?.artifact.instanceId).toBe("test-glance")
    expect(parseUiArtifactRenderResult({ structuredContent: RESULT })?.artifact.instanceId).toBe("test-glance")
  })

  test("fails closed for invalid envelopes", () => {
    expect(parseUiArtifactRenderResult({ status: "rendered" })).toBeNull()
    expect(parseUiArtifactRenderResult("not json")).toBeNull()
    expect(parseUiArtifactRenderResult({
      ...RESULT,
      artifact: { ...RESULT.artifact, operation: "replace" },
    })?.artifact.operation).toBe("replace")
    expect(parseUiArtifactRenderResult({
      ...RESULT,
      oversized: "x".repeat(40_001),
    })).toBeNull()
  })

  test("builds a minimal explicit mock decision prompt", () => {
    const prompt = buildUiArtifactDecisionPrompt({
      id: "approve-expense",
      label: "Approve",
      type: "request_decision",
      instanceId: "demo-approval-queue",
      itemId: "expense-lisbon",
      decision: "approve",
      expectedRevision: 3,
    })
    expect(prompt).toContain(UI_ARTIFACT_USE_CAPABILITY)
    expect(prompt).toContain('"expectedRevision":3')
    expect(prompt).toContain("Do not call a provider approval tool")
    expect(prompt).not.toContain("Customer workshop travel")
  })

  test("keeps only the newest native revision for an artifact instance", () => {
    const replacement = {
      ...RESULT,
      artifact: {
        ...RESULT.artifact,
        revision: 2,
        operation: "replace",
      },
    } satisfies UiArtifactRenderResult
    const messages = [
      {
        id: "assistant-create",
        role: "assistant",
        parts: [{
          type: "dynamic-tool",
          toolName: "openwork-cloud_execute_capability",
          toolCallId: "create",
          state: "output-available",
          input: { name: UI_ARTIFACT_USE_CAPABILITY },
          output: RESULT,
        }],
      },
      {
        id: "assistant-replace",
        role: "assistant",
        parts: [{
          type: "dynamic-tool",
          toolName: "openwork-cloud_execute_capability",
          toolCallId: "replace",
          state: "output-available",
          input: { name: UI_ARTIFACT_USE_CAPABILITY },
          output: replacement,
        }],
      },
    ] satisfies UIMessage[]

    const reconciled = reconcileUiArtifactMessages(messages)
    expect(reconciled[0]?.parts).toHaveLength(0)
    expect(reconciled[1]?.parts).toHaveLength(1)
    const single = messages.slice(0, 1)
    expect(reconcileUiArtifactMessages(single)).toBe(single)
  })
})
