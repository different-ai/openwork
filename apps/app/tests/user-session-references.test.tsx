import { afterAll, afterEach, expect, test } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import type { ReactNode } from "react"
import type { UIMessage } from "ai"
import type { SessionReference, SessionReferenceInventory } from "../src/components/chat/session-reference"
import type { OpenTarget } from "../src/react-app/domains/session/artifacts/open-target"

const ownedDom = typeof window === "undefined"
if (ownedDom) GlobalRegistrator.register({ url: "http://localhost/" })
const actEnvironment = Object.getOwnPropertyDescriptor(globalThis, "IS_REACT_ACT_ENVIRONMENT")
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, writable: true, value: true })

const { act } = await import("react")
const { createRoot } = await import("react-dom/client")
const { MessageList } = await import("../src/components/chat/message-list")
const { MessageListProvider } = await import("../src/components/chat/message-list-provider")
const { SessionReferenceProvider } = await import("../src/components/chat/session-reference-context")
const { SessionReferenceLink } = await import("../src/components/chat/session-reference-link")
const { OpenTargetProvider } = await import("../src/lib/target-provider")
const { createDefaultPlatform, PlatformProvider } = await import("../src/react-app/kernel/platform")

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })
afterAll(async () => {
  if (actEnvironment) Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", actEnvironment)
  else Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT")
  if (ownedDom) await GlobalRegistrator.unregister()
})

const reference: SessionReference = { workspaceId: "workspace-a", sessionId: "ses_alpha", title: "Synthetic task", archived: false }
const href = "/workspace/workspace-a/session/ses_alpha"
function inventory(title = reference.title): SessionReferenceInventory[] {
  return [{ workspaceId: reference.workspaceId, available: true, sessions: [{ id: reference.sessionId, title }] }]
}

type RenderOptions = {
  inventories?: SessionReferenceInventory[]
  withoutReferences?: boolean
  highlightQuery?: string
  isReferenceCurrent?: () => boolean
  onOpenReference?: (reference: SessionReference) => void
  onOpenTarget?: (target: OpenTarget) => void
  extraParts?: UIMessage["parts"]
}

function list(text: string, options: RenderOptions) {
  const message: UIMessage = { id: "user-synthetic", role: "user", parts: [{ type: "text", text }, ...options.extraParts ?? []] }
  const content = (
    <PlatformProvider value={createDefaultPlatform()}>
      <OpenTargetProvider onOpenTarget={options.onOpenTarget}>
        <MessageListProvider
          workspaceId="workspace-a"
          sessionId="ses_current"
          showThinking={false}
          developerMode={false}
          displaySuggestions={false}
          providerConnectedCount={1}
          highlightQuery={options.highlightQuery}
          dispatchAction={() => {}}
          setPrompt={() => {}}
          onRevertToUserMessage={() => {}}
          onForkAtMessage={() => {}}
          onEditUserMessage={() => {}}
          onMcpReconnect={() => Promise.reject(new Error("unused"))}
          onMcpReopenAuthorization={() => Promise.resolve()}
        >
          <MessageList messages={[message]} status="ready" />
        </MessageListProvider>
      </OpenTargetProvider>
    </PlatformProvider>
  )
  return options.withoutReferences ? content : (
    <SessionReferenceProvider
      inventories={options.inventories ?? inventory()}
      isReferenceCurrent={options.isReferenceCurrent}
      onOpenReference={options.onOpenReference ?? (() => {})}
    >
      {content}
    </SessionReferenceProvider>
  )
}

function mount() {
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  cleanups.push(async () => { await act(async () => root.unmount()); container.remove() })
  return {
    container,
    async render(text: string, options: RenderOptions = {}) { await act(async () => root.render(list(text, options))) },
    async renderNode(node: ReactNode) { await act(async () => root.render(node)) },
    prose() {
      const prose = container.querySelector('[data-message-id="user-synthetic"] span.whitespace-pre-wrap')
      if (!prose) throw new Error("Missing synthetic user prose")
      return prose
    },
  }
}

function firstLink(container: Element) {
  const link = container.querySelector("a")
  if (!link) throw new Error("Missing reference link")
  return link
}

async function dispatch(link: Element, type = "click", options: MouseEventInit = {}) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...options })
  await act(async () => { link.dispatchEvent(event) })
  return event
}

