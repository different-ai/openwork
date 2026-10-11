# Analytics integration

The `library-usage`, `workflow-run-previews`, and `org-model-analytics`
journeys compare the existing presentation with `analyticsIntegrated` on.
The Library journey also records Members and Connectors in the same workspace.

## Mismatches

- Members uses an ink underline; Analytics selected a purple tab.
- Analytics had a wider content inset than Members and Connectors.
- Analytics statistics used violet, blue, green and amber icon tiles for
  ordinary counts, including unused items. These competed with actual failures.
- Usage plugin rows used a letter even when the name identified a known brand.
  Custom names still need a letter, not an invented service logo.
- Usage rows had their own typography rather than the shared Den `ItemRow`.
  Numeric comparison headers are useful and are retained.
- Workflow history repeated a full diagram in every card, while management
  lists use compact rows. Executed-version previews can be opened in place.
- Models and workflow first loads used loading prose rather than the Den row
  skeleton; their errors did not offer the same inline retry pattern.

## Scope and rollback

`analyticsIntegrated` starts off on cloud and self-hosted. It changes
presentation only: no counts, collection, consent, entitlements, permissions,
API queries, or persisted history change. Turning it off restores the original
views immediately. Rows keep their existing Library/Connectors destinations;
one-off or inaccessible workflow receipts do not acquire fabricated links.

`denFlatPageHeaders` still exclusively controls compact versus legacy headings.
This rollout does not replace that check, remove descriptions, or redesign
Members/Connectors headers. Both header settings can be combined independently.

The proof includes named plugin/connector marks, custom fallback, row-to-detail
navigation, narrow comparison scrolling, teammate refusal, and rollback with
unchanged counts. The model journey retains its cross-organization and outage
checks. The workflow journey retains executed-version and revoked-access checks.

## Advisory review decisions

- Flag-off accent tiles, letter marks and expanded diagrams are the required
  before evidence, not the integrated presentation.
- Members, Connectors, member download entry points, pricing actions and
  shared Library diagrams are comparison/detail destinations. Their existing
  policy, copy and diagram styling are not redesigned by this rollout.
- Counting dates and measurement periods report state; they are not interface
  explanations. Chart dates belong at opposite ends of the time axis, not in
  adjacent list columns. Model dimension labels in the collection fixture are
  synthetic telemetry input, not exposed resource identifiers.
- Numeric comparison columns remain intact. At phone width their scroll stays
  inside the table; the page and controls do not widen. This preserves the
  existing comparison contract rather than omitting counts.
- The repeated Members email measurement quotes one identity twice; the
  captured pixels show one line per person. Next's local development indicators
  are not shipped controls and do not justify altering the product chrome.
- Recovery screenshots have their own after caption: a restored, populated
  report is not an outage or a fabricated zero report.

The integrated error state now has one recovery action and no explanatory
paragraph. Normal model sections keep their measured period but drop UI
explainers. Shared diagram typography remains a separate follow-up.

Design: P5, P10, P11, S2, S3, C5, C6, V2, V5.
