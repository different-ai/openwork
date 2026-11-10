# Portable selected-reply copying

- **Feature:** `assistantProseClipboard`
- **Deployments:** cloud and self-hosted, **off by default**
- **Owner:** `yomgui`

## What changes

When enabled, copying a supported selection inside one assistant-prose region supplies semantic HTML and readable plain text instead of the browser's styled DOM fragment. The selected range is read from the original semantic nodes. App classes, colors, fonts, private attributes and decorative link favicons are not exported.

Only assistant text mounts the listener. User messages, reasoning/tool output, the composer and input controls retain native copying. Message Copy buttons and code-copy buttons are unchanged. There is no new control or rendered layout change (DESIGN.md P5/P11). This is a clipboard behavior rollout, not a new visual surface.

The shared desktop feature resolver handles active-member organization state and signed-out deployment state. Missing/unreachable state is off. A successful intercepted copy records only the existing feature-usage key, never clipboard content.

## Block spacing is structural

Supported HTML is rebuilt as `p`, `ul`/`ol`/`li`, `strong`, `em`, `a href`, `code`/`pre`, `br` and simple table elements. Blocks have only `style="margin:0"`. Exactly one `<p style="margin:0"><br></p>` separates top-level blocks. No separators are inserted inside lists or table rows.

This is intentional: clean HTML without spacing loses paragraph gaps in layout-heuristic importers, including the reported Quill-based paste path. Neither logical nor physical margins alone is a reliable solution. The internal baseline simulation predicts the structural form preserves the desired paragraph/list boundaries, but this is **not a cross-application guarantee**.

Text uses blank lines between top-level blocks, list markers/numbers with one item per line, literal code whitespace, tab-separated table cells and `label (url)` links. Bare-URL labels aren't repeated. This is readable text, not a Markdown-source export.

## Safe native fallback

The browser remains responsible when the flag is off, no clipboard data is available, the range is empty/multiple, or any selected endpoint leaves this prose region. Unsupported/atomic nodes, math, mentions/session references, content images, unsupported raw elements and partial/spanning table cells fall back rather than silently lose meaning. Headings and blockquotes currently retain native copying; they aren't coerced to paragraphs.

Ordinary partial inline text/link selections and supported list selections are handled. Descendant-only nested-list selections that would invent an empty ancestor item stay native. Reversed/nondecimal ordered lists and ambiguous or invalid block/inline structures stay native rather than change meaning. Text-bearing `div` blocks preserve paragraph boundaries; renderer wrappers around supported blocks are transparent. Simple tables require a range enclosing their DOM contents: selecting from the first cell's text to the last cell's text still falls back, even if it looks complete. Renderer code-block toolbars are excluded while selected code is retained. Failures or moving ranges return to native copy without cancellation. Both complete formats are constructed before writing, and `preventDefault()` is called only after both writes succeed.

## How to try it

Enable the feature only in an approved test organization/member using the existing feature controls. Select supported assistant text containing paragraphs, a list, emphasis and a web link, then copy and paste into a destination. Verify the list-to-paragraph gap, other block gaps, text fallback, emphasis and actual link destination. Test source selection and destination mode explicitly.

Turning the feature off removes the listener on the next feature-state refresh. Existing selections, stored conversations and already copied data aren't rewritten. Native copy resumes; there is no migration or persistent document-format change.

## Evidence and limits

Validation for the draft PR (2026-11-09 America/New_York):

- `bun test apps/app/tests/assistant-prose-clipboard.test.tsx`: **45 pass**, 93 assertions. Includes semantic export, structural boundaries, lists, links, code, tables, partial ranges, multiple ranges, flag gating, malformed structure and native fallback. React event tests in this file are synthetic, not real keyboard proof.
- Separate local Playwright proof bundled the actual `AssistantProse` React component with esbuild and ran **trusted `Meta+C`** events in Chromium headless shell 156.0.8078.4. The supported paragraph/list/paragraph selection wrote both formats with exactly two separators, emphasis and an actual link. Partial link selection after composer focus and partial code selection passed. Flag off, outside-root text, textarea, cross-root and unsupported-heading copies were not cancelled. This was a component harness, not an authenticated full-app or destination paste test. The owned process arguments were verified: private profile/HOME/XDG, `--use-mock-keychain` and `--password-store=basic`; the browser was closed and its private directory removed.
- `pnpm --filter @openwork/app typecheck`, `pnpm --filter @openwork/features test` (**26 pass**) and `pnpm features:check`: passed.
- `pnpm check:ui-guardrails`: fails with **23 pre-existing findings** outside these changes. Running the same checker on an archive of base `062414c844c22e3bbb632a5a0f05665bace78a71` produced byte-identical stdout/stderr (23 findings, 411 baseline occurrences). No baseline waiver was added.

No new live Slack paste test was performed for this implementation. Gmail, Google Docs and Notion remain **untested**; earlier Quill/Slack mechanism experiments are motivation, not acceptance of this implementation. No rollout, merge or release is authorized by this document.

Watch for unexpected native fallbacks, selection-boundary mistakes, duplicated separators and changed emphasis/link destinations. Do not log clipboard payloads or enable a global copy listener to diagnose them.
