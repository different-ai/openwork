# Built-in libraries in Apps

- Feature: `mcpAppLibraries`
- Deployments: cloud and self-hosted
- Author: `reachjalil`
- Default: off

## What changes

Apps built in OpenWork normally get injected React and nothing else. With this
feature on, the editor's Apps may also use a small set of libraries:

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
2. A platform administrator turns on **Apps: built-in libraries** for a member
   or organization in /admin.
3. Ask for an App with a chart or a 3D view. `prepare_app`'s `nextSteps` now
   lists the libraries and how to use each one. Without the feature, it says
   nothing new, and an import that names a library fails with "built-in
   libraries are not on for you".
4. A failed build names the import to change, such as a package outside the
   catalogue or `import * as Icons from "lucide-react"`.

## Turning it off

New builds and updates that import a library are refused. A refused build
publishes nothing, so the last working revision stays. Revisions already
published with a library keep opening: this is a publishing rollout, not a
way to revoke JavaScript that was already served.

The builder reads the feature for the editor on every create and update.
Preparation output and App source cannot turn it on.

## What to watch

Compile failures and compiled sizes, build-worker timeouts, and App runtime
diagnostics (`react-render`, WebGL setup). A device without WebGL should show
the App's fallback, not a blank canvas.
