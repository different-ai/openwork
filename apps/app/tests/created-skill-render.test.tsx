import { afterAll, afterEach, expect, spyOn, test } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { act, createElement, useState } from "react"
import type { DenLibraryAccessGrant, DenLibraryItem, DenLibraryOrgDirectory } from "../src/app/lib/den-library"
import type { ConfirmedSkillAccess } from "../src/lib/created-skill"
import type { ReadyCreatedSkill } from "../src/components/chat/created-skill-card"
import { createRoot, type Root } from "react-dom/client"
import type { DynamicToolUIPart, UIMessage } from "ai"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"

GlobalRegistrator.register({ url: "https://web.example/" })
const previousAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT")
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true)
afterAll(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct)
  GlobalRegistrator.unregister()
})

const { DenAuthProvider } = await import("../src/react-app/domains/cloud/den-auth-provider")
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })
afterAll(() => queryClient.clear())

const { PlatformProvider, createDefaultPlatform } = await import("../src/react-app/kernel/platform")
const { MessageListProvider } = await import("../src/components/chat/message-list-provider")
const { MessageList } = await import("../src/components/chat/message-list")
const { CreatedSkillCard, CreatedSkillsContext } = await import("../src/components/chat/created-skill-card")
const { CreatedSkillSharing, CreatedSkillSharingProvider } = await import("../src/react-app/shell/created-skill-sharing-provider")
const { createDenClient } = await import("../src/app/lib/den")
const { accessFromGrants } = await import("../src/components/chat/created-skill-access")

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
  await act(async () => root.render(createElement(QueryClientProvider, { client: queryClient, children: createElement(DenAuthProvider, { children: createElement(PlatformProvider, {
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
  }) }) })))
  return container
}

function card(container: HTMLElement) {
  return container.querySelector<HTMLElement>('[data-created-skill="cob_crm"]')
}

test("a finished turn folds to one quiet line while its skill stays visible, and Open goes to Library only when asked", async () => {
  const opened: string[] = []
  const container = await render(conversation([createCall, directory, shareDone, { type: "text", text: "Created a reusable skill for adding clients and deals." }], true), "ready", opened)

  const rail = container.querySelector<HTMLElement>('[data-testid="completed-work-rail"]')
  expect(rail?.textContent).toBe("Worked for 4s")
  expect(rail?.getAttribute("aria-label")).toBe("Worked for 4s, 3 steps. Show steps")
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
  // Only the active step has the running tone; the finished create step does not.
  const running = [...container.querySelectorAll('[data-capability-call] [data-text-step-tone="running"]')].map((element) => element.textContent)
  expect(running).toEqual(["Sharing Update CRM with Sam…"])
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

async function settle() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)) })
}

