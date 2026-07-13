# packaged-suggestion-icon — Suggestion card icon loads in a packaged Electron build

In packaged Electron builds the renderer is loaded via `file://`, and Vite
emits relative asset paths (`base: "./"`). A hardcoded absolute `src` like
`/openwork-mark.svg` bypasses Vite's asset rebasing, resolves to the filesystem
root under `file://`, and silently 404s — so the Browse the web suggestion card
showed no icon. The fix routes the path through `resolveExtensionIconSrc`,
which prepends `import.meta.env.BASE_URL`, producing a relative `./openwork-mark.svg`
that resolves correctly next to index.html.

1. I launch the packaged Electron app and land on the session empty state. The three suggestion cards are visible — Edit a CSV, Browse the web, Connect an extension. The Browse the web card's icon image has loaded with non-zero natural dimensions, confirming the SVG resolved under the file:// protocol.

2. I confirm the icon src is a relative path — ./openwork-mark.svg — rebased by the resolveExtensionIconSrc helper, not a bare absolute /openwork-mark.svg that would break under file://.
