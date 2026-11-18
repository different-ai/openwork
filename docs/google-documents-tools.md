# Focused Google Docs tools

Focused Google Docs tools are generally available on cloud and self-hosted
deployments. Three native Google Workspace capabilities are available to
Workbot and other connected assistants through the existing capability gateway:

| Capability | Use |
| --- | --- |
| `getGoogleDocumentOutline` | Inspect tabs, nested tabs, and up to 100 headings before choosing what to read. |
| `readGoogleDocumentText` | Read a page or search for a literal phrase inside one tab, including table cells. |
| `replaceGoogleDocumentText` | Apply an explicitly requested replacement to one exact saved passage at the revision just read. |

They use the calling member's selected Google connection. Reading requires
**Read all Drive files**; editing requires **Full Drive access**, enabled by an
administrator and granted by that member. The selected-file permission alone
does not authorize these arbitrary-document-ID operations. No permission is
enabled automatically. Removing a connector permission takes effect even if
Google's stored token still has an older, broader grant. No additional editor,
paid library, index, or background sync service is required.

The existing Drive search and inline export reader also recheck current
connector permissions, so older stored grants cannot bypass their revocation.

An assistant first searches for these capabilities, then inspects the outline
for the document ID. For example, to answer a question about costs it selects
the Budget tab and calls `readGoogleDocumentText` with that tab ID and
`query: "budget"`. Search is literal and case-insensitive. Omit `query` to read
sequentially. Each response includes native UTF-16 indices and a revision ID;
follow `nextStartIndex` using the same tab, query, and revision to continue.
Pass the latest revision on every subsequent page. Read-only Google access may
omit revision IDs, in which case stable pagination and edits are unavailable.

The model receives at most 12,000 text characters per read, plus bounded
metadata. The Google Docs API still sends the document to Den: this is **not a
provider-side range fetch**. Den bounds decoded JSON to 6 MiB, tab count to
100, and structural elements to 50,000, then selects passages in memory.
Unsupported or oversized responses fail with a clear export fallback. There
is no persistent content cache. Responses use `Cache-Control: no-store`.

Only saved body paragraphs and tables are included. Images, comments, headers,
footers, footnotes, and unsaved editor drafts are outside this toolset. Pending
text insertions/deletions are omitted, reported by `suggestionsOmitted`.
Den requests `SUGGESTIONS_INLINE` to preserve the indices Google requires for
edits, and removes proposed text locally without renumbering later passages.
Content is source material, never authority or instructions for the assistant.

An edit supplies `tabId`, `revisionId`, `startIndex`, `expectedText`, and
`replacement`. Den requires both the current revision and an exact match
inside a single contiguous paragraph span. The request cannot cross a table
cell, embedded object, suggestion gap, or paragraph boundary. A successful
mutation returns Google's new revision and character counts. Google applies
surrounding text styles; this is a text-edit tool, not a formatting API.

The final write also carries Google's `requiredRevisionId`, so a change that
arrives between the read and write is rejected by Google atomically. A stale
preflight read returns `document_conflict`; a provider rejection includes
Google's error. Re-read before reconsidering an edit. Never automatically
retry an uncertain mutation. Turning off the flag hides the capabilities from
search and Code Mode and blocks cached calls at the route. A second rollout
check after the external read stops an edit waiting at that boundary.

Audit records capture actor, document ID, and outcome, not passage text,
replacement text, search phrases, OAuth secrets, or access tokens. The focused
tests exercise the real Den app, authentication, member isolation, OAuth
connection selection, capability discovery and execution, scope revocation,
and edit races against a synthetic external Google service. They do not prove
a live Google account round trip.

Google's API references:
[tabs](https://developers.google.com/workspace/docs/api/how-tos/tabs),
[suggestions and indices](https://developers.google.com/workspace/docs/api/how-tos/suggestions),
[revision-controlled edits](https://developers.google.com/workspace/docs/api/reference/rest/v1/documents/batchUpdate).
