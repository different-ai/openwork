export type GeneratedAppLibrary = {
  imports: readonly string[]
  guidance: string
  entries?: Readonly<Record<string, string>>
  blockedExports?: readonly string[]
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
    entries: { three: "three/src/Three.js" },
    guidance: 'three for 3D, with OrbitControls from "three/addons/controls/OrbitControls.js": pass a React canvas ref to new WebGLRenderer({ canvas, alpha: true }), size it from hostContext.containerDimensions.width, render on changes and the controls\' change event, and dispose controls, geometries, materials and the renderer on unmount. Build geometry in code (no loaders, models or remote textures) and show a readable fallback if WebGL fails.',
  },
]

export const GENERATED_APP_LIBRARY_IMPORTS: readonly string[] = GENERATED_APP_LIBRARIES.flatMap((library) => library.imports)

export function generatedAppLibrary(specifier: string): GeneratedAppLibrary | undefined {
  return GENERATED_APP_LIBRARIES.find((library) => library.imports.includes(specifier))
}

export const GENERATED_APP_DRAWING_GUIDANCE = "You may also draw inline <svg> (shapes, paths, text and gradients; no <use>, <image>, <foreignObject> or SVG animation elements) or on a <canvas>, and use requestAnimationFrame for real motion: it pauses while the App is hidden."

export function generatedAppLibrariesNextStep(): string {
  return [
    "Built-in libraries are on for you. Import only these, with static imports at the top of reactSource; OpenWork bundles its pinned copy and anything else fails to build:",
    ...GENERATED_APP_LIBRARIES.map((library) => library.guidance),
    GENERATED_APP_DRAWING_GUIDANCE,
  ].join(" ")
}