test("known standalone IDs and supported routes become compact task links without changing punctuation", async () => {
  const view = mount()
  await view.render(`Open (ses_alpha), ${href}. Then /session/ses_alpha!`)
  const links = view.prose().querySelectorAll("a")
  expect(links).toHaveLength(3)
  expect(view.prose().textContent).toBe("Open (Synthetic task), Synthetic task. Then Synthetic task!")
  for (const link of links) {
    expect(link.getAttribute("href")).toBe(href)
    expect(link.getAttribute("target")).toBeNull()
    expect(link.getAttribute("aria-label")).toBe("Open task: Synthetic task")
    expect(link.getAttribute("title")).toBe(reference.title)
    expect(link.className).toContain("focus-visible:ring-ring")
    expect(link.querySelector("span")?.className).toContain("truncate")
    const icon = link.querySelector("img")
    expect(icon?.getAttribute("src")).toBe("/openwork-sidebar-mark.svg")
    expect(icon?.getAttribute("aria-hidden")).toBe("true")
    expect(icon?.getAttribute("alt")).toBe("")
    expect(link.querySelector("svg")).toBeNull()
  }
})

test("encoded supported routes resolve by identity", async () => {
  const view = mount()
  await view.render("Open /workspace/workspace%3Aa/session/ses_alpha", {
    inventories: [{ workspaceId: "workspace:a", available: true, sessions: [{ id: "ses_alpha", title: "Encoded task" }] }],
  })
  expect(firstLink(view.prose()).getAttribute("href")).toBe("/workspace/workspace%3Aa/session/ses_alpha")
  expect(firstLink(view.prose()).textContent).toBe("Encoded task")
})

test("unknown IDs, strict unknown routes, and unsupported forms stay literal", async () => {
  const view = mount()
  const raw = [
    "ses_missing", "/session/ses_missing", "/workspace/workspace-a/session/ses_missing", "/workspace/missing/session/ses_alpha",
    "ses_", "prefixses_alpha", "ses_alphaSuffix", "ses_alpha.json", "é-ses_alpha", "ses_alphaé", "@ses_alpha",
    "session/ses_alpha", "./session/ses_alpha", "../ses_alpha", "/session/ses_alpha/", "/session/ses_alpha/messages",
    "/session/ses_alpha?mode=read", "/session/ses_alpha?", "/session/ses_alpha#message", "/session/ses_alpha\\other",
    "/workspaces/workspace-a/session/ses_alpha", "/workspace/../session/ses_alpha", "/workspace/%ZZ/session/ses_alpha",
    "/workspace/workspace-a%2fother/session/ses_alpha", "/session/ses_alpha%0a", "/session/ses_alpha%2f",
    "//example.test/session/ses_alpha", "ftp://example.test/session/ses_alpha", "openwork://session/ses_alpha", "javascript:ses_alpha",
  ].join(" ")
  const opened: OpenTarget[] = []
  await view.render(raw, { onOpenTarget: (target) => opened.push(target) })
  expect(view.prose().textContent).toBe(raw)
  expect(view.prose().querySelectorAll("a")).toHaveLength(0)
  await dispatch(view.prose())
  expect(opened).toEqual([])
})

test("missing optional context and unavailable inventories preserve literal references", async () => {
  const view = mount()
  const raw = `ses_alpha /session/ses_alpha ${href}`
  for (const options of [
    { withoutReferences: true },
    { inventories: [] },
    { inventories: [{ workspaceId: "workspace-a", available: false, sessions: [{ id: "ses_alpha", title: "Stale" }] }] },
  ]) {
    await view.render(raw, options)
    expect(view.prose().textContent).toBe(raw)
    expect(view.prose().querySelectorAll("a")).toHaveLength(0)
  }
})

test("ambiguous unscoped IDs stay literal while explicit workspace links resolve", async () => {
  const view = mount()
  await view.render(`ses_alpha /session/ses_alpha ${href}`, { inventories: [
    ...inventory(), { workspaceId: "workspace-b", available: true, sessions: [{ id: "ses_alpha", title: "Other task" }] },
  ] })
  expect(view.prose().textContent).toBe("ses_alpha /session/ses_alpha Synthetic task")
  expect(view.prose().querySelectorAll("a")).toHaveLength(1)
})

