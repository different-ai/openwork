import { createHash } from "node:crypto"
import { createRequire } from "node:module"
import { Worker } from "node:worker_threads"
import { build, transform, type Message, type Plugin } from "esbuild"
import React from "react"
import { GENERATED_MCP_APP_ENTRY } from "./generated-mcp-app-runtime.js"
import type {
  GeneratedArtifactViewBuildDiagnostic,
  GeneratedArtifactViewCsp,
} from "@openwork/types/workflows"

const MAX_SOURCE_BYTES = 200_000
const MAX_CSS_BYTES = 100_000
// Keep provider output within the desktop MCP Apps host's resources/read limit.
const MAX_HTML_BYTES = 768 * 1024
const BUILD_TIMEOUT_MS = 2_000
const require = createRequire(import.meta.url)
// The browser-ready entry retains the stable MCP Apps client while avoiding
// rebundling the SDK's validation dependencies into every immutable view.
const extAppsEntry = require.resolve("@modelcontextprotocol/ext-apps/app-with-deps")
const reactPackageRoot = require.resolve("react/package.json").replace(/\/package\.json$/u, "")
const reactDomPackageRoot = require.resolve("react-dom/package.json").replace(/\/package\.json$/u, "")

export const GENERATED_ARTIFACT_VIEW_COMPILER = "openwork-react-view"
export const GENERATED_ARTIFACT_VIEW_COMPILER_VERSION = "3"
export const GENERATED_MCP_APP_COMPILER = "openwork-react-mcp-app"
export const GENERATED_MCP_APP_COMPILER_VERSION = "1"
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

// Workflow-bound Artifact views keep refusing only the first 16, as they
// always have; MCP Apps refuse the whole list.
const ARTIFACT_HOST_GLOBAL_COUNT = 16
const HOST_GLOBAL_NAMES = [
  "process", "globalThis", "window", "document", "self", "parent", "top", "opener", "frames",
  "location", "navigator", "history", "postMessage", "localStorage", "sessionStorage", "indexedDB",
  "fetch", "XMLHttpRequest", "WebSocket", "EventSource", "Worker", "SharedWorker", "WebTransport",
  "RTCPeerConnection", "Image", "Audio", "eval", "Function", "setTimeout", "setInterval",
  "clearTimeout", "clearInterval", "requestAnimationFrame", "cancelAnimationFrame",
  "requestIdleCallback", "cancelIdleCallback", "queueMicrotask", "getComputedStyle",
  "addEventListener", "removeEventListener", "dispatchEvent", "open", "close",
  "require", "module", "exports", "Buffer", "Bun", "Deno", "global", "__dirname", "__filename",
] as const

const HOST_GLOBAL_DEFINES = Object.fromEntries(HOST_GLOBAL_NAMES.map((name, index) => [
  name,
  `__openwork_forbidden_host_global_${index}__`,
]))

