import assert from "node:assert/strict"
import { createRequire } from "node:module"
import test from "node:test"
import { MCP_APP_MAX_HTML_BYTES } from "@openwork/types/mcp-app"
import { GENERATED_APP_LIBRARY_IMPORTS } from "../src/generated-app-libraries.js"
import {
  buildGeneratedArtifactView,
  buildGeneratedMcpApp,
  libraryReactModule,
  type GeneratedArtifactViewBuildResult,
} from "../src/generated-artifact-view-builder.js"

const metadata = { title: "Library App", description: null }
const LEGACY_HTML_BYTES = 768 * 1024

// One small App per library, written the way prepare_app tells authors to.
const samples = {
  "lucide-react": `import { Check } from "lucide-react";
export default function App() { return <p><Check size={16} /> All good</p>; }`,
  recharts: `import { ResponsiveContainer, LineChart, Line, XAxis } from "recharts";
export default function App() {
  return <ResponsiveContainer width="100%" height={220}><LineChart data={[{ day: "Mon", value: 2 }, { day: "Tue", value: 4 }]}>
    <XAxis dataKey="day" /><Line dataKey="value" stroke="var(--color-text-primary)" /></LineChart></ResponsiveContainer>;
}`,
  "motion/react": `import { motion } from "motion/react";
export default function App() { return <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}>Ready</motion.div>; }`,
  three: `import { WebGLRenderer, Scene, PerspectiveCamera, Mesh, BoxGeometry, MeshBasicMaterial } from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
export default function App() {
  const canvasRef = React.useRef(null);
  React.useEffect(() => {
    const renderer = new WebGLRenderer({ canvas: canvasRef.current, alpha: true });
    const scene = new Scene();
    const camera = new PerspectiveCamera(50, 1.5, 0.1, 100);
    const geometry = new BoxGeometry();
    const material = new MeshBasicMaterial({ color: 0x6699aa });
    scene.add(new Mesh(geometry, material));
    const controls = new OrbitControls(camera, canvasRef.current);
    const render = () => renderer.render(scene, camera);
    controls.addEventListener("change", render);
    let frame = requestAnimationFrame(render);
    return () => { cancelAnimationFrame(frame); controls.dispose(); geometry.dispose(); material.dispose(); renderer.dispose(); };
  }, []);
  return <canvas ref={canvasRef} aria-label="Interactive model" />;
}`,
} as const
const svgSource = `export default function App() {
  return <svg viewBox="0 0 10 10" role="img" aria-label="Trend"><path d="M0 10 L10 0" stroke="currentColor" /></svg>;
}`

function messages(result: GeneratedArtifactViewBuildResult): string {
  return result.diagnostics.map((item) => item.message).join("\n")
}

function assertRefused(result: GeneratedArtifactViewBuildResult, pattern: RegExp) {
  assert.equal(result.ok, false, "expected the build to be refused")
  assert.match(messages(result), pattern)
}

test("legacy artifact views still refuse library imports", async () => {
  assertRefused(await buildGeneratedArtifactView({ ...metadata, reactSource: samples.recharts, outputSchema: {} }), /module imports/)
})

test("each library bundles into a self-contained App with no network access", async (t) => {
  for (const [specifier, reactSource] of Object.entries(samples)) {
    const result = await buildGeneratedMcpApp({ ...metadata, reactSource })
    assert.equal(result.ok, true, messages(result))
    if (!result.ok) continue
    t.diagnostic(`${specifier}: ${result.htmlBytes} bytes`)
    assert.ok(result.htmlBytes <= MCP_APP_MAX_HTML_BYTES)
    assert.doesNotMatch(result.html, /<script\s+src=/)
    assert.match(result.html, /connect-src 'none'; frame-src 'none'/)
    assert.deepEqual(result.csp, { connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] })
  }
})

test("icons stay within the size every desktop host reads", async () => {
  const result = await buildGeneratedMcpApp({ ...metadata, reactSource: samples["lucide-react"] })
  assert.equal(result.ok, true, messages(result))
  if (result.ok) assert.ok(result.htmlBytes < LEGACY_HTML_BYTES)
})

test("a React-only App builds deterministically", async () => {
  const reactSource = "export default function App() { const [n, setN] = React.useState(0); return <button type=\"button\" onClick={() => setN(n + 1)}>{n}</button>; }"
  const off = await buildGeneratedMcpApp({ ...metadata, reactSource })
  const explicitOff = await buildGeneratedMcpApp({ ...metadata, reactSource })
  assert.equal(off.ok, true, messages(off))
  assert.deepEqual(explicitOff, off)
})

test("only exact static imports of a listed library build, and the refusal names the import", async (t) => {
  const refused: [string, RegExp][] = [
    ['import { debounce } from "lodash";', /cannot import "lodash"\. Import only the built-in libraries: lucide-react, recharts/],
    ['import { Vector3 } from "three/src/math/Vector3.js";', /cannot import "three\/src\/math\/Vector3\.js"/],
    ['import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";', /cannot import "three\/addons\/loaders\/GLTFLoader\.js"/],
    ['import { Check } from "lucide-react/dist/esm/icons/check.js";', /cannot import "lucide-react\/dist\/esm\/icons\/check\.js"/],
    ['import "https://example.invalid/three.js";', /cannot import "https:\/\/example\.invalid\/three\.js"/],
    ['const loaded = import("three");', /module imports or reexports/],
    ['const loaded = require("recharts");', /module imports or reexports/],
    ['export { Check } from "lucide-react";', /module imports or reexports/],
    ['export * from "three";', /module imports or reexports/],
    ['const url = import.meta.url;', /module imports or reexports/],
  ]
  const body = "export default function App() { return <p>Ready</p>; }"
  for (const [declaration, pattern] of refused) {
    await t.test(declaration, async () => {
      assertRefused(await buildGeneratedMcpApp({ ...metadata, reactSource: `${declaration}\n${body}` }), pattern)
    })
  }
  assert.deepEqual(GENERATED_APP_LIBRARY_IMPORTS, ["lucide-react", "recharts", "motion/react", "three", "three/addons/controls/OrbitControls.js"])
})

