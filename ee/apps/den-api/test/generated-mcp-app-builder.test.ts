import { createHash } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { runInNewContext } from "node:vm"
import { expect, test } from "bun:test"
import { build, transform } from "esbuild"
import React from "react"
import { App, PostMessageTransport, type McpUiHostContext, type McpUiSizeChangedNotification, type McpUiToolResultNotification } from "@modelcontextprotocol/ext-apps"
import { AppBridge } from "@modelcontextprotocol/ext-apps/app-bridge"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js"
import {
  buildGeneratedArtifactView,
  buildGeneratedArtifactViewInWorker,
  buildGeneratedMcpApp,
  GENERATED_MCP_APP_COMPILER,
  GENERATED_MCP_APP_COMPILER_VERSION,
  type GeneratedMcpAppBuildInput,
} from "../src/generated-artifact-view-builder.js"
import { GENERATED_MCP_APP_ENTRY } from "../src/generated-mcp-app-runtime.js"

const input: GeneratedMcpAppBuildInput = {
  title: "Inventory",
  description: null,
  reactSource: `export default function Inventory({ app, input, result, hostContext }) {
    const [rows, setRows] = React.useState([])
    return <button onClick={async () => {
      const next = await app.callServerTool({ name: "list_inventory", arguments: input })
      setRows(next.structuredContent?.rows ?? [])
    }}>{hostContext?.theme}: {rows.length} {result?.isError ? "Retry" : "Refresh"}</button>
  }`,
  cssSource: "button { color: var(--color-text-primary); }",
}

function scripts(html: string): string[] {
  return Array.from(html.matchAll(/<script>([\s\S]*?)<\/script>/giu), (match) => match[1] ?? "")
}

test("builds a deterministic standalone MCP App without a Workflow or output schema", async () => {
  const first = await buildGeneratedMcpApp(input)
  const second = await buildGeneratedMcpApp(input)
  expect(first.ok).toBe(true)
  expect(second.ok).toBe(true)
  if (!first.ok || !second.ok) return
  expect(first.sourceDigest).toBe(second.sourceDigest)
  expect(first.resourceDigest).toBe(second.resourceDigest)
  expect(first.compilerName).toBe(GENERATED_MCP_APP_COMPILER)
  expect(first.compilerVersion).toBe(GENERATED_MCP_APP_COMPILER_VERSION)
  expect(first.htmlBytes).toBe(Buffer.byteLength(first.html))
  expect(first.htmlBytes).toBeLessThanOrEqual(768 * 1024)
  expect(first.csp).toEqual({ connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] })
  expect(first.html).toContain('<div id="openwork-mcp-app-root"></div>')
  for (const method of ["ui/initialize", "ui/notifications/initialized", "ui/notifications/tool-input", "ui/notifications/tool-result", "tools/call", "notifications/message"]) {
    expect(first.html).toContain(method)
  }
  expect(first.html).toContain("ResizeObserver")
  expect(first.html).toContain("callServerTool")
  expect(first.html).not.toContain("sandbox-diagnostic")
  expect(first.html).not.toContain("__openworkReportArtifactRuntimeError")
  expect(first.html).not.toContain("MCP_APP_DOCUMENT_RUNTIME_ERROR")
  expect(first.html).not.toContain("workflow-runner")
  expect(first.html).not.toContain("script-src 'unsafe-inline'")
  expect(first.html).not.toContain("'unsafe-eval'")
  expect(first.html).not.toMatch(/<(?:script|link|img)[^>]+(?:src|href)=/iu)
  for (const directive of ["connect-src", "frame-src", "object-src", "base-uri", "form-action", "worker-src"]) {
    expect(first.html).toContain(`${directive} 'none'`)
  }
  expect(scripts(first.html)).toHaveLength(1)
  for (const script of scripts(first.html)) {
    expect(first.html).toContain(`'sha256-${createHash("sha256").update(script).digest("base64")}'`)
  }
})