// The bundler rejects real imports anyway; these patterns only explain the
// refusal early. Artifact views keep the check they have always had.
const ARTIFACT_MODULE_PATTERN = /\b(?:import|require)\s*(?:\(|["'{])/u
// MCP Apps also name default, namespace, type, and meta imports and reexports,
// matching only real module syntax so text such as "important," "imported from",
// "to import." or data.import still builds.
const AUTHORED_MODULE_PATTERN = /\bimport\s*(?:\(|["'{*]|\.\s*meta\b)|\bimport\s+(?:type\s+)?(?:[\w$]+\s*,\s*[{*]|[\w$]+\s+from\s*["']|\{[^}]*\}\s*from\s*["']|\*\s*as\s+[\w$]+\s+from\s*["'])|\brequire\s*\(|\bexport\s*(?:type\s+)?(?:\*|\{[^}]*\})\s*(?:as\s+[\w$]+\s*)?from\s*["']/u
const SAFE_REACT_FACTORY = "__openworkSafeReact"

async function sourcePolicyDiagnostic(reactSource: string, cssSource: string, runtime: "artifact" | "mcp-app"): Promise<GeneratedArtifactViewBuildDiagnostic | null> {
  const sourceBytes = Buffer.byteLength(reactSource)
  const cssBytes = Buffer.byteLength(cssSource)
  if (sourceBytes > MAX_SOURCE_BYTES) return diagnostic(`React source exceeds ${MAX_SOURCE_BYTES} bytes.`)
  if (cssBytes > MAX_CSS_BYTES) return diagnostic(`CSS source exceeds ${MAX_CSS_BYTES} bytes.`)

  const subject = runtime === "mcp-app" ? "MCP Apps" : "Artifact views"
  // MCP Apps rely on the scope-aware host-global pass below for network APIs,
  // so prose and tool names such as "Worker" or "web.fetch" stay usable, and
  // only DOM (lowercase) elements carry URL-bearing attributes; components
  // may take props such as data={rows}. The runtime guard still checks DOM props.
  const mcpApp = runtime === "mcp-app"
  const forbidden = [
    mcpApp
      ? { pattern: AUTHORED_MODULE_PATTERN, label: "module imports or reexports" }
      : { pattern: ARTIFACT_MODULE_PATTERN, label: "module imports" },
    { pattern: /@jsx(?:Runtime|ImportSource|Frag)?\b/u, label: "JSX compiler directives" },
    { pattern: /\b__openworkSafeReact\b/u, label: "reserved compiler bindings" },
    ...(mcpApp ? [] : [{ pattern: /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|Worker)\b/u, label: "network APIs" }]),
    { pattern: /\b(?:eval|Function|setTimeout|setInterval)\s*\(/u, label: "dynamic code or timers" },
    { pattern: /dangerouslySetInnerHTML/u, label: "dangerous HTML injection" },
    { pattern: mcpApp
      ? /<[a-z][^<>]*\b(?:href|src|srcSet|action|formAction|poster|ping|cite|xlinkHref|data)\s*=/u
      : /<[A-Za-z][^<>]*\b(?:href|src|srcSet|action|formAction|poster|ping|cite|xlinkHref|data)\s*=/u, label: "URL-bearing attributes" },
    { pattern: /<[A-Za-z][^<>]*\bstyle\s*=\s*\{\{[^<>]*?(?:url\s*\(|@import)/u, label: "styles that reference external resources" },
    { pattern: /<\/?(?:script|iframe|object|embed|form|base|link|meta|style|svg|math)\b/iu, label: "unsafe HTML elements" },
  ]
  const blocked = forbidden.find(({ pattern }) => pattern.test(reactSource))
  if (blocked) {
    return diagnostic(`Generated ${subject} cannot use ${blocked.label}. ${mcpApp ? "Use component props" : "Use props.data"} and React rendering only.`)
  }

  // esbuild's define substitution is scope-aware: it replaces only unbound
  // global references and leaves local bindings such as `const top = ...`
  // untouched. Inspecting the parsed output avoids both the old local-name
  // false positive and whole-file shadowing bypasses across nested scopes.
  let scopeAnalyzedSource: string
  try {
    scopeAnalyzedSource = (await transform(reactSource, {
      loader: "tsx",
      format: "esm",
      target: "es2022",
      legalComments: "none",
      jsx: "preserve",
      tsconfigRaw: { compilerOptions: { verbatimModuleSyntax: true } },
      define: HOST_GLOBAL_DEFINES,
    })).code
  } catch (error) {
    return diagnosticsFrom(error)[0] ?? diagnostic("React view build failed.")
  }
  if (mcpApp && AUTHORED_MODULE_PATTERN.test(scopeAnalyzedSource)) {
    return diagnostic(`Generated ${subject} cannot use module imports or reexports.`)
  }
  if (scopeAnalyzedSource.includes(SAFE_REACT_FACTORY)) {
    return diagnostic(`Generated ${subject} cannot use reserved compiler bindings.`)
  }
  const hostGlobal = HOST_GLOBAL_NAMES.find((_, index) =>
    (mcpApp || index < ARTIFACT_HOST_GLOBAL_COUNT)
    && scopeAnalyzedSource.includes(`__openwork_forbidden_host_global_${index}__`))
  if (hostGlobal) {
    return diagnostic(`Generated ${subject} cannot use the browser host global "${hostGlobal}". Use component props and React rendering only.`)
  }
  const cssSubject = mcpApp ? "Generated CSS" : "Generated Artifact CSS"
  const externalCss = mcpApp
    ? /@import\b/iu.test(cssSource) || /url\s*\(/iu.test(cssSource)
    : /^\s*@import\b/mu.test(cssSource) || /url\s*\(/u.test(cssSource)
  if (externalCss) return diagnostic(`${cssSubject} cannot import or reference external resources.`)
  if (/<\/style/iu.test(cssSource)) return diagnostic(`${cssSubject} cannot close the bundle style element.`)
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
  return Object.freeze(Object.assign({}, baseReact, {
    createElement(type, props, ...children) {
      assertSafeArtifactElement(type, props);
      return baseReact.createElement(type, props, ...children);
    },
  }));
}
`

function generatedArtifactPlugin(reactSource: string): Plugin {
  return {
    name: "generated-artifact-view",
    setup(pluginBuild) {
      pluginBuild.onResolve({ filter: /.*/, namespace: "generated-artifact" }, (args) => {
        if (args.path === "artifact:safe-react" && args.kind === "import-statement") {
          return { path: args.path, namespace: "generated-artifact-runtime" }
        }
        return { errors: [{ text: "Generated source cannot use module imports or reexports." }] }
      })
      pluginBuild.onResolve({ filter: /^artifact:view$/ }, () => ({ path: "artifact:view", namespace: "generated-artifact" }))
      pluginBuild.onLoad({ filter: /.*/, namespace: "generated-artifact" }, () => ({
        contents: `import ${SAFE_REACT_FACTORY} from "artifact:safe-react";\nconst React = ${SAFE_REACT_FACTORY};\n${reactSource}`,
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

const GENERATED_ARTIFACT_RUNTIME_REPORTER = `
(() => {
  const safeMessage = (value) => {
    if (value instanceof Error) return value.message.slice(0, 1000);
    if (typeof value === "string") return value.slice(0, 1000);
    return "The generated Artifact application failed at runtime.";
  };
  const report = (stage, value) => {
    window.parent.postMessage({
      method: "ui/notifications/sandbox-diagnostic",
      params: {
        code: "MCP_APP_DOCUMENT_RUNTIME_ERROR",
        message: stage + ": " + safeMessage(value),
      },
    }, "*");
  };
  window.__openworkReportArtifactRuntimeError = report;
  window.addEventListener("error", (event) => report("document-error", event.error || event.message));
  window.addEventListener("unhandledrejection", (event) => report("unhandled-rejection", event.reason));
})();
`.trim().replace(/<\/script/giu, "<\\/script")

async function buildClientBundle(reactSource: string, runtime: "artifact" | "mcp-app"): Promise<string> {
  const entry = runtime === "mcp-app" ? GENERATED_MCP_APP_ENTRY : `
    import React from "react";
    import { createRoot } from "react-dom/client";
    import { App, PostMessageTransport } from "@modelcontextprotocol/ext-apps";
    const ArtifactView = React.lazy(() => import("artifact:view"));
    const mount = document.getElementById("openwork-artifact-view-root");
    const reportRuntimeError = (stage, error) => {
      const report = window.__openworkReportArtifactRuntimeError;
      if (typeof report === "function") report(stage, error);
    };
    const renderFailure = () => React.createElement("p", { role: "alert", style: { margin: "16px", fontFamily: "system-ui, sans-serif" } }, "This Artifact view could not render. The normal tool result is still available.");
    class ArtifactViewErrorBoundary extends React.Component {
      constructor(props) { super(props); this.state = { failed: false }; }
      static getDerivedStateFromError() { return { failed: true }; }
      componentDidCatch(error) { reportRuntimeError("react-render", error); }
      render() { return this.state.failed ? renderFailure() : this.props.children; }
    }
    let root = null;
    let renderRevision = 0;
    const apply = (next) => {
      try {
        if (!mount) throw new Error("The generated Artifact mount element is missing.");
        root ||= createRoot(mount);
        renderRevision += 1;
        root.render(React.createElement(ArtifactViewErrorBoundary, { key: renderRevision }, React.createElement(React.Suspense, { fallback: null }, React.createElement(ArtifactView, next))));
      } catch (error) {
        reportRuntimeError("react-mount", error);
        if (mount) mount.textContent = "This Artifact view could not render. The normal tool result is still available.";
      }
    };
    const app = new App(
      { name: "OpenWork Generated Artifact", version: "1.0.0" },
      {},
      { autoResize: true, strict: true },
    );
    app.ontoolresult = (result) => {
      if (result.isError || !result.structuredContent) return;
      apply(result.structuredContent);
    };
    app.onteardown = async () => {
      root?.unmount();
      root = null;
      return {};
    };
    void app.connect(new PostMessageTransport(window.parent, window.parent)).catch((error) => {
      reportRuntimeError("mcp-app-initialize", error);
      if (mount) mount.textContent = "This Artifact view could not initialize. The normal tool result is still available.";
    });
  `
  const result = await build({
    stdin: { contents: entry, loader: "tsx", resolveDir: process.cwd(), sourcefile: "generated-artifact-entry.tsx" },
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    target: ["es2022"],
    jsx: "transform",
    jsxFactory: `${SAFE_REACT_FACTORY}.createElement`,
    jsxFragment: `${SAFE_REACT_FACTORY}.Fragment`,
    tsconfigRaw: { compilerOptions: { jsx: "react" } },
    minify: true,
    legalComments: "none",
    define: { "process.env.NODE_ENV": '"production"' },
    alias: {
      "@modelcontextprotocol/ext-apps": extAppsEntry,
      react: reactPackageRoot,
      "react-dom": reactDomPackageRoot,
    },
    plugins: [generatedArtifactPlugin(reactSource)],
  })
  const javascript = result.outputFiles[0]?.text
  if (!javascript) throw new Error("The React client bundle was empty.")
  return javascript.replace(/<\/script/giu, "<\\/script")
}

export type GeneratedMcpAppBuildInput = {
  reactSource: string
  cssSource?: string
  title: string
  description: string | null
}

export type GeneratedArtifactViewBuildInput = GeneratedMcpAppBuildInput & {
  outputSchema: unknown
}

export type GeneratedArtifactViewCompilerInput =
  | (GeneratedArtifactViewBuildInput & { runtime?: "artifact" })
  | (GeneratedMcpAppBuildInput & { runtime: "mcp-app" })

function buildMetadata(input: GeneratedArtifactViewCompilerInput) {
  const reactSource = input.reactSource.trim()
  const cssSource = input.cssSource?.trim() ?? ""
  const mcpApp = input.runtime === "mcp-app"
  return {
    sourceDigest: digest(mcpApp
      ? JSON.stringify(["mcp-app", GENERATED_MCP_APP_COMPILER_VERSION, reactSource, cssSource, input.title, input.description])
      : `${reactSource}\n\u0000${cssSource}`),
    compilerName: mcpApp ? GENERATED_MCP_APP_COMPILER : GENERATED_ARTIFACT_VIEW_COMPILER,
    compilerVersion: mcpApp ? GENERATED_MCP_APP_COMPILER_VERSION : GENERATED_ARTIFACT_VIEW_COMPILER_VERSION,
    reactVersion: React.version,
    csp: GENERATED_ARTIFACT_VIEW_CSP,
  }
}

export async function buildGeneratedArtifactViewInWorker(input: GeneratedArtifactViewCompilerInput): Promise<GeneratedArtifactViewBuildResult> {
  const reactSource = input.reactSource.trim()
  const cssSource = input.cssSource?.trim() ?? ""
  const runtime = input.runtime ?? "artifact"
  const shared = buildMetadata(input)
  const policyFailure = await sourcePolicyDiagnostic(reactSource, cssSource, runtime)
  if (policyFailure) return { ok: false, ...shared, diagnostics: [policyFailure] }

  try {
    const javascript = await buildClientBundle(reactSource, runtime)
    const scripts = runtime === "mcp-app" ? [javascript] : [GENERATED_ARTIFACT_RUNTIME_REPORTER, javascript]
    const scriptPolicy = scripts.map((script) => `'sha256-${createHash("sha256").update(script).digest("base64")}'`).join(" ")
    const rootId = runtime === "mcp-app" ? "openwork-mcp-app-root" : "openwork-artifact-view-root"
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src ${scriptPolicy}; script-src-attr 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; worker-src 'none'"><title>${input.title.replace(/[<&>]/gu, "")}</title><style>${cssSource}</style></head><body><div id="${rootId}"></div>${scripts.map((script) => `<script>${script}</script>`).join("")}</body></html>`
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
  return buildGeneratedView({ ...input, runtime: "artifact" })
}

export async function buildGeneratedMcpApp(input: GeneratedMcpAppBuildInput): Promise<GeneratedArtifactViewBuildResult> {
  return buildGeneratedView({ ...input, runtime: "mcp-app" })
}

async function buildGeneratedView(input: GeneratedArtifactViewCompilerInput): Promise<GeneratedArtifactViewBuildResult> {
  // Bun's test loader does not propagate TypeScript module loading into Node
  // worker_threads; production executes the emitted JavaScript worker.
  if (import.meta.url.endsWith(".ts")) return buildGeneratedArtifactViewInWorker(input)
  const shared = buildMetadata(input)
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
        ...shared,
        diagnostics: [diagnostic("React view build exceeded the server time limit.")],
      })
    }, BUILD_TIMEOUT_MS + 3_000)
    worker.once("message", (result: GeneratedArtifactViewBuildResult) => finish(result))
    worker.once("error", (error) => finish({
      ok: false,
      ...shared,
      diagnostics: diagnosticsFrom(error),
    }))
    worker.once("exit", (code) => {
      if (code !== 0) finish({
        ok: false,
        ...shared,
        diagnostics: [diagnostic(`React view build worker exited with code ${code}.`)],
      })
    })
  })
}
