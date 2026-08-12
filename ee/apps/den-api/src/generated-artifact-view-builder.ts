import { createHash } from "node:crypto"
import { createRequire } from "node:module"
import { Worker } from "node:worker_threads"
import { build, version as esbuildVersion, type Message, type Plugin } from "esbuild"
import React from "react"
import type {
  GeneratedArtifactViewBuildDiagnostic,
  GeneratedArtifactViewCsp,
} from "@openwork/types/dynamic-artifacts"

const MAX_SOURCE_BYTES = 200_000
const MAX_CSS_BYTES = 100_000
// Keep provider output within the desktop MCP Apps host's resources/read limit.
const MAX_HTML_BYTES = 512 * 1024
const BUILD_TIMEOUT_MS = 2_000
const require = createRequire(import.meta.url)
const reactPackageRoot = require.resolve("react/package.json").replace(/\/package\.json$/u, "")
const reactDomPackageRoot = require.resolve("react-dom/package.json").replace(/\/package\.json$/u, "")

export const GENERATED_ARTIFACT_VIEW_COMPILER = "openwork-react-view"
export const GENERATED_ARTIFACT_VIEW_COMPILER_VERSION = "1"
export const GENERATED_ARTIFACT_VIEW_CSP: GeneratedArtifactViewCsp = {
  connectDomains: [],
  resourceDomains: [],
  frameDomains: [],
  baseUriDomains: [],
}

