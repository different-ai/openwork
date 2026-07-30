import { describe, expect, test } from "bun:test"
import {
  UI_ARTIFACT_KINDS,
  UI_ARTIFACT_SEARCH_CAPABILITY,
  UI_ARTIFACT_USE_CAPABILITY,
  uiArtifactRenderResultSchema,
  uiArtifactSearchResultSchema,
  uiArtifactSuggestionEnvelopeSchema,
  type UiArtifactPreferences,
} from "@openwork/types/ui-artifact"
import {
  appendUiArtifactSuggestion,
  executeUiArtifactCapability,
  searchUiArtifactCapabilities,
  suggestUiArtifactForCapability,
} from "../src/mcp/ui-artifacts.js"

const ENABLED_PREFERENCES = {
  protocol: "openwork.ui-artifact-preferences",
  schemaVersion: "1",
  enabled: true,
  enabledArtifactIds: [...UI_ARTIFACT_KINDS],
  updatedAt: "2026-07-23T10:00:00.000Z",
} satisfies UiArtifactPreferences

describe("execute_capability UI artifact adapter", () => {
  test("discovers virtual search and use capabilities only when enabled", () => {
    const matches = searchUiArtifactCapabilities("artifact widget", 5, ENABLED_PREFERENCES)
    expect(matches.map((match) => match.name)).toEqual([
      UI_ARTIFACT_SEARCH_CAPABILITY,
      UI_ARTIFACT_USE_CAPABILITY,
    ])
    expect(searchUiArtifactCapabilities("artifact widget", 5, {
      ...ENABLED_PREFERENCES,
      enabled: false,
    })).toEqual([])
  })

  test("does not enrich ordinary capability results when disabled", () => {
    const disabledPreferences = {
      ...ENABLED_PREFERENCES,
      enabled: false,
    }
    const suggestion = suggestUiArtifactForCapability({
      capability: "mcp:google-calendar:list_events",
      title: "List calendar events",
      body: { calendarId: "private-calendar-id" },
      preferences: disabledPreferences,
    })
    const original = {
      content: [{ type: "text" as const, text: "{\"events\":[]}" }],
    }

    expect(suggestion).toBeNull()
    expect(appendUiArtifactSuggestion(original, suggestion)).toBe(original)
    expect(executeUiArtifactCapability({
      name: UI_ARTIFACT_SEARCH_CAPABILITY,
      body: { query: "calendar events today" },
      preferences: disabledPreferences,
      stateScope: "member-disabled",
    })?.structuredContent).toMatchObject({ code: "artifact_disabled" })
  })

  test("searches and renders through virtual execute_capability names", () => {
    const searched = executeUiArtifactCapability({
      name: UI_ARTIFACT_SEARCH_CAPABILITY,
      body: {
        query: "calendar events today",
        signal: { toolName: "google_calendar_list_events" },
        limit: 1,
      },
      preferences: ENABLED_PREFERENCES,
      stateScope: "member-calendar",
    })
    expect(searched?.isError).not.toBe(true)
    const searchResult = uiArtifactSearchResultSchema.parse(searched?.structuredContent)
    expect(searchResult.matches[0]?.artifactId).toBe("calendar.view")
    expect(searchResult.matches[0]?.toolDefinition.invocation).toEqual({
      toolName: "execute_capability",
      capability: UI_ARTIFACT_USE_CAPABILITY,
      argumentsField: "body",
    })

    const rendered = executeUiArtifactCapability({
      name: UI_ARTIFACT_USE_CAPABILITY,
      body: searchResult.matches[0]?.toolDefinition.exampleArguments,
      preferences: ENABLED_PREFERENCES,
      stateScope: "member-calendar",
    })
    expect(rendered?.isError).not.toBe(true)
    const renderResult = uiArtifactRenderResultSchema.parse(rendered?.structuredContent)
    expect(renderResult.artifact.artifactId).toBe("calendar.view")
    expect(renderResult.status).toBe("rendered")
  })

  test("adds a bounded suggestion only after a matching ordinary capability", () => {
    const suggestion = suggestUiArtifactForCapability({
      capability: "mcp:google-calendar:list_events",
      title: "List calendar events",
      body: {
        calendarId: "private-calendar-id",
        accessToken: "must-not-be-copied",
      },
      preferences: ENABLED_PREFERENCES,
    })
    const parsed = uiArtifactSuggestionEnvelopeSchema.parse(suggestion)
    expect(parsed.suggestions[0]?.artifactId).toBe("calendar.view")
    expect(parsed.agentInstruction).toContain("expires at the end of the current turn")
    expect(parsed.agentInstruction).toContain("Render at most one suggestion")
    expect(parsed.agentInstruction).toContain("never replace its payload with provider values")
    expect(parsed.agentInstruction).toContain("never infer or execute an approval decision")
    expect(parsed.contextPolicy).toEqual({
      selection: "optional",
      maxRendersThisTurn: 1,
      expires: "end_of_turn",
      dedupeKey: "mcp:google-calendar:list_events:calendar.view",
      includesSourceValues: false,
    })
    const serialized = JSON.stringify(parsed)
    expect(serialized).not.toContain("private-calendar-id")
    expect(serialized).not.toContain("must-not-be-copied")

    const enriched = appendUiArtifactSuggestion({
      content: [{ type: "text", text: "{\"events\":[]}" }],
    }, parsed)
    expect(enriched.content).toHaveLength(2)
    expect(enriched.content[1]?.text).toContain("uiArtifactSuggestions")
  })

  test("holds isolated approval state and rejects stale revisions", () => {
    const searched = executeUiArtifactCapability({
      name: UI_ARTIFACT_SEARCH_CAPABILITY,
      body: { query: "approval requests", limit: 1 },
      preferences: ENABLED_PREFERENCES,
      stateScope: "member-approvals",
    })
    const searchResult = uiArtifactSearchResultSchema.parse(searched?.structuredContent)
    expect(searchResult.matches[0]?.artifactId).toBe("work.approvals")

    const rendered = executeUiArtifactCapability({
      name: UI_ARTIFACT_USE_CAPABILITY,
      body: searchResult.matches[0]?.toolDefinition.exampleArguments,
      preferences: ENABLED_PREFERENCES,
      stateScope: "member-approvals",
    })
    const initial = uiArtifactRenderResultSchema.parse(rendered?.structuredContent)

    const decided = executeUiArtifactCapability({
      name: UI_ARTIFACT_USE_CAPABILITY,
      body: {
        operation: "decide",
        artifactId: "work.approvals",
        instanceId: initial.artifact.instanceId,
        itemId: "expense-lisbon",
        decision: "reject",
        expectedRevision: 1,
      },
      preferences: ENABLED_PREFERENCES,
      stateScope: "member-approvals",
    })
    const updated = uiArtifactRenderResultSchema.parse(decided?.structuredContent)
    expect(updated.artifact.revision).toBe(2)
    expect(updated.interaction?.decision).toBe("reject")

    const stale = executeUiArtifactCapability({
      name: UI_ARTIFACT_USE_CAPABILITY,
      body: {
        operation: "decide",
        artifactId: "work.approvals",
        instanceId: initial.artifact.instanceId,
        itemId: "access-production",
        decision: "approve",
        expectedRevision: 1,
      },
      preferences: ENABLED_PREFERENCES,
      stateScope: "member-approvals",
    })
    expect(stale?.isError).toBe(true)
    expect(stale?.structuredContent).toMatchObject({ code: "revision_conflict" })
  })
})
