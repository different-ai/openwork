/**
 * The libraries an MCP App built in OpenWork may import. Each package is pinned in
 * den-api's package.json and bundled into the App's own hash-authorized
 * script at build time: authors never choose a version, install a package or
 * load a CDN, and an App carries only what it imports. React stays injected.
 *
 * Imports are not the security boundary. The App's CSP (no network, data:
 * images only), the sandboxed frame and the tool broker are; library code
 * also renders through the same element checks as authored JSX.
 */
export type GeneratedAppLibrary = {
  /** The exact import specifiers an author may write. */
  imports: readonly string[]
  /** One instruction prepare_app gives authors: what to import and the rule that keeps it working. */
  guidance: string
  /** Specifiers resolved to another module of the same package, for every importer. */
  entries?: Readonly<Record<string, string>>
  /** Named exports refused with `hint`, such as one that bundles the whole package. */
  blockedExports?: readonly string[]
  /** false refuses `import * as`, for packages whose namespace is usually indexed dynamically. */
  namespaceImport?: false
  hint?: string
}

export const GENERATED_APP_LIBRARIES: readonly GeneratedAppLibrary[] = [
  {
    imports: ["lucide-react"],
    guidance: 'lucide-react for icons, each imported by name (import { Check, TriangleAlert } from "lucide-react"), sized with size={16} and colored by currentColor.',
    blockedExports: ["icons"],
    namespaceImport: false,
    hint: "Import each icon the App shows by name.",
  },
  {
    imports: ["recharts"],
    guidance: 'recharts for charts (import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip } from "recharts"): give ResponsiveContainer width="100%" and a fixed height such as 220, and color series with host variables such as stroke="var(--color-text-primary)".',
  },
  {
    imports: ["motion/react"],
    guidance: 'motion/react for animation (import { motion, AnimatePresence } from "motion/react"): animate motion.div with initial, animate and exit, keep transitions short, and never animate layout the person is reading.',
  },
  {
    imports: ["three", "three/addons/controls/OrbitControls.js"],
    // The published prebundle keeps renderer setup even for small named
    // imports; the pinned ESM source tree-shakes. OrbitControls imports
    // "three" too, so every importer shares this one copy.
    entries: { three: "three/src/Three.js" },
    guidance: 'three for 3D, with OrbitControls from "three/addons/controls/OrbitControls.js": pass a React canvas ref to new WebGLRenderer({ canvas, alpha: true }), size it from hostContext.containerDimensions.width, render on changes and the controls\' change event, and dispose controls, geometries, materials and the renderer on unmount. Build geometry in code (no loaders, models or remote textures) and show a readable fallback if WebGL fails.',
  },
]

export const GENERATED_APP_LIBRARY_IMPORTS: readonly string[] = GENERATED_APP_LIBRARIES.flatMap((library) => library.imports)

export function generatedAppLibrary(specifier: string): GeneratedAppLibrary | undefined {
  return GENERATED_APP_LIBRARIES.find((library) => library.imports.includes(specifier))
}

/** The drawing an App may do when libraries are on, beyond what React-only Apps get. */
export const GENERATED_APP_DRAWING_GUIDANCE = "You may also draw inline <svg> (shapes, paths, text and gradients; no <use>, <image>, <foreignObject> or SVG animation elements) or on a <canvas>, and use requestAnimationFrame for real motion: it pauses while the App is hidden."

/** prepare_app's note for an editor with libraries on. */
export function generatedAppLibrariesNextStep(): string {
  return [
    "Built-in libraries are on for you. Import only these, with static imports at the top of reactSource; OpenWork bundles its pinned copy and anything else fails to build:",
    ...GENERATED_APP_LIBRARIES.map((library) => library.guidance),
    GENERATED_APP_DRAWING_GUIDANCE,
  ].join(" ")
}
