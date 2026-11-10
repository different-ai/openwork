# Portable selected-reply copying

- **Feature:** `assistantProseClipboard`
- **Deployments:** cloud and self-hosted, **off by default**
- **Owner:** `yomgui`

## Behavior and scope

When enabled, selected assistant text supplies semantic HTML and readable plain text instead of browser-styled markup. A single listener covers an assistant message. Only its React-owned direct prose groups contribute: a selection from prose through tool/reasoning activity to later prose omits that activity. Nested markup cannot declare more prose groups. Endpoints in activity, another message, inputs or the composer retain native copying. User messages and message/code Copy buttons are unchanged. No rendered layout or new control changes (DESIGN.md P5/P11).

The existing feature resolver reads organization/member or signed-out deployment state. Missing/unreachable state is off. Successful copies record only the existing feature-usage key, never clipboard contents.

## Portable content

The serializer rebuilds paragraphs, lists, emphasis, strike, safe links, literal code/pre and simple tables. App classes, fonts, colors, private attributes and decorative favicons/GitHub glyphs are omitted; search highlights retain their words without highlight markup.

- `h1`–`h6` become bold paragraphs; Slack has no heading format.
- `hr` becomes a structural boundary, coalesced with the normal boundary between blocks.
- `del` becomes `s`. Blockquotes become plain paragraphs, preserving their inline formatting and block boundaries: the semantic quote variant lost rich formatting in the live Slack check, while the paragraph control retained it.
- Local file chips retain their selected label plus their Markdown-written path as `label (<code>path</code>)`, without the icon or Open with control. When the label equals the file name or path, only `<code>path</code>` is emitted. Relative paths are never expanded to absolute machine paths. Inline code retains the written path, not resolved metadata.
- HTTP/HTTPS/mailto/tel destinations remain links. Missing, invalid or other-scheme destinations degrade only that link to its selected label; local file destinations retain the literal source path as described above.

Blocks use only `style="margin:0"`. Two `<p style="margin:0"><br></p>` separators follow a top-level `ul`/`ol` before the next block; other top-level boundaries use one. No separators are inserted inside lists or table rows, and no trailing separator is added. Plain text still uses one blank line between blocks. This avoids relying on margins/layout guesses in Quill-like importers; it is not a universal cross-application guarantee.

Plain text has blank lines between blocks, list markers/source numbering, literal code whitespace, tab-separated table cells, quote text as paragraphs and `label (url)` links. Bare-URL labels are not repeated. This is readable text, not a Markdown-source export.

## Native fallback

Off, missing clipboard data, empty/multiple/outside ranges, errors or failed writes retain native behavior. Both formats are built and written before `preventDefault()`.

Genuinely unsupported selected prose remains native rather than silently dropping it: math, images, diagrams, task checkboxes, mentions/session references and partial/spanning tables. An image-only prose group is not treated as empty. Hidden roots/ancestors are rejected. Ambiguous structures, reversed/nondecimal lists and descendant-only nested-list selections that would invent an empty parent marker also remain native. Simple tables require enclosing DOM boundaries; visually selecting first-to-last cell text alone falls back.

## Try and roll back

Use existing feature controls only in an approved test scope. Select paragraphs, a list, headings, a local file chip, emphasis and a web link. Check every paragraph gap (especially list → Expected), formatting, destinations and plain-text paste. Include a prose → tool → prose selection.

Turning the feature off removes interception on the next state refresh. Stored conversations and existing clipboard data are not rewritten; there is no migration. Keep the flag off until intentional rollout approval.

## Verification

- `bun test apps/app/tests/assistant-prose-clipboard.test.tsx`: unit/DOM/React coverage includes actual Markdown rendering plus GitHub/search decoration, conversions, grouped selection boundaries, forged markers, image-only groups and native fallback. Synthetic React events alone are not keyboard proof.
- Separate isolated headless-shell proof uses trusted Meta+C through the actual grouped React component on the captured reply and heading/file/quote variant. Generated payloads and local Quill imports check gaps, italics, links, code and flattened quote content. The private browser uses verified mock-keychain/basic-password-store flags and private HOME/XDG/profile; no normal account browser is used.
- Run app typecheck, feature tests and `features:check` on the rebased head. Results, live paste receipts and unrelated CI findings are recorded with the review evidence, not interpreted as compatibility guarantees.

Correction (2026-11-10): earlier gap-success claims for REVIEW-A and the real-app button/menu samples are retracted. Guillaume's comparison identifies them with the broken baseline A. Slack MCP readback **does distinguish this gap**: visually gapped D stores `menu.\n\n*Expected:*`; A, REVIEW-A, REAL-BUTTON and REAL-MENU store `menu.\n*Expected:*`. The prior claim that API text cannot show this gap was wrong. `delta-cmp-output.txt` shows the two-separator candidate has two empty lines after the list in Quill, matching D; the one-separator candidate has only one, which Slack absorbs. The revised candidate is not accepted until the reference reply is checked first in MCP readback and then visually. A menu paste is gated on that button result. Prior formatting-only observations do not establish a fixed paragraph gap.

Gmail, Google Docs and Notion are untested. No merge, release or rollout is authorized by this document. Do not log real clipboard contents or introduce a global copy listener for diagnostics.