test("external URLs containing IDs or internal routes retain external link behavior", async () => {
  const view = mount()
  const urls = ["https://example.test/session/ses_alpha", "https://example.test/?next=/session/ses_alpha", "http://localhost/workspace/workspace-a/session/ses_alpha"]
  const opened: OpenTarget[] = []
  const tasks: SessionReference[] = []
  await view.render(`${urls.join(" ")} ses_alpha`, { onOpenTarget: (target) => opened.push(target), onOpenReference: (target) => tasks.push(target) })
  const links = view.prose().querySelectorAll("a")
  expect(links).toHaveLength(4)
  for (const [index, url] of urls.entries()) {
    expect(links[index].getAttribute("href")).toBe(url)
    expect(links[index].getAttribute("target")).toBe("_blank")
    expect(links[index].getAttribute("rel")).toBe("noreferrer noopener")
    expect(links[index].textContent).toBe(url)
    expect((await dispatch(links[index])).defaultPrevented).toBe(true)
  }
  expect(opened.map((target) => target.value)).toEqual(urls)
  expect(tasks).toEqual([])
  await dispatch(links[3])
  expect(tasks).toEqual([reference])
  expect(opened).toHaveLength(3)
})

test("fenced, indented, and multi-token inline code examples remain literal", async () => {
  const view = mount()
  const code = [
    "```ts\nconst id = 'ses_alpha'\n/session/ses_alpha\n```",
    "~~~~\nses_alpha\n~~~\nses_alpha\n~~~~",
    "    ses_alpha\n\t/session/ses_alpha",
    "> ```\n> ses_alpha\n> ```",
    "`open ses_alpha` and `\"ses_alpha\"` and `ses_alpha ses_alpha` and `/session/ses_alpha`",
    "``const id = `ses_alpha` `` and ` ses_alpha `",
  ].join("\n")
  await view.render(`${code}\nOutside ses_alpha`)
  expect(view.prose().textContent).toBe(`${code}\nOutside Synthetic task`)
  expect(view.prose().querySelectorAll("a")).toHaveLength(1)
})

test("nested and CRLF fences preserve code while allowing following prose references", async () => {
  const view = mount()
  for (const code of [
    "- ~~~\nses_alpha\n  ~~~",
    "1. ```\nses_alpha\n   ```",
    "> > ~~~\n> > ses_alpha\n> > ~~~",
    "```ts\r\nses_alpha\r\n```\r\n",
  ]) {
    await view.render(`${code}\nOutside ses_alpha`)
    expect(view.prose().textContent).toBe(`${code}\nOutside Synthetic task`)
    expect(view.prose().querySelectorAll("a")).toHaveLength(1)
  }
})

test("an exact inline-code ID is linked while its literal backticks are preserved", async () => {
  const view = mount()
  await view.render("Use `ses_alpha` and ``ses_alpha`` but not `ses_missing`.")
  expect(view.prose().textContent).toBe("Use `Synthetic task` and ``Synthetic task`` but not `ses_missing`.")
  expect(view.prose().querySelectorAll("a")).toHaveLength(2)
  expect(view.prose().querySelectorAll("code")).toHaveLength(0)
})

test("unclosed fences and inline examples do not enrich their remaining content", async () => {
  const view = mount()
  for (const code of ["```ts\nses_alpha\n/session/ses_alpha", "~~~\nses_alpha", "`example ses_alpha", "``ses_alpha`"]) {
    await view.render(code)
    expect(view.prose().textContent).toBe(code)
    expect(view.prose().querySelectorAll("a")).toHaveLength(0)
  }
})

test("skill chips and search highlights survive alongside links and code examples", async () => {
  const view = mount()
  await view.render("Load [skill Synthetic] and follow its instructions. ses_alpha /session/ses_missing `example ses_alpha`", { highlightQuery: "ses_" })
  expect(view.prose().querySelector('[title="Skill: Synthetic"]')?.textContent).toBe("Synthetic")
  expect(view.prose().querySelectorAll("a")).toHaveLength(1)
  expect(firstLink(view.prose()).querySelector("mark")?.textContent).toBe(reference.title)
  expect(view.prose().querySelectorAll('[data-search-highlight="true"]')).toHaveLength(3)
  await view.render("Synthetic ses_alpha", { highlightQuery: "synthetic" })
  expect(view.prose().querySelectorAll("mark")).toHaveLength(2)
})

