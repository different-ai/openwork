# Zoom into diagrams (`mermaidZoom`)

- **Feature key:** `mermaidZoom`
- **Deployments:** cloud and self-hosted (`everywhere`), off by default
- **Author:** @benjaminshafii

## What people get

Mermaid diagrams in chat messages and in Markdown or `.mmd` file previews can be
zoomed and panned, so wide or dense diagrams are readable.

- Hovering a rendered diagram (or focusing it) shows a small toolbar: zoom out,
  the current zoom (click to reset), zoom in, and open full screen. It stays
  visible while the diagram is zoomed, and always on touch screens.
- Cmd/Ctrl+scroll and trackpad pinch zoom around the pointer. Plain scrolling
  still scrolls the conversation.
- Once zoomed, drag to pan. Double-click zooms in (Shift+double-click zooms out).
- Keyboard, with the diagram focused: `+` / `-` zoom, `0` resets, arrow keys pan.
- Full screen opens the diagram in a dialog fitted to the window. There plain
  scrolling pans too. `Esc` closes it and returns focus to the diagram.

The Rendered / Source / Download SVG controls are unchanged.

| Off (today) | On, zoomed and panned inline | On, full screen |
| --- | --- | --- |
| ![Off](off-inline.png) | ![Zoomed inline](on-inline-zoomed.png) | ![Full screen](on-fullscreen.png) |

## How it works

`useMermaidEnhancer` (`apps/app/src/components/markdown/mermaid.ts`) still
renders and sanitizes every diagram. With the feature on it puts the sanitized
SVG in a React-owned slot (`data-openwork-mermaid-interactive`) and
`MermaidZoomPortals` mounts `MermaidZoomViewport` there. The zoom math lives in
`mermaid-zoom.ts` and is covered by `apps/app/tests/mermaid-zoom.test.ts`.
`MermaidZoomFeatureProvider` resolves the feature once for the app through
`useDesktopFeature("mermaidZoom")`.

## Turning it off

The kill switch, or the feature being unreachable, brings back the static
diagram on the next render. Nothing is stored. Zoom state lives only in memory
for the current view.

## Try it

`pnpm world up dev-app-web --detach -- --browser`, then turn the feature on for
your organization in `/admin`. Signed out, the app reads `GET /v1/features` from
the Den it points at. Ask for a large flowchart, or open an `.mmd` file.