async function renderSharing({ enabled = true, role = "owner", mine = false, readOnly = false, unknown = false }: {
  enabled?: boolean
  role?: "owner" | "manager" | "editor" | "viewer"
  mine?: boolean
  readOnly?: boolean
  unknown?: boolean
} = {}) {
  queryClient.clear()
  const items: DenLibraryItem[] = [{
    type: "plugin", id: saved.pluginId, name: saved.name, description: null,
    componentKinds: ["skill"], componentCount: 1, role, edges: mine ? [{ kind: "mine" }] : [],
  }]
  const orgDirectory: DenLibraryOrgDirectory = {
    currentMemberId: "om_me", members: [{ id: "om_me", name: "You", email: null }], teams: [],
  }
  let grants: DenLibraryAccessGrant[] = []
  let permissionReads = 0
  let audienceReads = 0
  let checked = 0
  const client = Object.assign(createDenClient({ baseUrl: "https://den.example", token: "fixture-token" }), {
    listMeLibraryItems: async () => {
      permissionReads++
      return unknown ? new Promise<DenLibraryItem[]>(() => {}) : items
    },
    getLibraryOrgDirectory: async () => { audienceReads++; return orgDirectory },
    listManagedPluginAccess: async () => new Map([[saved.pluginId, grants]]),
    listPluginAccess: async () => grants,
    grantPluginAccess: async () => {
      const grant: DenLibraryAccessGrant = { id: "pag_everyone", orgMembershipId: null, teamId: null, orgWide: true, role: "viewer" }
      grants = [...grants, grant]
      return grant
    },
  })
  function SkillFixture() {
    const [access, setAccess] = useState<ConfirmedSkillAccess>({ kind: "private" })
    const skill: ReadyCreatedSkill = {
      kind: "ready", skillId: saved.skillId, pluginId: saved.pluginId, name: saved.name,
      mode: "created", access, pending: null, anchorToolCallId: "call_create",
    }
    return createElement(CreatedSkillsContext.Provider, {
      value: {
        cards: [skill], shareLabels: new Map(), savedNames: new Map(),
        onOpenSkill: readOnly ? undefined : () => {},
        onCheckSharing: async () => { checked++; setAccess(accessFromGrants(grants, orgDirectory)) },
      },
      children: createElement(CreatedSkillCard, { card: skill }),
    })
  }
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  mounted = { root, container }
  async function rerender({ orgId = "org_fixture", featureEnabled = enabled }: { orgId?: string; featureEnabled?: boolean } = {}) {
    await act(async () => root.render(createElement(QueryClientProvider, {
      client: queryClient,
      children: createElement(CreatedSkillSharing, {
        messages: conversation([createCall], true), enabled: featureEnabled,
        context: { client, orgId, orgName: "Fixture", identityVerified: true, canManage: true, scope: ["https://den.example", "fixture-user", orgId, "https://den.example"] },
        children: createElement(SkillFixture),
      }),
    })))
    await settle()
  }
  await rerender()
  return { container, rerender, permissionReads: () => permissionReads, audienceReads: () => audienceReads, checked: () => checked }
}

test("Share is shown only for a permitted skill with the flag on; ownership alone does not load its audience", async () => {
  const fixture = await renderSharing()
  const share = fixture.container.querySelector<HTMLButtonElement>('button[aria-label="Share Update CRM"]')
  const open = fixture.container.querySelector<HTMLButtonElement>('button[aria-label="Open Update CRM in Library"]')
  expect(share?.textContent).toBe("Share")
  expect(share?.className).toBe(open?.className)
  expect(fixture.permissionReads()).toBe(1)
  expect(fixture.audienceReads()).toBe(0)
})

test.each(["manager", "editor", "viewer"])("Share stays hidden for a %s without Library ownership", async (role) => {
  const fixture = await renderSharing({ role })
  expect(fixture.container.querySelector('button[aria-label="Share Update CRM"]')).toBeNull()
})

test("Library's mine edge permits sharing even when the role is not owner", async () => {
  const fixture = await renderSharing({ role: "editor", mine: true })
  expect(fixture.container.querySelector('button[aria-label="Share Update CRM"]')).not.toBeNull()
})

test("Share is hidden with the flag off, without even loading permissions", async () => {
  const fixture = await renderSharing({ enabled: false })
  expect(fixture.container.querySelector('button[aria-label="Share Update CRM"]')).toBeNull()
  expect(fixture.permissionReads()).toBe(0)
})

test("an inactive sharing provider does not mount organization-role queries", async () => {
  queryClient.clear()
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  mounted = { root, container }
  await act(async () => root.render(createElement(QueryClientProvider, {
    client: queryClient,
    children: createElement(DenAuthProvider, {
      children: createElement(CreatedSkillSharingProvider, {
        messages: conversation([createCall], true), active: false, children: "Transcript",
      }),
    }),
  })))
  expect(container.textContent).toBe("Transcript")
  expect(queryClient.getQueryCache().findAll({ queryKey: ["apps-organization-role"] })).toHaveLength(0)
})