test("separates mode-specific identities and digests while preserving default Artifact mode", async () => {
  const artifactInput = { ...input, outputSchema: { type: "object" } }
  const artifact = await buildGeneratedArtifactView(artifactInput)
  const artifactWorker = await buildGeneratedArtifactViewInWorker(artifactInput)
  const app = await buildGeneratedMcpApp(input)
  expect(artifact.ok).toBe(true)
  expect(artifactWorker).toEqual(artifact)
  expect(app.ok).toBe(true)
  expect(app.sourceDigest).not.toBe(artifact.sourceDigest)
  expect(app.compilerName).not.toBe(artifact.compilerName)
  expect(artifact.sourceDigest).toBe(`sha256:${createHash("sha256").update(`${input.reactSource.trim()}\n\u0000${input.cssSource?.trim() ?? ""}`).digest("hex")}`)
  if (artifact.ok && app.ok) {
    expect(app.resourceDigest).not.toBe(artifact.resourceDigest)
    expect(scripts(artifact.html)).toHaveLength(2)
    expect(artifact.html).toContain("MCP_APP_DOCUMENT_RUNTIME_ERROR")
  }
  const renamed = await buildGeneratedMcpApp({ ...input, title: "Stock" })
  expect(renamed.sourceDigest).not.toBe(app.sourceDigest)
})