test("icons are imported by name, never the whole set", async () => {
  assertRefused(await buildGeneratedMcpApp({ ...metadata, reactSource: 'import * as Icons from "lucide-react";\nexport default function App() { const Icon = Icons.Check; return <Icon />; }' }), /cannot import all of "lucide-react" at once\. Import each icon/)
  assertRefused(await buildGeneratedMcpApp({ ...metadata, reactSource: 'import { icons as all } from "lucide-react";\nexport default function App() { return <p>{Object.keys(all).length}</p>; }' }), /cannot import icons from "lucide-react"/)
  const namespace = await buildGeneratedMcpApp({ ...metadata, reactSource: 'import * as THREE from "three";\nexport default function App() { return <p>{new THREE.Vector3(1, 2, 2).length()}</p>; }' })
  assert.equal(namespace.ok, true, messages(namespace))
})

test("libraries add SVG drawing and animation frames, not other browser access", async (t) => {
  const drawn = await buildGeneratedMcpApp({ ...metadata, reactSource: svgSource })
  assert.equal(drawn.ok, true, messages(drawn))
  const refused: [string, RegExp][] = [
    ["<svg><use /></svg>", /unsafe HTML elements/],
    ["<svg><image /></svg>", /unsafe HTML elements/],
    ["<svg><foreignObject /></svg>", /unsafe HTML elements/],
    ['<svg><a><set attributeName="x" to="1" /></a></svg>', /unsafe HTML elements/],
    ["<svg><animate /></svg>", /unsafe HTML elements/],
    ["<script />", /unsafe HTML elements/],
    ['<svg><image href="https://example.invalid/a.png" /></svg>', /URL-bearing attributes/],
    ["<p>{window.location.href}</p>", /browser host global "window"/],
    ['<p>{String(fetch("https://example.invalid"))}</p>', /browser host global "fetch"/],
    ["<p>{String(setTimeout(() => {}, 1))}</p>", /dynamic code or timers/],
    ['<p>{String(document.title)}</p>', /browser host global "document"/],
  ]
  for (const [markup, pattern] of refused) {
    await t.test(markup, async () => {
      assertRefused(await buildGeneratedMcpApp({ ...metadata, reactSource: `export default function App() { return ${markup}; }` }), pattern)
    })
  }
  const frame = "export default function App() { React.useEffect(() => { const id = requestAnimationFrame(() => {}); return () => cancelAnimationFrame(id); }, []); return <p>Ready</p>; }"
  const animated = await buildGeneratedMcpApp({ ...metadata, reactSource: frame })
  assert.equal(animated.ok, true, messages(animated))
})

test("library code renders through the same element checks as authored JSX", async () => {
  const require = createRequire(import.meta.url)
  const load = (specifier: string) => {
    const module = { exports: {} as Record<string, any> }
    new Function("require", "module", libraryReactModule(specifier))(require, module)
    return module.exports
  }
  const React = load("react")
  const runtime = load("react/jsx-runtime")
  assert.ok(React.createElement("svg", { viewBox: "0 0 1 1" }))
  assert.ok(runtime.jsx("path", { d: "M0 0" }))
  assert.throws(() => React.createElement("foreignObject"), /unsafe HTML elements/)
  assert.throws(() => runtime.jsx("iframe", {}), /unsafe HTML elements/)
  assert.throws(() => runtime.jsxs("a", { "xlink:href": "https://example.invalid", children: [] }), /URL-bearing/)
  assert.throws(() => React.cloneElement(React.createElement("a"), { href: "https://example.invalid" }), /URL-bearing/)
  assert.throws(() => React.createElement("div", { style: { backgroundImage: "url(https://example.invalid/a.png)" } }), /external resources/)

  // Each library build carries the checked module alongside authored React.
  const result = await buildGeneratedMcpApp({ ...metadata, reactSource: samples["lucide-react"] })
  assert.equal(result.ok, true, messages(result))
  if (result.ok) assert.ok(result.html.split("cannot render unsafe HTML elements").length - 1 >= 2)
})

test("an App with libraries is still refused past the larger compiled bound", async () => {
  // esbuild escapes each NUL, so bounded source can still compile past the cap.
  const reactSource = samples.three.replace('"Interactive model"', `{"${"\u0000".repeat(190_000)}"}`)
  const cssSource = `/*${"x".repeat(90_000)}*/`
  assertRefused(await buildGeneratedMcpApp({ ...metadata, reactSource, cssSource }), new RegExp(`Compiled MCP App exceeds ${MCP_APP_MAX_HTML_BYTES} bytes\\. Compiled size: \\d+ bytes\\.`))
})