test("flag resolution, kill and active changes preserve the mounted chat and its local state", async () => {
  queryClient.clear()
  const orgFeatures = await import("../src/react-app/domains/cloud/use-org-feature")
  const apps = await import("../src/react-app/domains/apps/use-apps")
  let featureEnabled = false
  let mounts = 0
  let permissionReads = 0
  const client = Object.assign(createDenClient({ baseUrl: "https://den.example", token: "fixture-token" }), {
    listMeLibraryItems: async (): Promise<DenLibraryItem[]> => { permissionReads++; return [] },
  })
  const feature = spyOn(orgFeatures, "useOrgFeature").mockImplementation(() => featureEnabled)
  const identity = spyOn(apps, "useAppsIdentity").mockReturnValue({
    identityVerified: true, principalId: "fixture-user", client,
    orgId: "org_fixture", orgName: "Fixture",
    scope: ["https://den.example", "fixture-user", "org_fixture", "https://den.example"],
  })
  function ChatFixture() {
    const [expanded, setExpanded] = useState(() => { mounts++; return false })
    return createElement("button", { onClick: () => setExpanded(!expanded) }, expanded ? "Expanded" : "Collapsed")
  }
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  mounted = { root, container }
  async function rerender(active = true) {
    await act(async () => root.render(createElement(QueryClientProvider, {
      client: queryClient,
      children: createElement(CreatedSkillSharingProvider, {
        messages: conversation([createCall], true), active, children: createElement(ChatFixture),
      }),
    })))
    await settle()
  }
  try {
    await rerender()
    expect(permissionReads).toBe(0)
    const button = container.querySelector<HTMLButtonElement>("button")
    await act(async () => button?.click())
    expect(button?.textContent).toBe("Expanded")
    for (const state of [
      { feature: true, active: true },
      { feature: false, active: true },
      { feature: true, active: true },
      { feature: true, active: false },
      { feature: true, active: true },
    ]) {
      featureEnabled = state.feature
      await rerender(state.active)
      expect(container.querySelector("button")).toBe(button)
      expect(button?.textContent).toBe("Expanded")
      expect(mounts).toBe(1)
    }
    expect(permissionReads).toBe(1)
  } finally {
    await act(async () => root.unmount())
    container.remove()
    mounted = null
    feature.mockRestore()
    identity.mockRestore()
  }
})

test("equivalent message arrays reuse the permission query", async () => {
  const fixture = await renderSharing()
  await fixture.rerender()
  expect(fixture.permissionReads()).toBe(1)
})

test.each(["organization", "flag"])("changing %s closes and resets an open sharing dialog", async (change) => {
  const fixture = await renderSharing()
  await act(async () => fixture.container.querySelector<HTMLButtonElement>('button[aria-label="Share Update CRM"]')?.click())
  await settle()
  expect(document.querySelector('[role="dialog"]')).not.toBeNull()
  await fixture.rerender(change === "organization" ? { orgId: "org_other" } : { featureEnabled: false })
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  await fixture.rerender()
  expect(document.querySelector('[role="dialog"]')).toBeNull()
})

test("Share is hidden while permission is unknown", async () => {
  const fixture = await renderSharing({ unknown: true })
  expect(fixture.container.querySelector('button[aria-label="Share Update CRM"]')).toBeNull()
})

test("read-only skill cards have no Share action", async () => {
  const fixture = await renderSharing({ readOnly: true })
  expect(fixture.container.querySelector('button[aria-label="Share Update CRM"]')).toBeNull()
})

test("Share opens the existing sharing page in a dialog and saving refreshes access in place", async () => {
  const fixture = await renderSharing()
  const before = card(fixture.container)
  await act(async () => fixture.container.querySelector<HTMLButtonElement>('button[aria-label="Share Update CRM"]')?.click())
  await settle()
  const dialog = document.querySelector('[role="dialog"]')
  expect(dialog?.textContent).toContain("Update CRM")
  expect(dialog?.querySelector('[data-testid="library-share-page"]')).not.toBeNull()
  const everyone = dialog?.querySelector<HTMLButtonElement>('[role="switch"]')
  expect(everyone).not.toBeNull()
  await act(async () => everyone?.click())
  const save = [...(dialog?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find((button) => button.textContent?.startsWith("Share with"))
  expect(save?.disabled).toBe(false)
  await act(async () => save?.click())
  await settle()
  expect(fixture.checked()).toBe(1)
  expect(card(fixture.container)).toBe(before)
  expect(card(fixture.container)?.textContent).toContain("Shared with your organization")
  expect(document.querySelector('[role="dialog"]')).toBeNull()
})