test("uses the safe classical JSX factory even when local React shadows the injected hooks binding", async () => {
  const result = await buildGeneratedMcpApp({
    ...input,
    reactSource: `export default function View({ React }) {
      const Tag = "scr" + "ipt"
      return <><safety-marker {...{ href: "blocked" }} /><Tag /></>
    }`,
  })
  expect(result.ok).toBe(true)
  if (!result.ok) return
  expect(result.html).toMatch(/\.createElement\("safety-marker"/u)
  expect(result.html).toContain("cannot render unsafe HTML elements")
  expect(result.html).toContain("cannot render URL-bearing or HTML-injection attributes")
})

test.each([
  'import React from "react";',
  'import /* gap */ React from "react";',
  'import "artifact:safe-react";',
  'export { default } from "react";',
  'export * from "react/jsx-runtime";',
  'export type { Component } from "react";',
  'export * as runtime from "artifact:safe-react";',
  'export /* gap */ { default as unsafe } /* gap */ from "react";',
  'export { default as unsafe } from "artifact:view";',
  'export { default as unsafe } from "artifact:safe-react";',
  'export * from "node:fs";',
  'export * from "./config.js";',
  'const load = () => import("react");',
  'const load = () => import /* gap */ ("react");',
  'const load = () => require("react");',
  'const path = import.meta.url;',
])("rejects authored imports and reexports: %s", async (prefix) => {
  const result = await buildGeneratedMcpApp({ ...input, reactSource: `${prefix}\nexport default function View() { return <p /> }` })
  expect(result.ok).toBe(false)
  expect(result.diagnostics[0]?.message).toContain("module imports")
  expect(result).not.toHaveProperty("html")
})

test.each([
  "/** @jsxRuntime automatic */",
  "/** @jsxImportSource react */",
  "/** @jsx React.createElement */",
  "/** @jsxFrag React.Fragment */",
  "const __openworkSafeReact = React;",
  "const __openworkSafeRe\\u0061ct = React;",
])("rejects authored JSX compiler overrides: %s", async (prefix) => {
  const result = await buildGeneratedMcpApp({ ...input, reactSource: `${prefix}\nexport default function View() { return <p /> }` })
  expect(result.ok).toBe(false)
  expect(result.diagnostics[0]?.message).toMatch(/JSX compiler directives|reserved compiler bindings/u)
})

test.each([
  "fetch('blocked')", "new WebSocket('blocked')", "window.location", "document.body", "globalThis",
  "setTimeout", "setInterval", "requestAnimationFrame", "requestIdleCallback", "queueMicrotask",
  "new Image()", "new SharedWorker('blocked')", "navigator", "process.env", "Bun", "global",
])("rejects authored network, browser, server, and timer globals: %s", async (expression) => {
  const result = await buildGeneratedMcpApp({ ...input, reactSource: `export default function View() { const value = ${expression}; return <p>{String(value)}</p> }` })
  expect(result.ok).toBe(false)
  expect(result).not.toHaveProperty("html")
})

test("retains scoped local names, safe hooks, and compile-only authored evaluation", async () => {
  const previous = process.env.GENERATED_MCP_APP_TEST_SECRET
  process.env.GENERATED_MCP_APP_TEST_SECRET = "host-secret-never-compiled"
  try {
    const result = await buildGeneratedMcpApp({
      ...input,
      reactSource: `throw new Error("authored-evaluation-must-be-deferred");
        export default function View({ app, input }) {
          const [top] = React.useState(input)
          return <button onClick={() => app.callServerTool({ name: "read", arguments: top })}>Read</button>
        }`,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.html).not.toContain("host-secret-never-compiled")
    expect(result.html).toContain("Promise.resolve().then")
    expect(result.html).toContain("authored-evaluation-must-be-deferred")
  } finally {
    if (previous === undefined) delete process.env.GENERATED_MCP_APP_TEST_SECRET
    else process.env.GENERATED_MCP_APP_TEST_SECRET = previous
  }
})

test.each(["@import 'remote';", "p { background: URL(remote); }", "</style><script>bad</script>"])("rejects unsafe CSS: %s", async (cssSource) => {
  const result = await buildGeneratedMcpApp({ ...input, cssSource })
  expect(result.ok).toBe(false)
  expect(result.diagnostics[0]?.message).toContain("CSS")
})

test("retains source, CSS, and final HTML byte budgets", async () => {
  const source = await buildGeneratedMcpApp({ ...input, reactSource: "é".repeat(100_001) })
  expect(source.ok).toBe(false)
  expect(source.diagnostics[0]?.message).toContain("200000 bytes")
  const css = await buildGeneratedMcpApp({ ...input, cssSource: "é".repeat(50_001) })
  expect(css.ok).toBe(false)
  expect(css.diagnostics[0]?.message).toContain("100000 bytes")
  const html = await buildGeneratedMcpApp({
    ...input,
    reactSource: `const text = ${JSON.stringify("x".repeat(190_000))}; export default function View() { return <p>{text}</p> }`,
    cssSource: `/*${"x".repeat(99_000)}*/`,
  })
  expect(html.ok).toBe(false)
  expect(html.diagnostics[0]?.message).toContain("786432 bytes")
})

test("carries MCP App mode and diagnostics through the emitted bounded worker", async () => {
  const directory = await mkdtemp(join(import.meta.dir, ".generated-app-worker-"))
  try {
    await build({
      entryPoints: ["generated-artifact-view-builder", "generated-artifact-view-build-worker", "generated-mcp-app-runtime"].map((name) => join(import.meta.dir, `../src/${name}.ts`)),
      outdir: directory,
      format: "esm",
      platform: "node",
      target: "es2022",
    })
    const emitted: typeof import("../src/generated-artifact-view-builder.js") = await import(pathToFileURL(join(directory, "generated-artifact-view-builder.js")).href)
    const result = await emitted.buildGeneratedMcpApp(input)
    expect(result).toEqual(await buildGeneratedMcpApp(input))
    expect(result.ok).toBe(true)
    const invalid = { ...input, reactSource: "export default function View() { return window.location }" }
    const rejected = await emitted.buildGeneratedMcpApp(invalid)
    expect(rejected).toEqual(await buildGeneratedMcpApp(invalid))
    expect(rejected.ok).toBe(false)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 15_000)

type ViewProps = {
  app: App
  input: unknown
  result: McpUiToolResultNotification["params"] | undefined
  hostContext: McpUiHostContext | undefined
}

type RenderTree = React.ReactElement<{ children: React.ReactElement<{ children: React.ReactElement<ViewProps> }> }>

function deferred() {
  let resolve = () => {}
  const promise = new Promise<void>((finish) => { resolve = finish })
  return { promise, resolve }
}

async function runtimeHarness(hostContext: McpUiHostContext = { theme: "light", locale: "en", displayMode: "inline" }) {
  const [appTransport, hostTransport] = InMemoryTransport.createLinkedPair()
  const bridge = new AppBridge(null, { name: "Fixture host", version: "1" }, { serverTools: {}, logging: {} }, { hostContext })
  const trees: RenderTree[] = []
  const messages: JSONRPCMessage[] = []
  const mount = { textContent: "" }
  let roots = 0
  let unmounts = 0
  let app: App | undefined
  const connected = deferred()
  const initialize = deferred()
  class RuntimeApp extends App {
    constructor(...args: ConstructorParameters<typeof App>) {
      expect(args[1]).toEqual({})
      expect(args[2]).toEqual({ autoResize: true, strict: true })
      super(args[0], args[1], { ...args[2], autoResize: false })
      app = this
    }
    override async connect() {
      await super.connect(appTransport)
      connected.resolve()
      await initialize.promise
    }
  }
  await bridge.connect(hostTransport)
  const onmessage = hostTransport.onmessage
  hostTransport.onmessage = (message, extra) => {
    messages.push(message)
    onmessage?.(message, extra)
  }
  const transformed = await transform(GENERATED_MCP_APP_ENTRY, { loader: "js", format: "cjs", target: "es2022" })
  runInNewContext(transformed.code, {
    document: { getElementById: (id: string) => id === "openwork-mcp-app-root" ? mount : null },
    window: { parent: {} },
    require(name: string) {
      if (name === "react") return React
      if (name === "@modelcontextprotocol/ext-apps") return { App: RuntimeApp, PostMessageTransport }
      if (name === "react-dom/client") return {
        createRoot(target: unknown) {
          expect(target).toBe(mount)
          roots += 1
          return { render: (tree: RenderTree) => trees.push(tree), unmount: () => { unmounts += 1 } }
        },
      }
      throw new Error(`Unexpected runtime dependency: ${name}`)
    },
  })
  await connected.promise
  const flush = () => new Promise<void>((resolve) => setImmediate(resolve))
  return {
    bridge, trees, mount, messages,
    roots: () => roots,
    unmounts: () => unmounts,
    async initialize() { initialize.resolve(); await flush() },
    latest() {
      const tree = trees.at(-1)
      if (!tree) throw new Error("The generated App has not rendered")
      return tree.props.children.props.children
    },
    async close() {
      initialize.resolve()
      await bridge.close()
      await app?.close()
    },
  }
}

test("renders on initialization without structuredContent and uses the real SDK for same-server tool calls", async () => {
  const runtime = await runtimeHarness()
  try {
    expect(runtime.trees).toHaveLength(0)
    await runtime.initialize()
    expect(runtime.roots()).toBe(1)
    const props = runtime.latest().props
    expect(props.input).toEqual({})
    expect(props.result).toBeUndefined()
    expect(props.hostContext).toEqual({ theme: "light", locale: "en", displayMode: "inline" })
    expect(props.app).toBeInstanceOf(App)
    runtime.bridge.oncalltool = async (params) => {
      expect(params).toMatchObject({ name: "list_inventory", arguments: { limit: 3 } })
      return { content: [{ type: "text", text: "Inventory" }], structuredContent: { rows: [1, 2, 3] } }
    }
    const result = await props.app.callServerTool({ name: "list_inventory", arguments: { limit: 3 } })
    expect(result.structuredContent).toEqual({ rows: [1, 2, 3] })
  } finally {
    await runtime.close()
  }
})

test("captures early launch params, forwards full results, and preserves the component tree on updates", async () => {
  const runtime = await runtimeHarness()
  try {
    const firstResult: McpUiToolResultNotification["params"] = { content: [{ type: "text", text: "Pending" }], _meta: { view: "inventory" } }
    await runtime.bridge.sendToolInput({ arguments: { input: { query: "stock" }, ignored: "launch-metadata" } })
    await runtime.bridge.sendToolResult(firstResult)
    expect(runtime.trees).toHaveLength(0)
    await runtime.initialize()
    const initialTree = runtime.trees[0]
    const first = runtime.latest()
    expect(first.props.input).toEqual({ query: "stock" })
    expect(first.props.result).toEqual(firstResult)
    const failure: McpUiToolResultNotification["params"] = { content: [{ type: "text", text: "Try again" }], isError: true, _meta: { retry: true } }
    await runtime.bridge.sendToolResult(failure)
    expect(runtime.latest().props.result).toEqual(failure)
    const result = { content: [], structuredContent: { count: 7 }, _meta: { revision: 2 } }
    await runtime.bridge.sendToolResult(result)
    await runtime.bridge.sendToolInput({ arguments: { input: { query: "updated" } } })
    await runtime.bridge.sendHostContextChange({ theme: "dark" })
    const latest = runtime.latest()
    expect(latest.props.result).toEqual(result)
    expect(latest.props.input).toEqual({ query: "updated" })
    expect(latest.props.hostContext).toEqual({ theme: "dark", locale: "en", displayMode: "inline" })
    expect(latest.props.app).toBe(first.props.app)
    expect(latest.type).toBe(first.type)
    expect(latest.key).toBeNull()
    for (const tree of runtime.trees) {
      expect(tree.type).toBe(initialTree?.type)
      expect(tree.key).toBeNull()
      expect(tree.props.children.type).toBe(initialTree?.props.children.type)
      expect(tree.props.children.key).toBeNull()
    }
    expect(runtime.roots()).toBe(1)
    expect(runtime.unmounts()).toBe(0)
    for (const value of [undefined, null]) {
      await runtime.bridge.sendToolInput({ arguments: { input: value } })
      expect(runtime.latest().props.input).toEqual({})
    }
    await runtime.bridge.teardownResource({})
    expect(runtime.unmounts()).toBe(1)
    const count = runtime.trees.length
    await runtime.bridge.sendToolResult(result)
    expect(runtime.trees).toHaveLength(count)
  } finally {
    await runtime.close()
  }
})

test("does not mount after teardown races initialization", async () => {
  const runtime = await runtimeHarness()
  try {
    await runtime.bridge.teardownResource({})
    await runtime.initialize()
    expect(runtime.roots()).toBe(0)
    expect(runtime.trees).toHaveLength(0)
  } finally {
    await runtime.close()
  }
})

test("standard MCP App sizing: accepts authored explicit height notifications without browser globals", async () => {
  const result = await buildGeneratedMcpApp({
    ...input,
    reactSource: `export default function SizedApp({ app, hostContext }) {
      React.useEffect(() => {
        void app.sendSizeChanged({ height: 420 })
      }, [app])
      return <section style={{ minHeight: 420 }}>
        <button onClick={() => app.sendSizeChanged({ width: 640, height: 560 })}>Expand</button>
        <p>{hostContext?.containerDimensions?.maxHeight}</p>
      </section>
    }`,
  })
  expect(result.ok).toBe(true)
  expect(result.diagnostics).toEqual([])
  if (!result.ok) return
  expect(result.html).toContain("sendSizeChanged")
  expect(result.html).toContain("ui/notifications/size-changed")
  expect(result.html).toContain("ResizeObserver")
  expect(result.html).not.toContain("sandbox-diagnostic")
  expect(result.csp).toEqual({ connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] })
})

test("standard MCP App sizing: sends exact explicit size notifications through the official SDK protocol", async () => {
  const runtime = await runtimeHarness()
  try {
    const sizes: McpUiSizeChangedNotification["params"][] = []
    runtime.bridge.addEventListener("sizechange", (params) => sizes.push(params))
    await runtime.initialize()
    const app = runtime.latest().props.app
    expect(app).toBeInstanceOf(App)
    expect(sizes).toEqual([])
    const heightOnly: Parameters<App["sendSizeChanged"]>[0] = { height: 420 }
    const sent: Promise<void> = app.sendSizeChanged(heightOnly)
    expect(await sent).toBeUndefined()
    await app.sendSizeChanged({ width: 640, height: 560 })
    expect(sizes).toEqual([{ height: 420 }, { width: 640, height: 560 }])
    expect(runtime.messages.filter((message) => "method" in message && message.method === "ui/notifications/size-changed")).toEqual([
      { jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { height: 420 } },
      { jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { width: 640, height: 560 } },
    ])
    expect(runtime.roots()).toBe(1)
    expect(runtime.unmounts()).toBe(0)
  } finally {
    await runtime.close()
  }
})

test("standard MCP App sizing: preserves host container dimensions and component identity on context updates", async () => {
  const runtime = await runtimeHarness({
    theme: "light", locale: "en", displayMode: "inline",
    containerDimensions: { width: 640, maxHeight: 480 },
  })
  try {
    await runtime.bridge.sendToolInput({ arguments: { input: { view: "inventory" } } })
    await runtime.bridge.sendToolResult({ content: [], structuredContent: { count: 3 } })
    await runtime.initialize()
    const first = runtime.latest()
    expect(first.props.hostContext?.containerDimensions).toEqual({ width: 640, maxHeight: 480 })
    await runtime.bridge.sendHostContextChange({ containerDimensions: { width: 360, height: 300 } })
    const resized = runtime.latest()
    expect(resized.props.hostContext).toEqual({
      theme: "light", locale: "en", displayMode: "inline",
      containerDimensions: { width: 360, height: 300 },
    })
    expect(resized.props.hostContext).toBe(resized.props.app.getHostContext())
    expect(resized.props.input).toBe(first.props.input)
    expect(resized.props.result).toBe(first.props.result)
    expect(resized.props.app).toBe(first.props.app)
    expect(resized.type).toBe(first.type)
    expect(resized.key).toBeNull()
    await runtime.bridge.sendHostContextChange({ theme: "dark" })
    expect(runtime.latest().props.hostContext?.containerDimensions).toEqual({ width: 360, height: 300 })
    expect(runtime.roots()).toBe(1)
    expect(runtime.unmounts()).toBe(0)
  } finally {
    await runtime.close()
  }
})

test("accepts prose, capability names, and component props that resemble blocked syntax", async () => {
  const result = await buildGeneratedMcpApp({
    ...input,
    reactSource: `function Chart({ data }) { return <ul>{data.map((row) => <li key={row}>{row}</li>)}</ul> }
      export default function View({ app }) {
        const [imports] = React.useState([])
        const report = { import: { total: 3 } }
        return <main>
          <label>Email (required)<input aria-required="true" required /></label>
          <p>This field is required. Ready to import your files. This is important.</p>
          <p>This step is important, so review it. 12 rows imported from Gmail. Choose a CSV file to import.</p>
          <p>Import contacts, then import orders from Shopify. {imports.length} {report.import.total}</p>
          <p>Persistent Worker status</p>
          <Chart data={["a", "b"]} />
          <button type="button" onClick={() => app.callServerTool({ name: "execute_capability", arguments: { name: "web.fetch" } })}>Run</button>
        </main>
      }`,
  })
  expect(result.diagnostics).toEqual([])
  expect(result.ok).toBe(true)
})

test.each([
  "import React from 'react'",
  "import * as R from 'react'",
  "import type { X } from 'x'",
  "const lazy = import('x')",
  "const meta = import.meta",
  "const x = require('x')",
  "export * from 'x'",
])("still rejects module syntax: %s", async (statement) => {
  const result = await buildGeneratedMcpApp({ ...input, reactSource: `${statement}\nexport default function View() { return <p /> }` })
  expect(result.ok).toBe(false)
})

test("still rejects URL-bearing attributes on DOM elements", async () => {
  const result = await buildGeneratedMcpApp({ ...input, reactSource: `export default function View() { return <a href="https://example.com">x</a> }` })
  expect(result.ok).toBe(false)
  expect(result.diagnostics[0]?.message).toContain("URL-bearing attributes")
})

test("a render failure before launch data arrives recovers on the next input or result without remounting healthy trees", async () => {
  const runtime = await runtimeHarness()
  try {
    await runtime.initialize()
    const Boundary = runtime.trees[0]?.type as unknown as {
      getDerivedStateFromError: () => { failed: boolean }
      getDerivedStateFromProps: (props: { revision: number }, state: { failed: boolean; revision: number }) => Partial<{ failed: boolean; revision: number }> | null
    }
    const initialRevision = (runtime.trees[0]?.props as { revision: number }).revision
    const failed = { failed: true, revision: initialRevision }
    expect(Boundary.getDerivedStateFromError()).toEqual({ failed: true })
    expect(Boundary.getDerivedStateFromProps({ revision: initialRevision }, failed)).toBeNull()
    await runtime.bridge.sendToolResult({ content: [], structuredContent: { title: "Ready" } })
    const nextRevision = (runtime.trees.at(-1)?.props as { revision: number }).revision
    expect(nextRevision).not.toBe(initialRevision)
    expect(Boundary.getDerivedStateFromProps({ revision: nextRevision }, failed)).toEqual({ failed: false, revision: nextRevision })
    expect(Boundary.getDerivedStateFromProps({ revision: nextRevision }, { failed: false, revision: initialRevision })).toEqual({ revision: nextRevision })
    expect(runtime.trees.every((tree) => tree.key === null)).toBe(true)
  } finally {
    await runtime.close()
  }
})
