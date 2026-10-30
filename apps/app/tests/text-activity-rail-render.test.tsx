import { afterAll, afterEach, expect, test } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import type { DynamicToolUIPart, UIMessage } from "ai"

GlobalRegistrator.register({ url: "https://web.example/" })
const previousAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT")
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true)
const { PlatformProvider, createDefaultPlatform } = await import("../src/react-app/kernel/platform")
const { MessageListProvider } = await import("../src/components/chat/message-list-provider")
const { MessageList } = await import("../src/components/chat/message-list")
const { useTextActivityRailStore } = await import("../src/components/chat/text-activity-rail-store")
let mounted: { root: Root; container: HTMLElement } | null = null

afterEach(async () => {
  if (mounted) {
    const { root, container } = mounted
    await act(async () => root.unmount())
    container.remove()
    mounted = null
  }
  useTextActivityRailStore.getState().setEnabled(false)
})
afterAll(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct)
  GlobalRegistrator.unregister()
})

function tool(toolCallId: string, toolName: string, input: Record<string, unknown>, output = "ok"): DynamicToolUIPart {
  return { type: "dynamic-tool", toolName, toolCallId, state: "output-available", input, output }
}

/** One finished turn: a thought, commands, a file read and edit, a failed command, then the answer with a PR link. */
function turn(): UIMessage[] {
  const failedCommand: DynamicToolUIPart = {
    type: "dynamic-tool", toolName: "bash", toolCallId: "call_fail", state: "output-error",
    input: { command: "infisical export --env dev", description: "export secrets from Infisical" }, errorText: "infisical: not logged in",
  }
  return [
    { id: "user_1", role: "user", parts: [{ type: "text", text: "Update the PR body." }], metadata: { opencode: { created: 900 } } },
    {
      id: "reply_1",
      role: "assistant",
      metadata: { opencode: { created: 1000, completed: 60_000 } },
      parts: [
        { type: "reasoning", text: "Plan the change.", state: "done", providerMetadata: { opencode: { partId: "r1", time: { start: 1_000, end: 13_000 } } } },
        tool("call_ls", "bash", { command: "gh pr view 5245 --repo different-ai/openwork", description: "view the pull request" }, "title: feat"),
        tool("call_read", "read", { filePath: "/work/pr-body.md" }),
        tool("call_edit", "edit", { filePath: "/work/pr-body.md", oldString: "old line\n", newString: "new line\nanother\n" }),
        failedCommand,
        { type: "text", text: "PR opened: [#5212 feat(server): add a web command](https://github.com/different-ai/openwork/pull/5212)." },
      ],
    },
  ]
}

async function render(messages: UIMessage[], textRail: boolean) {
  useTextActivityRailStore.getState().setEnabled(textRail)
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  mounted = { root, container }
  await act(async () => root.render(createElement(PlatformProvider, {
    value: createDefaultPlatform(),
    children: createElement(MessageListProvider, {
      workspaceId: "workspace_fixture", sessionId: "session_fixture",
      showThinking: true, developerMode: false, displaySuggestions: false, providerConnectedCount: 0,
      dispatchAction: () => {}, setPrompt: () => {}, onRevertToUserMessage: () => {},
      onForkAtMessage: () => {}, onEditUserMessage: () => {},
      onMcpReconnect: async () => {}, onMcpReopenAuthorization: async () => {},
      children: createElement(MessageList, { messages, status: "ready", activityStatus: "idle" }),
    }),
  })))
  // Markdown decorations run after a microtask.
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)) })
  return container
}

async function click(element: Element | null | undefined) {
  if (!(element instanceof HTMLElement)) throw new Error("nothing to click")
  await act(async () => element.click())
}

test("flag off: the previous rail, with its leading lanes and no text-first rows", async () => {
  const container = await render(turn(), false)
  expect(container.querySelector("[data-tool-aggregate]")).not.toBeNull()
  expect(container.querySelector("[data-text-step]")).toBeNull()
  expect(container.querySelector("[data-text-rail-chevron]")).toBeNull()
  expect(container.querySelector("[data-github-reference]")).toBeNull()
  // The answer still reserves the 20px lane the previous rail uses.
  const proseRow = container.querySelector('[data-message-role="assistant"] .prose')?.parentElement
  expect(proseRow?.querySelector(":scope > span[aria-hidden='true']")?.className).toContain("size-5")
  expect(container.textContent).toContain("Edited 1 file, ran 2 commands, read 1 file")
})

