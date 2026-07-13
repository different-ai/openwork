# `@openwork/markdown`

## Purpose

This package owns OpenWork's safe, presentation-aware Markdown renderer. It
keeps the conversation and document-preview presentations intentional while
sharing URL policy, escaping, emoji, tables, images, fenced-code behavior, and
syntax-highlighting fallbacks through one tested kernel.

## Supported realms

The package is browser-capable. The root `@openwork/markdown` entrypoint is a
headless kernel and does not access DOM globals at import or render time. The
`@openwork/markdown/browser` and `@openwork/markdown/text-highlights` subpaths
require a browser DOM. The schema-v1 package declaration therefore records the
narrowest overall realm as `browser`.

## Authority

The headless kernel has no ambient authority. Callers inject HTML sanitization,
supported-language detection, and code highlighting. The default browser
adapter supplies DOMPurify and Shiki, but it does not open links, resolve files,
read app state, navigate, fetch, persist, or mutate the document at import time.
Those effects remain in host wrappers.

## Public exports

- `@openwork/markdown` exports `createMarkdownRenderingKernel` and its explicit
  rendering, presentation, highlighting, and port contracts.
- `@openwork/markdown/browser` exports the precomposed
  `browserMarkdownRenderingKernel` using DOMPurify and Shiki.
- `@openwork/markdown/text-highlights` exports browser text-search highlighting
  helpers and `SEARCH_HIGHLIGHT_SELECTOR`.
- `@openwork/markdown/styles.css` is the Tailwind v4 source-registration asset.
  Import it once in the host stylesheet so every class emitted as rendered HTML
  is retained in production CSS.

```ts
import { browserMarkdownRenderingKernel } from "@openwork/markdown/browser"

const html = await browserMarkdownRenderingKernel.renderHighlighted(
  "```ts\nconst answer = 42\n```",
  "conversation",
)
```

```css
@import "@openwork/markdown/styles.css";
```

## Consumers

- The legacy and React session surfaces use the browser renderer.
- The artifact document-preview surface uses the same renderer with its
  stricter raw-HTML presentation contract.
- Both app search paths use the package-owned text-highlight behavior.
- Packed-consumer proof imports every JavaScript entrypoint from the tarball.

## Boundaries

This package does not own React, routing, open-target resolution, link-action
menus, external navigation, image-preview event wiring, streaming state, or app
theme tokens. Host wrappers own those concerns and pass rendered content into
their existing interaction surfaces. The browser adapter's sanitizer is a
security boundary; widening its allowed attributes requires focused adversarial
tests.

The package deliberately exposes no source wildcards. Presentation variants
are a closed contract, and the generated class vocabulary is made portable by
the explicit stylesheet export instead of incidental monorepo scanning.

## Stability

Internal and experimental. URL safety, raw-HTML handling, sanitization,
highlight trust, fallbacks, generated classes, and both existing host surfaces
are characterized before any public release decision.
