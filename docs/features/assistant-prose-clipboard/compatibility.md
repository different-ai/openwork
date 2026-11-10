# Portable clipboard compatibility checklist

## Acceptance target

Content and document structure, not identical pixels. Paragraphs must not become list items or run together, list order and nesting must remain understandable, and supported emphasis/links/code/tables must survive without source-app styling or accidental HTML/Markdown punctuation. Unsupported destination features may degrade to readable content; record those differences explicitly. Do not inject empty paragraphs to tune one importer.

The destination's native paragraph/heading typography is the visual reference. Butterick's [space-between-paragraphs guidance](https://practicaltypography.com/space-between-paragraphs.html) is a sanity check for an owned layout, not a clipboard encoding rule. HTML [paragraphs](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/p) and [line breaks](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/br) have different semantics.

## Common fixture

Use the same source for every destination:

- Normal paragraph → two-item unordered list → **Expected:** paragraph → another paragraph.
- An ordered list with non-default start and a nested item.
- A real heading, blockquote and horizontal rule.
- Bold, italic, strike and a labelled HTTPS link.
- Literal inline/fenced code; a simple whole table in a separate case if the destination lacks tables.
- A file link with a distinct label and relative path, plus a filename-matching label. Keep authored paths; never expand a relative path to a machine-specific absolute path.

The visual fixture uses only one file-path example per line; no redundant “Inline path” sentence. Inline-code semantics remain covered by a separate code example and focused tests.

## Source routes

1. Select the whole rendered reply and use Cmd/Ctrl+C.
2. Click the real reply Copy button.
3. Click the real reply-menu Copy item.
4. Compare both HTML/plain payloads. Button/menu must match selected copy for the supported whole reply.
5. Try flag off, missing/unrendered/stale prose, unsupported content and rejected/unavailable rich-write APIs; require the exact existing Markdown fallback for message actions.
6. Verify no artificial empty paragraphs, styles, classes, private attributes or decorative images. Confirm real h1–h6/blockquote/hr tags rather than application-specific substitutes.

## Destination matrix — current semantic candidate

| Destination | Rich paste | Plain-text paste | Status / evidence |
| --- | --- | --- | --- |
| Slack rich composer | Not run | Not run | **Untested** for the semantic candidate. Prior one/two-separator experiments are superseded. |
| Microsoft Teams composer | Not run | Not run | **Untested**; no provider/account access assumed. |
| Gmail compose | Not run | Not run | **Untested**; no draft created or message sent. |
| Outlook compose | Not run | Not run | **Untested**; no draft created or message sent. |
| Google Docs | Not run | Not run | **Untested**; no document created/edited. |
| Microsoft Word | Not run | Not run | **Untested**; no document created/edited. |
| Notion | Not run | Not run | **Untested**; no page created/edited. |
| Apple Notes | Not run | Not run | **Untested**; no note created/edited. |

Passing serializer tests, a browser contenteditable round-trip or Quill simulation is **not** a pass for any row above. A successful write to the native clipboard is source evidence only, not a destination verdict.

## Record each run

Record source commit, local flag scope, application/version/platform, exact copy route, rich/plain paste mode, a destination screenshot or retained unsent/local document, supported-feature differences and any fallback. Keep the same content and viewport/zoom when comparing.

- **Passed:** observed content/structure and formatting meet the target.
- **Failed:** observed content loss, wrong structure or unacceptable formatting.
- **Untested:** not exercised or unavailable. State the missing access/application instead of inferring success.
- **Blocked:** attempted, but a specific permission/technical barrier prevented a verdict.

Use local or unsent documents where possible. No external recipients, channels or people; no sign-in/setup, sending or sharing is implied by this checklist. Previously authorised Slack checks remain confined to Guillaume's self-DM. Obtain appropriate scope before changing other connected-service data.

The feature remains default off; this checklist must not be described as a completed compatibility matrix.