export type GeneratedArtifactViewBuildResult = {
  sourceDigest: string
  compilerName: string
  compilerVersion: string
  reactVersion: string
  csp: GeneratedArtifactViewCsp
  diagnostics: GeneratedArtifactViewBuildDiagnostic[]
} & (
  | { ok: true; html: string; resourceDigest: string; htmlBytes: number }
  | { ok: false }
)

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`
}

function diagnostic(message: string, location?: Message["location"]): GeneratedArtifactViewBuildDiagnostic {
  return {
    level: "error",
    message: message.slice(0, 4_000),
    line: location?.line ?? null,
    column: location?.column ?? null,
  }
}

function diagnosticsFrom(error: unknown): GeneratedArtifactViewBuildDiagnostic[] {
  if (typeof error === "object" && error !== null && "errors" in error && Array.isArray(error.errors)) {
    return error.errors.slice(0, 20).map((item) => {
      if (typeof item === "object" && item !== null && "text" in item) {
        const message = typeof item.text === "string" ? item.text : "React view build failed."
        const location = "location" in item && typeof item.location === "object"
          ? item.location as Message["location"]
          : undefined
        return diagnostic(message, location)
      }
      return diagnostic("React view build failed.")
    })
  }
  if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string") {
    return [diagnostic(error.message)]
  }
  return [diagnostic(error instanceof Error ? error.message : "React view build failed.")]
}

function sourcePolicyDiagnostic(reactSource: string, cssSource: string): GeneratedArtifactViewBuildDiagnostic | null {
  const sourceBytes = Buffer.byteLength(reactSource)
  const cssBytes = Buffer.byteLength(cssSource)
  if (sourceBytes > MAX_SOURCE_BYTES) return diagnostic(`React source exceeds ${MAX_SOURCE_BYTES} bytes.`)
  if (cssBytes > MAX_CSS_BYTES) return diagnostic(`CSS source exceeds ${MAX_CSS_BYTES} bytes.`)

  const forbidden = [
    { pattern: /\b(?:import|require)\s*(?:\(|["'{])/u, label: "module imports" },
    { pattern: /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|Worker)\b/u, label: "network APIs" },
    { pattern: /\b(?:process|globalThis|window|document|self|parent|top|opener|frames|location|navigator|history|postMessage|localStorage|sessionStorage|indexedDB)\b/u, label: "host globals" },
    { pattern: /\b(?:eval|Function|setTimeout|setInterval)\s*\(/u, label: "dynamic code or timers" },
    { pattern: /dangerouslySetInnerHTML/u, label: "dangerous HTML injection" },
    { pattern: /<[A-Za-z][^<>]*\b(?:href|src|srcSet|action|formAction|poster|ping|cite|xlinkHref|data)\s*=/u, label: "URL-bearing attributes" },
    { pattern: /<[A-Za-z][^<>]*\bstyle\s*=\s*\{\{[^<>]*?(?:url\s*\(|@import)/u, label: "styles that reference external resources" },
    { pattern: /<\/?(?:script|iframe|object|embed|form|base|link|meta|style|svg|math)\b/iu, label: "unsafe HTML elements" },
  ]
  const blocked = forbidden.find(({ pattern }) => pattern.test(reactSource))
  if (blocked) return diagnostic(`Generated Artifact views cannot use ${blocked.label}. Use props.data and React rendering only.`)
  if (/^\s*@import\b/mu.test(cssSource) || /url\s*\(/u.test(cssSource)) {
    return diagnostic("Generated Artifact CSS cannot import or reference external resources.")
  }
  if (/<\/style/iu.test(cssSource)) return diagnostic("Generated Artifact CSS cannot close the bundle style element.")
  return null
}

const SAFE_REACT_PREAMBLE = `
const blockedArtifactElementNames = new Set(["script", "iframe", "object", "embed", "form", "base", "link", "meta", "style", "svg", "math"]);
const blockedArtifactPropNames = new Set(["dangerouslysetinnerhtml", "href", "src", "srcset", "action", "formaction", "poster", "ping", "cite", "data", "xlinkhref"]);
function assertSafeArtifactElement(type, props) {
  if (typeof type !== "string") return;
  if (blockedArtifactElementNames.has(type.toLowerCase())) throw new Error("Generated Artifact views cannot render unsafe HTML elements.");
  if (!props || typeof props !== "object") return;
  for (const key of Object.keys(props)) {
    if (blockedArtifactPropNames.has(key.toLowerCase())) throw new Error("Generated Artifact views cannot render URL-bearing or HTML-injection attributes.");
  }
  if (props.style && typeof props.style === "object" && Object.values(props.style).some((value) => typeof value === "string" && /(?:url\\s*\\(|@import)/iu.test(value))) {
    throw new Error("Generated Artifact views cannot render styles that reference external resources.");
  }
}
function createSafeArtifactReact(baseReact) {
  return Object.assign({}, baseReact, {
    createElement(type, props, ...children) {
      assertSafeArtifactElement(type, props);
      return baseReact.createElement(type, props, ...children);
    },
  });
}
`

function schemaFixture(schema: unknown, depth = 0): unknown {
  if (depth > 5 || typeof schema !== "object" || schema === null || Array.isArray(schema)) return null
  const value = schema as Record<string, unknown>
  if (value.const !== undefined) return value.const
  if (Array.isArray(value.enum) && value.enum.length > 0) return value.enum[0]
  const type = value.type
  if (type === "object" || (type === undefined && typeof value.properties === "object")) {
    const properties = typeof value.properties === "object" && value.properties !== null && !Array.isArray(value.properties)
      ? value.properties as Record<string, unknown>
      : {}
    return Object.fromEntries(Object.entries(properties).slice(0, 30).map(([key, property]) => [key, schemaFixture(property, depth + 1)]))
  }
  if (type === "array") return value.items === undefined ? [] : [schemaFixture(value.items, depth + 1)]
  if (type === "string") return typeof value.format === "string" && value.format.includes("date") ? "2026-01-01" : "Example"
  if (type === "number" || type === "integer") return 0
  if (type === "boolean") return false
  if (Array.isArray(value.oneOf) && value.oneOf[0] !== undefined) return schemaFixture(value.oneOf[0], depth + 1)
  if (Array.isArray(value.anyOf) && value.anyOf[0] !== undefined) return schemaFixture(value.anyOf[0], depth + 1)
  return null
}

function safeJson(value: unknown): string {
  return JSON.stringify(value).replace(/</gu, "\\u003c").replace(/\u2028/gu, "\\u2028").replace(/\u2029/gu, "\\u2029")
}

function generatedArtifactPlugin(reactSource: string): Plugin {
  return {
    name: "generated-artifact-view",
    setup(pluginBuild) {
      pluginBuild.onResolve({ filter: /^artifact:view$/ }, () => ({ path: "artifact:view", namespace: "generated-artifact" }))
      pluginBuild.onResolve({ filter: /^artifact:safe-react$/ }, () => ({ path: "artifact:safe-react", namespace: "generated-artifact-runtime" }))
      pluginBuild.onLoad({ filter: /.*/, namespace: "generated-artifact" }, () => ({
        contents: `import React from "artifact:safe-react";\n${reactSource}`,
        loader: "tsx",
        resolveDir: process.cwd(),
      }))
      pluginBuild.onLoad({ filter: /.*/, namespace: "generated-artifact-runtime" }, () => ({
        contents: `import BaseReact from "react";\n${SAFE_REACT_PREAMBLE}\nexport default createSafeArtifactReact(BaseReact);`,
        loader: "js",
        resolveDir: process.cwd(),
      }))
    },
  }
}

async function buildClientBundle(reactSource: string, previewData: unknown, previewArtifact: Record<string, unknown>): Promise<string> {
  const entry = `
    import React from "react";
    import { createRoot } from "react-dom/client";
    import ArtifactView from "artifact:view";
    const mount = document.getElementById("openwork-artifact-view-root");
    let payload = { data: ${safeJson(previewData)}, artifact: ${safeJson(previewArtifact)} };
    const root = createRoot(mount);
    root.render(React.createElement(ArtifactView, payload));
    const post = (message) => window.parent.postMessage(message, "*");
    const apply = (next) => { payload = next; root.render(React.createElement(ArtifactView, next)); requestAnimationFrame(() => post({ jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { width: Math.ceil(document.documentElement.scrollWidth), height: Math.ceil(document.documentElement.scrollHeight) } })); };
    window.addEventListener("message", (event) => {
      if (event.source !== window.parent || !event.data || event.data.jsonrpc !== "2.0") return;
      const message = event.data;
      if (message.id === "openwork-generated-artifact:init" && message.result) { post({ jsonrpc: "2.0", method: "ui/notifications/initialized" }); return; }
      if (message.method === "ui/notifications/tool-result" && message.params && !message.params.isError && message.params.structuredContent) apply(message.params.structuredContent);
      if (message.method === "ui/resource-teardown" && message.id !== undefined) post({ jsonrpc: "2.0", id: message.id, result: {} });
    });
    post({ jsonrpc: "2.0", id: "openwork-generated-artifact:init", method: "ui/initialize", params: { appInfo: { name: "OpenWork Generated Artifact", version: "1.0.0" }, appCapabilities: {}, protocolVersion: "2026-01-26" } });
  `
  const result = await build({
    stdin: { contents: entry, loader: "tsx", resolveDir: process.cwd(), sourcefile: "generated-artifact-entry.tsx" },
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    target: ["es2022"],
    minify: true,
    legalComments: "none",
    define: { "process.env.NODE_ENV": '"production"' },
    alias: {
      react: reactPackageRoot,
      "react-dom": reactDomPackageRoot,
    },
    plugins: [generatedArtifactPlugin(reactSource)],
  })
  const javascript = result.outputFiles[0]?.text
  if (!javascript) throw new Error("The React client bundle was empty.")
  return javascript.replace(/<\/script/giu, "<\\/script")
}

export type GeneratedArtifactViewBuildInput = {
  reactSource: string
  cssSource?: string
  outputSchema: unknown
  title: string
  description: string | null
}

export async function buildGeneratedArtifactViewInWorker(input: GeneratedArtifactViewBuildInput): Promise<GeneratedArtifactViewBuildResult> {
  const reactSource = input.reactSource.trim()
  const cssSource = input.cssSource?.trim() ?? ""
  const sourceDigest = digest(`${reactSource}\n\u0000${cssSource}`)
  const shared = {
    sourceDigest,
    compilerName: GENERATED_ARTIFACT_VIEW_COMPILER,
    compilerVersion: GENERATED_ARTIFACT_VIEW_COMPILER_VERSION,
    reactVersion: React.version,
    csp: GENERATED_ARTIFACT_VIEW_CSP,
  }
  const policyFailure = sourcePolicyDiagnostic(reactSource, cssSource)
  if (policyFailure) return { ok: false, ...shared, diagnostics: [policyFailure] }

  try {
    const previewData = schemaFixture(input.outputSchema)
    const previewArtifact = {
      title: input.title,
      description: input.description,
      freshness: { state: "never_run" },
      source: "manual",
    }
    // esbuild parses and bundles generated source, but OpenWork never executes
    // it in the Den process. The authored React runs only after the immutable
    // resource is loaded by an MCP host in its sandboxed iframe.
    const javascript = await buildClientBundle(reactSource, previewData, previewArtifact)
    const scriptDigest = createHash("sha256").update(javascript).digest("base64")
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'sha256-${scriptDigest}'; script-src-attr 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; worker-src 'none'"><title>${input.title.replace(/[<&>]/gu, "")}</title><style>${cssSource}</style></head><body><div id="openwork-artifact-view-root"></div><script>${javascript}</script></body></html>`
    const htmlBytes = Buffer.byteLength(html)
    if (htmlBytes > MAX_HTML_BYTES) throw new Error(`Compiled MCP App exceeds ${MAX_HTML_BYTES} bytes.`)
    return {
      ok: true,
      ...shared,
      html,
      htmlBytes,
      resourceDigest: digest(html),
      diagnostics: [],
    }
  } catch (error) {
    return { ok: false, ...shared, diagnostics: diagnosticsFrom(error) }
  }
}

