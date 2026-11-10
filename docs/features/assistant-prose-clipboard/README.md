# Portable selected-reply copying

- **Feature:** `assistantProseClipboard`
- **Deployments:** cloud and self-hosted, **off by default**
- **Owner:** `yomgui`

## Behavior and scope

When enabled, selected assistant text supplies semantic HTML and readable plain text instead of browser-styled markup. A single listener covers an assistant message. Only its React-owned direct prose groups contribute: a selection from prose through tool/reasoning activity to later prose omits that activity. Nested markup cannot declare more prose groups. Endpoints in activity, another message, inputs or the composer retain native copying. User messages and message/code Copy buttons are unchanged. No rendered layout or new control changes (DESIGN.md P5/P11).

The existing feature resolver reads organization/member or signed-out deployment state. Missing/unreachable state is off. Successful copies record only the existing feature-usage key, never clipboard contents.

## Portable content

The serializer rebuilds paragraphs, lists, emphasis, strike, safe links, literal code/pre, blockquotes and simple tables. App classes, fonts, colors, private attributes and decorative favicons/GitHub glyphs are omitted; search highlights retain their words without highlight markup.

- `h1`–`h6` become bold paragraphs; Slack has no heading format.
- `hr` becomes a structural boundary, coalesced with the normal boundary between blocks.
- `del` becomes `s`; blockquotes retain semantic `blockquote` markup.
- Local file chips retain their selected label without the icon or Open with control. Inline code paths remain `code`.
- HTTP/HTTPS/mailto/tel destinations remain links. Missing, invalid, local or other-scheme destinations degrade only that link to its selected label; surrounding content still copies.

Blocks use only `style="margin:0"`. Exactly one `<p style="margin:0"><br></p>` separates top-level blocks. No separators are inserted inside lists or table rows. This avoids relying on margins/layout guesses in Quill-like importers; it is not a universal cross-application guarantee.

Plain text has blank lines between blocks, list markers/source numbering, literal code whitespace, tab-separated table cells, quoted lines and `label (url)` links. Bare-URL labels are not repeated. This is readable text, not a Markdown-source export.

## Native fallback

Off, missing clipboard data, empty/multiple/outside ranges, errors or failed writes retain native behavior. Both formats are built and written before `preventDefault()`.

Genuinely unsupported selected prose remains native rather than silently dropping it: math, images, diagrams, task checkboxes, mentions/session references and partial/spanning tables. An image-only prose group is not treated as empty. Hidden roots/ancestors are rejected. Ambiguous structures, reversed/nondecimal lists and descendant-only nested-list selections that would invent an empty parent marker also remain native. Simple tables require enclosing DOM boundaries; visually selecting first-to-last cell text alone falls back.

## Try and roll back

Use existing feature controls only in an approved test scope. Select paragraphs, a list, headings, a local file chip, emphasis and a web link. Check every paragraph gap (especially list → Expected), formatting, destinations and plain-text paste. Include a prose → tool → prose selection.

Turning the feature off removes interception on the next state refresh. Stored conversations and existing clipboard data are not rewritten; there is no migration. Keep the flag off until intentional rollout approval.

## Verification

- `bun test apps/app/tests/assistant-prose-clipboard.test.tsx`: unit/DOM/React coverage includes actual Markdown rendering plus GitHub/search decoration, conversions, grouped selection boundaries, forged markers, image-only groups and native fallback. Synthetic React events alone are not keyboard proof.
- Separate isolated headless-shell proof uses trusted Meta+C through the actual grouped React component on the captured reply and heading/file/quote variant. Generated payloads and local Quill imports check gaps, italics, links, code and blockquotes. The private browser uses verified mock-keychain/basic-password-store flags and private HOME/XDG/profile; no normal account browser is used.
- Run app typecheck, feature tests and `features:check` on the rebased head. Results, live paste receipts and unrelated CI findings are recorded with the review evidence, not interpreted as compatibility guarantees.

Live self-DM validation (2026-11-09) is **not green**: the [captured reply](https://differentai.slack.com/archives/D0BSDT6QZLJ/p1794281028266079) retained italic/link formatting but its readback has no explicit blank line before Expected. The [heading/file/quote variant](https://differentai.slack.com/archives/D0BSDT6QZLJ/p1794281053425259) retained paragraph gaps and file labels, but read back as plain text without rich emphasis/linked labels. This conflicts with the passing local Quill import; the cause is not established. Native screenshot verification was unavailable, so do not infer pixel-layout acceptance from API text.

Gmail, Google Docs and Notion are untested. No merge, release or rollout is authorized by this document. Do not log real clipboard contents or introduce a global copy listener for diagnostics.
