# Third-party notices

## Flue (hero prompt block glyphs and feedback pattern)

`components/landing-hero-prompt.tsx` includes elements ported from Flue:

- Source: https://github.com/withastro/flue
  (`apps/www/src/pages/index.astro`, `apps/www/src/styles/global.css`)
- License: Apache License, Version 2.0 — https://www.apache.org/licenses/LICENSE-2.0

These are modified derivative works. Changes by OpenWork: ported the Astro
markup + inline script to a React component with state-driven feedback,
relabeled the prompt text and copied-feedback copy for OpenWork, moved the
interaction into the hero prompt block, and applied OpenWork's ink palette. The
four animated glyph SVGs and the `data-feedback` / `data-copy-error` feedback
states are reused from Flue; the squircle button shape is no longer used. The
original copyright and license are retained in the source file header per
Apache-2.0 §4.
