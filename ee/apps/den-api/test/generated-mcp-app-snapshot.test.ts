import assert from "node:assert/strict"
import test from "node:test"
import { buildGeneratedArtifactView, buildGeneratedMcpApp } from "../src/generated-artifact-view-builder.js"
import {
  GENERATED_MCP_APP_SNAPSHOT_RUNTIME,
  MCP_APP_SNAPSHOT_MAX_BYTES,
  MCP_APP_SNAPSHOT_METHOD,
} from "../src/generated-mcp-app-runtime.js"

// Just enough of the DOM for the snapshot runtime: it clones the mount, walks
// and edits the copy, and reads its outerHTML.
type FakeNode = FakeElement | FakeLeaf
class FakeLeaf {
  parent: FakeElement | null = null
  constructor(readonly nodeType: 3 | 8, readonly data: string) {}
  get textContent() { return this.nodeType === 3 ? this.data : "" }
  remove() { this.parent?.removeChild(this) }
  cloneNode() { return new FakeLeaf(this.nodeType, this.data) }
  serialize(raw: boolean) {
    if (this.nodeType === 8) return `<!--${this.data}-->`
    return raw ? this.data : this.data.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  }
}
class FakeElement {
  readonly nodeType = 1
  parent: FakeElement | null = null
  childNodes: FakeNode[] = []
  attributes: Array<{ name: string; value: string }>
  constructor(readonly localName: string, attributes: Record<string, string> = {}, children: Array<FakeNode | string> = []) {
    this.attributes = Object.entries(attributes).map(([name, value]) => ({ name, value }))
    for (const child of children) this.append(typeof child === "string" ? new FakeLeaf(3, child) : child)
  }
  append(child: FakeNode) { child.parent = this; this.childNodes.push(child) }
  removeChild(child: FakeNode) { this.childNodes = this.childNodes.filter(node => node !== child) }
  remove() { this.parent?.removeChild(this) }
  removeAttributeNode(attribute: { name: string; value: string }) { this.attributes = this.attributes.filter(item => item !== attribute) }
  contains(node: FakeNode): boolean { return node === this || this.childNodes.some(child => child === node || (child instanceof FakeElement && child.contains(node))) }
  cloneNode(): FakeElement {
    const copy = new FakeElement(this.localName, Object.fromEntries(this.attributes.map(({ name, value }) => [name, value])))
    for (const child of this.childNodes) copy.append(child.cloneNode())
    return copy
  }
  get textContent(): string { return this.childNodes.map(child => child.textContent).join("") }
  set textContent(value: string) { this.childNodes = []; this.append(new FakeLeaf(3, value)) }
  get outerHTML(): string { return this.serialize() }
  serialize(): string {
    const attributes = this.attributes.map(({ name, value }) => ` ${name}="${value.replaceAll("&", "&amp;").replaceAll('"', "&quot;")}"`).join("")
    return `<${this.localName}${attributes}>${this.childNodes.map(child => child instanceof FakeElement ? child.serialize() : child.serialize(this.localName === "style" || this.localName === "script")).join("")}</${this.localName}>`
  }
}

const element = (name: string, attributes: Record<string, string> = {}, ...children: Array<FakeNode | string>) => new FakeElement(name, attributes, children)

type Snapshots = { start(): void; dispose(): void }
const createSnapshots = new Function(`${GENERATED_MCP_APP_SNAPSHOT_RUNTIME}\nreturn createOpenworkAppSnapshots;`)() as (options: unknown) => Snapshots

function harness(mount: FakeElement, hostContext: Record<string, unknown>, headStyles: FakeElement[] = []) {
  const frames: Array<() => void> = []
  const sent: Array<{ method: string; params: { html: string } }> = []
  let observer: (() => void) | null = null
  const snapshots = createSnapshots({
    app: {
      getHostContext: () => hostContext,
      notification: async (message: { method: string; params: { html: string } }) => { sent.push(message) },
    },
    mount,
    document: { querySelectorAll: (selector: string) => selector === "style" ? headStyles : [] },
    requestFrame: (callback: () => void) => { frames.push(callback) },
    observe: (callback: () => void) => {
      observer = callback
      return () => { observer = null }
    },
  })
  return {
    snapshots, sent,
    frame() { for (const callback of frames.splice(0)) callback() },
    mutate() { observer?.() },
    get observing() { return observer !== null },
  }
}

const wanted = { experimental: { [MCP_APP_SNAPSHOT_METHOD]: true } }

