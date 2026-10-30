# Built-in libraries in Apps

> **GA:** Available without a feature flag. The former rollout key is retired.

- Retired rollout key: `mcpAppLibraries`
- Deployments: cloud and self-hosted
- Author: `reachjalil`
- Status: generally available (no flag)

## What changes

Apps built in OpenWork get injected React and may also use a small set of
built-in libraries:

| Need | Import |
|---|---|
| Icons | `lucide-react`, each icon by name |
| Charts | `recharts` |
| Animation | `motion/react` |
| 3D | `three` and `three/addons/controls/OrbitControls.js` |

They also get drawing: inline `<svg>` (shapes, paths, text, gradients) and
`requestAnimationFrame`, which pauses while the App is hidden. These SVG
elements stay refused because they load other content, embed HTML or
rewrite attributes over time: `<use>`, `<image>`, `<feImage>`,
`<foreignObject>`, `<set>`, `<animate>`, `<animateMotion>`,
`<animateTransform>` and `<discard>`.

The catalogue lives in `ee/apps/den-api/src/generated-app-libraries.ts`. Each
package is pinned in den-api's `package.json` and bundled into the App's own
hash-authorized script when it is built. Authors never pick a version, install
a package or load a CDN, and an App carries only what it imports. Adding a
library means pinning it, adding one catalogue entry and testing a mounted App
that uses it.

What stays the same:

- No network: the App CSP keeps `connect-src 'none'`, `data:`-only images and
  fonts, and no remote resources. Library loaders that fetch files fail.
- Library code renders through the same element checks as authored JSX, so a
  library cannot render a `<script>`, `<iframe>`, URL-bearing attribute or
  refused SVG element on an App's behalf.
- Authored source still cannot use browser globals, timers, dynamic imports,
  `require`, reexports, or any package or subpath outside the catalogue.
- Tool calls, approvals and connection access are unchanged.

Workflow Artifact views never get libraries.

## Sizes and hosts

React, React DOM and the MCP Apps client already make a built App about
560 KiB. Measured with the pinned versions:

| App | Compiled HTML |
|---|---|
| React only, or with icons or SVG | ~560 KiB |
| With motion | ~690 KiB |
| With a recharts line chart | ~935 KiB |
| With a three scene and OrbitControls | ~1.1 MiB |

Builds take 50–500 ms. Apps with libraries may compile to 1536 KiB of HTML and
store 2 MiB of revision plus source; others keep 768 KiB and 1 MiB. Desktop
hosts before this change read at most 768 KiB, so an App with charts or 3D
opens only in an updated OpenWork. Enterprise MCP transport keeps its separate
2 MiB resource-result limit.

## How to try it

1. Deploy a den-api with this change and use an updated OpenWork desktop.
2. Ask for an App with a chart or a 3D view. `prepare_app`'s `nextSteps`
   lists the libraries and how to use each one.
3. A failed build names the import to change, such as a package outside the
   catalogue or `import * as Icons from "lucide-react"`.

## Availability

Generally available. The rollout flag is retired; organization/member overrides,
operator locks and old kill-switch rows no longer disable this behavior.
Authorization, provider setup, consent and runtime compatibility still apply.

## What to watch

Compile failures and compiled sizes, build-worker timeouts, and App runtime
diagnostics (`react-render`, WebGL setup). A device without WebGL should show
the App's fallback, not a blank canvas.