test("primary, modified, and middle clicks invoke only the real revalidating callback", async () => {
  const view = mount()
  const opened: SessionReference[] = []
  const external: OpenTarget[] = []
  await view.render("ses_alpha", { onOpenReference: (value) => opened.push(value), onOpenTarget: (target) => external.push(target) })
  const link = firstLink(view.prose())
  for (const options of [{}, { metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { altKey: true }]) {
    expect((await dispatch(link.querySelector("img") ?? link, "click", options)).defaultPrevented).toBe(true)
  }
  expect((await dispatch(link, "mousedown", { button: 1 })).defaultPrevented).toBe(true)
  expect((await dispatch(link, "auxclick", { button: 1, metaKey: true })).defaultPrevented).toBe(true)
  expect(opened).toEqual(Array.from({ length: 6 }, () => reference))
  await dispatch(link, "auxclick", { button: 2 })
  expect(opened).toHaveLength(6)
  expect(external).toEqual([])
})

test("native anchor focus and keyboard-style activation use the same callback", async () => {
  const view = mount()
  const opened: SessionReference[] = []
  await view.render("ses_alpha", { onOpenReference: (value) => opened.push(value) })
  const link = firstLink(view.prose())
  await act(async () => link.focus())
  expect(document.activeElement === link).toBe(true)
  expect(link.tabIndex).toBe(0)
  const key = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })
  await act(async () => { link.dispatchEvent(key) })
  expect(key.defaultPrevented).toBe(false)
  expect((await dispatch(link, "click", { detail: 0 })).defaultPrevented).toBe(true)
  expect(opened).toEqual([reference])
})

test("click-time invalidation blocks a stale DOM link without external fallback", async () => {
  const view = mount()
  let current = true
  const opened: SessionReference[] = []
  const external: OpenTarget[] = []
  await view.render("ses_alpha", { isReferenceCurrent: () => current, onOpenReference: (value) => opened.push(value), onOpenTarget: (value) => external.push(value) })
  const link = firstLink(view.prose())
  current = false
  expect((await dispatch(link)).defaultPrevented).toBe(true)
  expect((await dispatch(link, "auxclick", { button: 1 })).defaultPrevented).toBe(true)
  expect(opened).toEqual([])
  expect(external).toEqual([])
})

test("renames update rendered titles and deletion restores the original raw text", async () => {
  const view = mount()
  const opened: SessionReference[] = []
  const onOpenReference = (value: SessionReference) => { opened.push(value) }
  await view.render(`ses_alpha ${href}`, { onOpenReference })
  await view.render(`ses_alpha ${href}`, { inventories: inventory("Renamed synthetic task"), onOpenReference })
  expect(firstLink(view.prose()).textContent).toBe("Renamed synthetic task")
  await dispatch(firstLink(view.prose()))
  expect(opened[0]?.title).toBe("Renamed synthetic task")
  await view.render(`ses_alpha ${href}`, { inventories: [], onOpenReference })
  expect(view.prose().querySelectorAll("a")).toHaveLength(0)
  expect(view.prose().textContent).toBe(`ses_alpha ${href}`)
})

test("titles and prose are safe React text, and adjacent attachments retain identity", async () => {
  const view = mount()
  const title = '<img src="invalid" onerror="alert(1)"> & synthetic task'
  const extraParts: UIMessage["parts"] = [{ type: "file", filename: "synthetic.png", mediaType: "image/png", url: "blob:http://localhost/synthetic" }]
  await view.render("<script>synthetic</script> ses_alpha", { inventories: inventory(title), extraParts })
  const link = firstLink(view.prose())
  expect(link.textContent).toBe(title)
  expect(link.getAttribute("aria-label")).toBe(`Open task: ${title}`)
  expect(view.container.querySelectorAll("script,[onerror]")).toHaveLength(0)
  expect(link.querySelectorAll("img")).toHaveLength(1)
  const image = view.container.querySelector('img[alt="synthetic.png"]')
  expect(image !== null).toBe(true)
  await view.render("ses_alpha", { inventories: inventory("Renamed"), extraParts })
  expect(view.container.querySelector('img[alt="synthetic.png"]') === image).toBe(true)
})

test("the exported shared link supports caller-rendered labels and archived metadata", async () => {
  const view = mount()
  const opened: { workspaceId: string; sessionId: string }[] = []
  await view.renderNode(
    <SessionReferenceLink reference={{ ...reference, archived: true }} openReference={(identity) => opened.push(identity)} className="custom-label">
      <mark>Synthetic</mark> task
    </SessionReferenceLink>
  )
  const link = firstLink(view.container)
  expect(link.getAttribute("aria-label")).toBe("Open archived task: Synthetic task")
  expect(link.className).toContain("custom-label")
  expect(link.querySelector("mark")?.textContent).toBe("Synthetic")
  await dispatch(link)
  expect(opened[0]?.workspaceId).toBe(reference.workspaceId)
  expect(opened[0]?.sessionId).toBe(reference.sessionId)
})