test("a built App carries the snapshot runtime; an Artifact view does not", async () => {
  const reactSource = "export default function App() { return <p>Hello</p>; }"
  const app = await buildGeneratedMcpApp({ reactSource, title: "Snapshot App", description: null })
  assert.equal(app.ok, true)
  if (app.ok) {
    assert.equal(app.compilerVersion, "3")
    assert.ok(app.html.includes(`"${MCP_APP_SNAPSHOT_METHOD}"`))
  }
  const view = await buildGeneratedArtifactView({ reactSource, title: "Snapshot view", description: null, outputSchema: {} })
  assert.equal(view.ok, true)
  if (view.ok) assert.ok(!view.html.includes(MCP_APP_SNAPSHOT_METHOD))
})

test("an App sends no snapshot to a host that does not advertise it", () => {
  for (const hostContext of [{}, { experimental: {} }, { experimental: { [MCP_APP_SNAPSHOT_METHOD]: "yes" } }]) {
    const app = harness(element("div", { id: "openwork-mcp-app-root" }, element("p", {}, "Ready")), hostContext)
    app.snapshots.start()
    app.frame()
    app.frame()
    assert.equal(app.observing, false)
    assert.deepEqual(app.sent, [])
  }
})

test("a snapshot is the rendered markup and style text, without scripts, handlers or outside URLs", () => {
  const mount = element("div", { id: "openwork-mcp-app-root", onclick: "steal()" },
    element("h1", { class: "title", onMouseOver: "steal()" }, "Revenue <up>"),
    element("script", {}, "steal()"),
    element("noscript", {}, "<img src=x onerror=steal()>"),
    element("a", { href: "javascript:steal()" }, "script link"),
    element("a", { href: "java\tscript:steal()" }, "split script link"),
    element("a", { href: "https://outside.example/", ping: "https://outside.example/ping" }, "outside link"),
    element("img", { src: "data:image/png;base64,AAAA", srcset: "https://outside.example/a.png 2x", alt: "chart" }),
    element("img", { src: "https://outside.example/pixel.png" }),
    element("img", { src: "data:image/svg+xml;base64,AAAA" }),
    element("svg", {}, element("use", { href: "#icon" }), element("animate", { attributeName: "href", to: "javascript:steal()" })),
    element("iframe", { srcdoc: "<script>steal()</script>" }),
    element("meta", { "http-equiv": "refresh", content: "0;url=https://outside.example/" }),
    element("p", { style: "background: url(javascript:steal())" }, "styled"),
    element("style", {}, ".inner { color: red } </style><script>steal()</script>"),
    new FakeLeaf(8, " comment "),
  )
  const app = harness(mount, wanted, [element("style", {}, "body { margin: 0 } </style><script>steal()</script>")])
  app.snapshots.start()
  app.frame()
  assert.deepEqual(app.sent, [])
  app.frame()
  assert.equal(app.sent.length, 1)
  assert.equal(app.sent[0].method, MCP_APP_SNAPSHOT_METHOD)
  const { html } = app.sent[0].params
  assert.doesNotMatch(html, /<script|<noscript|<iframe|<meta|<animate|<!--/i)
  assert.doesNotMatch(html, /\son[a-z]+=/i)
  assert.doesNotMatch(html, /javascript:|outside\.example|srcset|ping=/i)
  assert.match(html, /^<style>body \{ margin: 0 \} \\3c \/style>\\3c script>steal\(\)\\3c \/script><\/style><div id="openwork-mcp-app-root">/)
  assert.match(html, /<h1 class="title">Revenue &lt;up&gt;<\/h1>/)
  assert.match(html, /<img src="data:image\/png;base64,AAAA" alt="chart">/)
  assert.match(html, /<use href="#icon">/)
  assert.match(html, /<style>\.inner \{ color: red \} \\3c \/style>/)
  // The live App keeps everything; only the copy is cleaned.
  assert.equal(mount.attributes[0]?.name, "id")
  assert.equal(mount.attributes[1]?.name, "onclick")
  assert.equal(mount.childNodes.length, 15)
})

test("a snapshot waits until the App settles, is not resent unchanged, and is dropped past the size cap", () => {
  const text = element("p", {}, "First")
  const mount = element("div", { id: "openwork-mcp-app-root" }, text)
  const app = harness(mount, wanted)
  app.snapshots.start()
  app.frame()
  app.mutate()
  app.frame()
  assert.deepEqual(app.sent, [], "a change between the two frames restarts the wait")
  app.frame()
  app.frame()
  assert.equal(app.sent.length, 1)

  app.mutate()
  app.frame()
  app.frame()
  assert.equal(app.sent.length, 1, "an unchanged picture is not sent again")

  text.textContent = "x".repeat(MCP_APP_SNAPSHOT_MAX_BYTES)
  app.mutate()
  app.frame()
  app.frame()
  assert.equal(app.sent.length, 1, "an oversized picture is dropped")

  text.textContent = "Second"
  app.snapshots.dispose()
  app.mutate()
  app.frame()
  app.frame()
  assert.equal(app.sent.length, 1, "a torn-down App sends nothing")
  assert.equal(app.observing, false)
})
