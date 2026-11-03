import { afterAll, afterEach, expect, test } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import type { DynamicToolUIPart, UIMessage } from "ai"

GlobalRegistrator.register({ url: "https://web.example/" })
const previousAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT")
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true)
afterAll(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct)
  GlobalRegistrator.unregister()
})

const { PlatformProvider, createDefaultPlatform } = await import("../src/react-app/kernel/platform")
const { MessageListProvider } = await import("../src/components/chat/message-list-provider")
const { MessageList } = await import("../src/components/chat/message-list")

const saved = { schemaVersion: "1", name: "Update CRM", pluginId: "plg_crm", skillId: "cob_crm", description: "Add clients and deals.", libraryUrl: null }
const createCall: DynamicToolUIPart = {
  type: "dynamic-tool", toolName: "openwork-cloud_create_skill", toolCallId: "call_create", state: "output-available",
  input: { pluginName: "Update CRM", skillMarkdown: "---\nname: update-crm\ndescription: x\n---\nSteps" },
  output: "# Skill created: Update CRM",
  callProviderMetadata: { openwork: { mcpResult: { content: [{ type: "text", text: "# Skill created: Update CRM" }], structuredContent: saved } } },
}
const directory: DynamicToolUIPart = {
  type: "dynamic-tool", toolName: "openwork-cloud_execute_capability", toolCallId: "call_org", state: "output-available",
  input: { name: "getOrg" },
  output: { currentMember: { id: "om_me" }, members: [{ id: "om_sam", user: { name: "Sam Taylor" } }], teams: [] },
}
const shareInput = { name: "postPluginsAccess", path: { pluginId: "plg_crm" }, body: { orgMembershipId: "om_sam", role: "viewer" } }
const shareRunning: DynamicToolUIPart = { type: "dynamic-tool", toolName: "openwork-cloud_execute_capability", toolCallId: "call_share", state: "input-available", input: shareInput }
const shareDone: DynamicToolUIPart = {
  ...shareRunning, state: "output-available",
  output: { ok: true, item: { id: "pag_1", orgMembershipId: "om_sam", teamId: null, orgWide: false, role: "viewer", createdByOrgMembershipId: "om_me", createdAt: "2026-10-27T00:00:00Z", removedAt: null } },
}

const startedAt = Date.UTC(2026, 9, 27, 12, 0, 0)
function conversation(parts: UIMessage["parts"], completed: boolean): UIMessage[] {
  return [
    { id: "user_1", role: "user", parts: [{ type: "text", text: "Create a new skill for this and share it with Sam." }], metadata: { opencode: { created: startedAt } } },
    {
      id: "reply_1", role: "assistant", parts,
      metadata: { opencode: { created: startedAt + 100, ...(completed ? { completed: startedAt + 4_100 } : {}) } },
    },
  ]
}

let mounted: { root: Root; container: HTMLElement } | null = null
afterEach(async () => {
  if (!mounted) return
  const { root, container } = mounted
  await act(async () => root.unmount())
  container.remove()
  mounted = null
})

async function render(messages: UIMessage[], status: "ready" | "streaming", opened: string[] = []) {
  const container = mounted?.container ?? document.createElement("div")
  if (!mounted) document.body.append(container)
  const root = mounted?.root ?? createRoot(container)
  mounted = { root, container }
  await act(async () => root.render(createElement(PlatformProvider, {
    value: createDefaultPlatform(),
    children: createElement(MessageListProvider, {
      workspaceId: "workspace_fixture", sessionId: "session_fixture",
      showThinking: false, developerMode: false, displaySuggestions: false, providerConnectedCount: 1,
      dispatchAction: () => {}, setPrompt: () => {}, onRevertToUserMessage: () => {},
      onForkAtMessage: () => {}, onEditUserMessage: () => {},
      onOpenLibraryDetail: (detailId: string) => { opened.push(detailId) },
      onMcpReconnect: async () => { throw new Error("Unexpected reconnect") },
      onMcpReopenAuthorization: async () => {},
      children: createElement(MessageList, { messages, status, activityStatus: status === "streaming" ? "responding" : "idle" }),
    }),
  })))
  return container
}

