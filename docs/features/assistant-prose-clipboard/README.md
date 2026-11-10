# Portable reply copying

- **Feature:** `assistantProseClipboard`
- **Deployments:** cloud and self-hosted, **off by default**
- **Owner:** `yomgui`

## Goal

Preserve document structure and readable content when reply text moves between applications. The destination owns its normal typography. This is not a promise of pixel-identical spacing or a blank line of a particular height in every editor.

The clipboard contains clean semantic HTML plus readable plain text. There are **no generated empty paragraphs, margin resets, source-app fonts/colors, layout classes or destination-specific spacing rules**. Real headings remain headings; real quotes remain blockquotes. A destination may map unsupported structures to its own supported formatting.

## Selected-copy scope

Only assistant prose contributes. Tool/reasoning UI, inputs, user messages and the composer retain native selection-copy behavior. Trusted React-owned prose boundaries prevent nested/raw HTML from declaring activity to be prose. Missing/unreachable feature state is off. The flag can be turned off using existing feature controls; conversations and already-copied data are not migrated or rewritten.

## HTML and plain text

Supported HTML includes paragraphs, `h1`–`h6`, ordered/unordered lists, emphasis/strike, links, blockquotes, rules, literal code/pre and simple tables. The serializer reconstructs supported selected DOM; it does not export computed page markup. Search highlighting retains its text; decorative favicons, GitHub glyphs and renderer copy/open controls are omitted.

Plain text uses blank lines between blocks, list markers/source numbering, useful link destinations, quoted text, literal code whitespace and tab-separated table cells. This is readable text, not a second Markdown-source converter.

HTTP/HTTPS/mailto/tel destinations remain links. Invalid/unsupported schemes degrade locally to their selected label. A local file link becomes `label (<code>path</code>)`; a matching filename/path label reduces to `<code>path</code>`. The destination is exactly the Markdown-written path, never a contextual absolute-path expansion. Inline code also keeps its written text, not resolved metadata.

## Conservative fallback

Flag off, missing clipboard data, empty/multiple/outside selections, unsupported content or errors retain native copy without cancellation. Both complete clipboard formats must be built/written before cancellation.

Math, content images/diagrams, task checkboxes, mentions/session references and partial/spanning tables remain native rather than silently losing meaning. An image-only prose group is not treated as empty. Hidden roots/ancestors, invalid structure, reversed/nondecimal lists and descendant-only nested-list selections that would invent empty parent items remain native. Simple tables require enclosing DOM boundaries.

## Verification and compatibility

Focused serializer/React tests check structure, selection boundaries, supported content, written paths, presentation stripping and safe fallback. Source/browser/native-clipboard evidence is distinct from destination-paste evidence.

See [the compatibility checklist](compatibility.md). Slack, Teams, Gmail, Outlook, Google Docs, Word, Notion and Apple Notes must be tested explicitly before broad compatibility is claimed. Unavailable destinations are **untested**, not passed. Keep this feature off and these PRs draft while that matrix is incomplete.

## Superseded experiments

Earlier Slack experiments used artificial one/two-empty-paragraph spacing and heading/quote downgrades. Those are not the portable default. Their live outcomes do not validate this semantic candidate. Earlier positive gap claims were retracted: the A/D comparison showed the prior output had the compact stored boundary, while the two-separator experiment matched D. That importer-specific result is historical evidence, not the cross-application acceptance target.

Do not log real clipboard contents or add a global copy listener for diagnostics. No merge, release, real-organisation rollout or task-Done acceptance is authorized by this document.