test("flag on: one text-first summary, steps as sentences, a red failure, a timed thought and a marked PR link", async () => {
  const container = await render(turn(), true)
  // No leading lane anywhere on the rail.
  expect(container.querySelector('[data-tool-aggregate] span.size-5[aria-hidden="true"]')).toBeNull()
  const summary = container.querySelector("[data-text-group-summary]")
  expect(summary?.textContent).toBe("Explored 1 file, edited pr-body.md, ran 2 commands")
  const group = summary?.closest("button")
  expect(group?.textContent).toContain("+2")
  expect(group?.textContent).toContain("−1")
  expect(group?.textContent).toContain("1 failed")
  expect(group?.querySelector("[data-text-rail-chevron]")).not.toBeNull()
  expect(container.textContent).toContain("Thought 12s")

  await click(group)
  const steps = [...container.querySelectorAll("[data-text-step]")].map((step) => step.textContent)
  expect(steps).toContain("Ran View the pull request")
  expect(steps).toContain("Read pr-body.md")
  expect(steps).toContain("Edited pr-body.md")
  expect(steps).toContain("Couldn't run Export secrets from Infisical")
  const failure = [...container.querySelectorAll('[data-text-step-tone="failed"]')].at(0)
  expect(failure?.firstElementChild?.className).toContain("text-red-11")

  // Opening a command shows the quiet card: `$`, the tinted program, and its output.
  await click(container.querySelector('button[aria-label="Show details for Ran View the pull request"]'))
  const card = container.querySelector("[data-text-command-card]")
  expect(card?.textContent).toContain("$ gh pr view 5245 --repo different-ai/openwork")
  expect(card?.querySelector(".text-orange-11")?.textContent).toBe("gh")
  expect(card?.querySelector("[data-text-command-output]")?.textContent).toBe("title: feat")

  // A GitHub pull request link carries its own mark, neutral (state unknown).
  const link = container.querySelector('a[data-github-reference="pull"]')
  expect(link?.querySelector('svg[data-github-reference-glyph="pull"]')).not.toBeNull()
  expect(link?.textContent).toContain("#5212 feat(server): add a web command")
})

/** The same turn plus an OpenWork capability call, for the one-left-edge rules. */
function turnWithCapability(): UIMessage[] {
  const [user, reply] = turn()
  if (!user || !reply) throw new Error("fixture")
  const parts = [...reply.parts]
  parts.splice(parts.length - 1, 0, tool("call_org", "openwork-cloud_execute_capability", { name: "getOrg" }, JSON.stringify({ members: 2 })))
  return [user, { ...reply, parts }]
}

test("flag on: every rail line starts on the reply's left edge, chevrons trail, marks sit after the verb", async () => {
  const container = await render(turnWithCapability(), true)

  // No leading lane anywhere: no reserved 20px slot and no indented step list.
  expect(container.querySelector('span.size-5[aria-hidden="true"]')).toBeNull()
  const indented = [...container.querySelectorAll("[data-tool-aggregate] *, [data-capability-call] *")]
    .filter((element) => /(?:^|\s)(?:ps|pl)-\d/.test(element.getAttribute("class") ?? ""))
  expect(indented).toEqual([])

  // The reply's text is not pushed right by an empty lane.
  const prose = container.querySelector(".prose")?.parentElement
  expect(prose?.firstElementChild?.classList.contains("prose")).toBe(true)

  // The group summary's chevron is its last element, never its first.
  const summary = container.querySelector("[data-text-group-summary]")?.closest("button")
  expect(summary?.lastElementChild?.hasAttribute("data-text-rail-chevron")).toBe(true)
  expect(summary?.firstElementChild?.hasAttribute("data-text-rail-chevron")).toBe(false)
  await click(summary)
  for (const row of container.querySelectorAll("[data-text-step-row] > button")) {
    expect(row.firstElementChild?.hasAttribute("data-text-step")).toBe(true)
  }

  // An OpenWork step leads with its verb; the mark follows it, drawn in the text colour.
  const capability = container.querySelector("[data-capability-call]")
  const sentence = capability?.querySelector("[data-text-step]")
  expect(sentence?.parentElement?.firstElementChild).toBe(sentence ?? null)
  const mark = sentence?.querySelector("[data-text-rail-mark]")
  expect(mark?.previousElementSibling?.textContent?.length).toBeGreaterThan(0)
  expect(mark?.querySelector("[data-openwork-mark]")?.className).toContain("bg-current")
  expect(capability?.querySelector("img")).toBeNull()
})

test("the OpenWork mark is recognised however the identity reaches the row", async () => {
  const { isOpenWorkIdentity, OPENWORK_IDENTITY } = await import("../src/components/chat/capability-call-line")
  const base = { name: "OpenWork", toolNamespace: null, connectionId: null }
  expect(isOpenWorkIdentity(OPENWORK_IDENTITY)).toBe(true)
  expect(isOpenWorkIdentity({ ...base, id: "connection:c1", iconUrl: "https://www.google.com/s2/favicons?sz=64&domain=openworklabs.com", serviceUrl: "https://api.openworklabs.com/mcp/agent" })).toBe(true)
  expect(isOpenWorkIdentity({ ...base, id: "mcp:x", iconUrl: "/openwork-sidebar-mark.svg", serviceUrl: null })).toBe(true)
  expect(isOpenWorkIdentity({ ...base, id: "connection:slack", name: "Slack", iconUrl: "https://cdn.simpleicons.org/slack", serviceUrl: "https://mcp.slack.com" })).toBe(false)
  expect(isOpenWorkIdentity({ ...base, id: "connection:evil", iconUrl: null, serviceUrl: "https://openworklabs.com.evil.example" })).toBe(false)
})