function card(container: HTMLElement) {
  return container.querySelector<HTMLElement>('[data-created-skill="cob_crm"]')
}

test("a finished turn folds to one quiet line while its skill stays visible, and Open goes to Library only when asked", async () => {
  const opened: string[] = []
  const container = await render(conversation([createCall, directory, shareDone, { type: "text", text: "Created a reusable skill for adding clients and deals." }], true), "ready", opened)

  const rail = container.querySelector<HTMLElement>('[data-testid="completed-work-rail"]')
  expect(rail?.textContent).toContain("Worked for 4s")
  expect(rail?.textContent).toContain("3 steps")
  expect(rail?.textContent).not.toContain("·")
  expect(container.textContent).not.toContain("Created the Update CRM skill")

  expect(card(container)?.textContent).toContain("Update CRM")
  expect(card(container)?.textContent).toContain("Shared with Sam Taylor")
  // Showing the result never navigates anywhere on its own.
  expect(opened).toEqual([])

  await act(async () => rail?.click())
  expect(container.textContent).toContain("Created the Update CRM skill")
  expect(container.textContent).toContain("Shared Update CRM with Sam")
  // No internals in the rail: tool ids, routing names, raw ids.
  for (const internal of ["execute_capability", "postPluginsAccess", "plg_crm", "cob_crm", "om_sam", "{"]) {
    expect(container.querySelector("[data-live-steps], [data-testid='completed-work-rail']")?.parentElement?.textContent ?? "").not.toContain(internal)
  }
  expect(container.querySelectorAll("[data-created-skill]")).toHaveLength(1)

  const open = card(container)?.querySelector<HTMLButtonElement>("button")
  expect(open?.textContent).toBe("Open")
  await act(async () => open?.click())
  expect(opened).toEqual(["plugin:plg_crm/file/cob_crm"])
})

test("a running share keeps the created skill openable and says sharing is in progress, then finishes in place", async () => {
  const container = await render(conversation([createCall, directory, shareRunning], false), "streaming")
  expect(card(container)?.textContent).toContain("Sharing with Sam…")
  expect(container.textContent).toContain("Sharing Update CRM with Sam…")
  // Only the active step shimmers; the finished create step does not.
  const shimmering = [...container.querySelectorAll("[data-capability-call] .ow-text-shimmer")].map((element) => element.textContent)
  expect(shimmering).toEqual(["Sharing Update CRM with Sam…"])
  const before = card(container)

  await render(conversation([createCall, directory, shareDone, { type: "text", text: "Done." }], true), "ready")
  // The same element updates: no second card, no remount.
  expect(card(container)).toBe(before)
  expect(card(container)?.textContent).toContain("Shared with Sam Taylor")
  expect(container.querySelectorAll("[data-created-skill]")).toHaveLength(1)
})

test("a blocked share is neutral, names who can change it, and does not claim sharing", async () => {
  const blocked: DynamicToolUIPart = { ...shareRunning, state: "output-error", errorText: JSON.stringify({ error: "forbidden", message: "Not allowed." }) }
  const container = await render(conversation([createCall, blocked], false), "streaming")
  const row = container.querySelector<HTMLElement>('[data-skill-share="blocked"]')
  expect(row?.textContent).toContain("Sharing is blocked by your organization")
  expect(row?.textContent).toContain("An organization admin can change who may share skills.")
  expect(row?.querySelector(".text-destructive")).toBeNull()
  expect(card(container)?.textContent).toContain("Only you")
})

test("a turn without a created skill renders no skill card", async () => {
  const container = await render(conversation([directory, { type: "text", text: "I created the skill and shared it." }], true), "ready")
  expect(container.querySelector("[data-created-skill]")).toBeNull()
})