export async function buildGeneratedArtifactView(input: GeneratedArtifactViewBuildInput): Promise<GeneratedArtifactViewBuildResult> {
  // Bun's test loader does not propagate TypeScript module loading into Node
  // worker_threads; production executes the emitted JavaScript worker.
  if (import.meta.url.endsWith(".ts")) return buildGeneratedArtifactViewInWorker(input)
  const worker = new Worker(new URL("./generated-artifact-view-build-worker.js", import.meta.url), {
    workerData: input,
    env: { NODE_ENV: "production" },
    execArgv: [],
    resourceLimits: {
      maxOldGenerationSizeMb: 64,
      maxYoungGenerationSizeMb: 16,
      stackSizeMb: 4,
    },
  })
  return new Promise((resolve) => {
    let settled = false
    const finish = (result: GeneratedArtifactViewBuildResult) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      resolve(result)
    }
    const timeout = setTimeout(() => {
      void worker.terminate()
      finish({
        ok: false,
        sourceDigest: digest(`${input.reactSource.trim()}\n\u0000${input.cssSource?.trim() ?? ""}`),
        compilerName: GENERATED_ARTIFACT_VIEW_COMPILER,
        compilerVersion: GENERATED_ARTIFACT_VIEW_COMPILER_VERSION,
        reactVersion: React.version,
        csp: GENERATED_ARTIFACT_VIEW_CSP,
        diagnostics: [diagnostic("React view build exceeded the server time limit.")],
      })
    }, BUILD_TIMEOUT_MS + 3_000)
    worker.once("message", (result: GeneratedArtifactViewBuildResult) => finish(result))
    worker.once("error", (error) => finish({
      ok: false,
      sourceDigest: digest(`${input.reactSource.trim()}\n\u0000${input.cssSource?.trim() ?? ""}`),
      compilerName: GENERATED_ARTIFACT_VIEW_COMPILER,
      compilerVersion: GENERATED_ARTIFACT_VIEW_COMPILER_VERSION,
      reactVersion: React.version,
      csp: GENERATED_ARTIFACT_VIEW_CSP,
      diagnostics: diagnosticsFrom(error),
    }))
    worker.once("exit", (code) => {
      if (code !== 0) finish({
        ok: false,
        sourceDigest: digest(`${input.reactSource.trim()}\n\u0000${input.cssSource?.trim() ?? ""}`),
        compilerName: GENERATED_ARTIFACT_VIEW_COMPILER,
        compilerVersion: GENERATED_ARTIFACT_VIEW_COMPILER_VERSION,
        reactVersion: React.version,
        csp: GENERATED_ARTIFACT_VIEW_CSP,
        diagnostics: [diagnostic(`React view build worker exited with code ${code}.`)],
      })
    })
  })
}
