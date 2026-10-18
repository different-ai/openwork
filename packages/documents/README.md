# Connected documents

`@openwork/documents` is a reusable document workspace. Workbot supplies its
signed-in transport and identity; other hosts can use the same browser and
provider/editor contracts without embedding Workbot.

## Documents workspace

- Recent files from Drive API v3, ordered by `recency desc`, excluding folders.
  The sidebar is not a fabricated list or local browsing history.
- My Drive and folder breadcrumbs, folder-scoped search, pagination,
  list/grid views and name/date sorting of loaded files.
- Files open in internal tabs with close buttons and an unsaved-change dot. Switching or reordering tabs retains unsaved edits; closing an edited tab offers save, keep editing, or discard. Drag tabs to reorder, or focus a tab and use Alt+Shift+Left/Right. Delete closes the focused tab. The Files tab stays fixed.
  Closing a dirty file or leaving Documents asks whether to keep/discard edits.
  Page unload uses the browser's unsaved-changes protection.
- Missing/expired Drive access shows Connect/Reconnect through Den's existing
  connections page. Returning to the page rechecks the listing.
- A tab's identity is separate from its editing session's source and current
  saved resource. Confirmed Office copies are named and linked as copies; the
  Google original and its saved copy can be opened independently.
- Explicit Save to Drive writes to the current resource; no background Drive writes.

| File | Inline experience | Save path |
| --- | --- | --- |
| Word `.docx` | OpenWork formatting controls and a document canvas; page layout, tables, images, comments and find/replace remain available | Explicit Save to Drive updates the original Office file |
| Excel `.xlsx` | OpenWork formatting controls, formula bar and worksheets; the engine retains formulas, recalculation, charts, sorting/filtering | Explicit Save to Drive updates the original Office file |
| PowerPoint `.pptx` | Slide thumbnails, text/shapes, formatting, add/duplicate/delete, layouts, speaker notes and presentation mode | Explicit Save to Drive updates the original PowerPoint file |
| OpenDocument `.odt` / `.ods` / `.odp` | Full document, spreadsheet or presentation engine with the same OpenWork controls | Explicit Save to Drive updates the original OpenDocument file in its original format |
| Native Google Doc / Sheet / Slides | Exported Word / Excel / PowerPoint copy in the full editor, with a visible copy notice | First save creates an Office file in My Drive; later saves update that copy. The native original is preserved. Use Open original in Drive to edit it natively |
| UTF-8 text | Plain text editing, up to 1 MB | Explicit save to the original file |
| PDF and common raster images | Read-only inline preview | No edits |
| Other formats | Link to original editor | No edits |

The Office editor is a real, separately hosted engine, loaded only when an
Office tab opens. It is not bundled into chat or model context. It is not the
Microsoft Word/Excel product. Macro-enabled packages are refused, and the
service must run with macro execution disabled. No third-party plugins are
installed by the integration. Complex OOXML round trips can differ from desktop Office;
representative customer files need acceptance testing before rollout. Office
files retain the shared bounded ZIP protections (12 MB compressed, 10 MB inflated,
128 parts); signed, encrypted and macro-enabled packages are refused.
OpenDocument also verifies its MIME entry and scans bounded UTF-8 XML for
encryption, event scripts and DTDs before opening or staging a save. Legacy
binary Office formats are not accepted through this editing path. PDF/images
remain previews; text/CSV remain in the existing text editor.

Editor autosave synchronizes to the document service. Only **Save to Drive**
commits to Drive. WOPI writes stage snapshots and never write to Google. Unsaved indicators remain until Drive confirms the write. The explicit commit binds the exact staged draft version.

## Free and open-source editor

Documents integrates the **Collabora Online source engine**, primarily MPL-2.0,
with LibreOffice Writer, Calc and Impress underneath. The integration uses no
paid SDK, vendor license key or commercial-only import/export API. For a fully
open-source deployment, use upstream's documented `nobrand=yes` build or maintain
a source build with open-source branding, fonts and dependencies. The upstream
vendor's binary distribution and branding terms are separate from its source license; do not treat a free download
of `collabora/code` as proof of an unrestricted open-source production license.

The package and OpenWork integration assets are MIT. React, React DOM, Base UI,
TanStack Query, Zod and htmlparser2 are MIT; Lucide is ISC; parser dependencies
include BSD-2-Clause code. See [the dependency and engine license inventory](THIRD_PARTY_NOTICES.md).
The existing Workbot/Den server host remains subject to [OpenWork's EE license](../../ee/LICENSE).
Google Drive is an external service governed by Google's terms; it is not an
open-source dependency. Running the engine and storage requires infrastructure.

- [Editor source and MPL-2.0 license](https://github.com/CollaboraOnline/online/blob/main/COPYING)
- [Source mirror and build instructions](https://github.com/CollaboraOnline/online.mirror)
- [WOPI integration](https://sdk.collaboraonline.com/docs/advanced_integration.html)
- [PostMessage API](https://sdk.collaboraonline.com/docs/postmessage_api.html)

The integration calls the open WOPI protocol and does not depend on subscription-only
features. Upstream calls its `nobrand=yes` image build "100% open source";
see [the upstream Docker instructions](https://github.com/CollaboraOnline/online.mirror/blob/eaa2d031909488c7b9600c85c247ec05a3bd10f6/docker/README).
Maintainers own security updates, operation and license notices.
Local acceptance also exercised the unbranded 25.04.12.4 engine: document text,
spreadsheet formulas/recalculation, presentation slide duplication, formatting
controls and correlated save round trips with synthetic Drive files. This does
not establish live Google Drive or production-deployment acceptance.

## OpenWork editing controls

The default surface has one compact React toolbar, the file tabs and save action,
and the document canvas. The stock ribbon, duplicate title, navigation, status
bar and side panels stay hidden. **More tools** reveals the engine's complete
controls on demand; it does not reopen the document or change its editing session.
The spreadsheet formula bar and worksheet tabs stay available in the compact view.

`DocumentToolbar`, `EditorToolbarButton` and `EditorToolbarMenu` compose over the
typed `EditorController` contract. They do not read an engine global or iframe DOM.
`collabora-controller.ts` translates bounded commands at the engine boundary and
validates selection events with Zod. The small TypeScript integration in
`collabora/branding.ts` owns the pinned engine's selection/layout integration;
it sends formatting state only, never document content, file bytes or credentials.
Both directions check the exact frame/parent window and configured WOPI host origin.
Menus and popovers use Base UI for keyboard behavior, focus and viewport collision
handling, and copy semantic theme tokens when portaling outside their host.

Build an unbranded base using upstream's recipe, then pin the resulting image by
digest in deployment. The recipe below is from the same 25.04 source revision as
the engine interface used for local editing checks; its package repository can
advance independently, so check installed versions and rerun acceptance after upgrades.

```sh
git clone --depth 1 --filter=blob:none --sparse --branch cp-25.04.6-2 \
  https://github.com/CollaboraOnline/online.mirror.git office-engine
git -C office-engine sparse-checkout set docker/from-packages
test "$(git -C office-engine rev-parse HEAD)" = eaa2d031909488c7b9600c85c247ec05a3bd10f6
docker build --build-arg nobrand=yes -t openwork-office-unbranded \
  office-engine/docker/from-packages
```

Alternatively use [upstream's source-build instructions](https://www.collaboraoffice.org/post/build-code/),
without proprietary branding, and package its runtime as a pinned internal image.
Either base must provide a shell, `dpkg-query`, `coolwsd`, a `cool` runtime user,
and the browser assets at
`/usr/share/coolwsd/browser/dist`. The integration was exercised against the
25.04.6.2.1 engine interface; a different engine build needs the same focused
editing, selection, save-receipt and layout acceptance checks.

Build the integrator theme and overlay from the repository root, explicitly
supplying the unbranded image:

```sh
pnpm --filter @openwork/documents build:collabora-theme
docker build -f packages/documents/collabora/Dockerfile \
  --build-arg DOCUMENTS_EDITOR_BASE_IMAGE=openwork-office-unbranded \
  -t openwork-documents-editor packages/documents/collabora
```

Run that image with the same WOPI allowlist, TLS, sandboxing, macro settings,
network policy and resource limits as the existing service. The image appends
the OpenWork integration beside Collabora's branding hooks and preserves its
notices and About screen. Customization applies only to frames launched with
`integrator=openwork`. The overlay rejects installed `code-brand` and
`collabora-online-brand` packages. Pin the base engine image by digest; upgrades
need the
focused editing/selection/layout checks again. A service without this integration
keeps its existing editing controls and reports that an admin needs to update it.

Configure Den, leaving `workbotDocuments` off until the service is ready:

```
DEN_DOCUMENTS_COLLABORA_URL=https://office.example.com
DEN_DOCUMENTS_HOST_ORIGIN=https://workbot.example.com
DEN_DOCUMENTS_CALLBACK_BASE_URL=https://api.example.com
DATABASE_REDIS_URL=rediss://<private shared Redis>
```

The callback origin defaults to `DEN_API_PUBLIC_URL`. All origins are operator
configuration, never a request Host header or file metadata. Collabora must reach
Den; browsers and Den must reach Collabora. The discovery action must use that
same editor origin. The browser POSTs a random, expiring, file-bound access token
into the editor iframe; it never receives Google credentials. PostMessage events
must match the exact iframe window and configured service origin.

WOPI reads, locks and writes independently recheck the pinned connection,
membership, both flags, connector grants and provider access. WOPI PutFile only
stages encrypted temporary bytes. It cannot upload to Google. Save to Drive asks
the editor to finish a snapshot, waits for its response and the matching WOPI
upload receipt (a bounded, per-save request ID), then explicitly commits
that exact draft version with the user's authenticated Workbot request. A newer
staged version rejects the commit instead of silently selecting different bytes.
The standard WOPI LOCK/REFRESH_LOCK/GET_LOCK/UNLOCK operations serialize editing.

Keep Collabora isolated on a separate origin with TLS, sandboxing, its WOPI host
allowlist and restricted network egress. Disable document macros in its server
configuration and deny cloud metadata/private-network fetches. Keep the service
updated and redact WOPI access tokens from proxy/service logs. Never disable
sandboxing or enable all WOPI hosts in production. No production deployment or
feature rollout is included here. Missing service/shared Redis configuration
shows an explicit unavailable state with Open in Drive.

Editing capabilities expire after four hours. Drafts remain AES-GCM encrypted
in shared Redis for at most four hours and fifteen minutes, limited to five
concurrent editing/recovery sessions per member. The extra fifteen minutes
permit only an authenticated **Download last received copy**: current membership,
feature, pinned connection and file read authorization are still required.
Revocation masks recovery too. It does not require write permission, renew WOPI,
or admit a Drive save after editing expires, including across a slow metadata
read. Closing a tab removes its temporary Den session; abandoned sessions expire.
Collabora storage has its own retention policy, which operators must configure.
A page refresh does not restore the temporary editing session.

Recovery is deliberately smaller than a live engine export. It returns the exact
snapshot bytes already received by Den (or the original if none arrived), not
edits still buffered in the engine. The UI names this limitation before download;
no latest-changes or engine-fidelity guarantee is made. The recovery API tests
exercise real Den/Redis authorization, exact ZIP byte preservation and expiry;
the headless UI proof uses a synthetic postMessage peer. A representative engine
round trip with unsent edits before/during expiry remains unproven by these tests.

A Drive write with an unconfirmed result is terminal for that editing session.
Status exposes the uncertainty; the client shows **Save not confirmed**, disables
another save, and offers Check Drive and last-received recovery. It never
replays that write or treats a retry as a way to reconcile its outcome.

## Package boundary

- `@openwork/documents`: metadata provider contract, Google Drive adapter and
  authenticated editor client.
- `@openwork/documents/model`: platform-neutral, Zod-validated editor/read/save
  contracts. No authentication or React.
- `@openwork/documents/office-engine`: provider-independent full-editor contract,
  schemas and configurable transport.
- `@openwork/documents/office-server`: Collabora WOPI protocol and bounded
  snapshot reads; no Google credentials, authentication framework or Drive writes.
- `@openwork/documents/office`: existing bounded cell/text edit helpers for hosts
  that explicitly choose that smaller editing surface.
- `@openwork/documents/react`: `DocumentsBrowser`, file editors, composable
  toolbar controls and the `EditorController`/`EditorCommand` types.
- `@openwork/documents/styles.css`: scoped semantic styles.

A host imports styles, renders inside TanStack Query, supplies its authenticated
organization/person cache scope, feature availability, connection URL and
`DocumentsEditor` transport. It should honor `onDirtyChange` before unmounting
the workspace. Remount on identity/provider changes. Text drafts remain in
component memory; full Office drafts live temporarily on
the configured document service and in encrypted server storage. They never go
into browser storage, chat or model context. Another storage provider
implements the metadata/editor contracts rather than changing Workbot's UI.

## Authority and rollout

`workbotDocuments` remains off by default on cloud and self-hosted, and requires
Workbot. Both the Workbot site and Den independently check availability. Den's
proxy allowlists metadata reads and the editor/content route families; writes
require `mcp:write`. Direct editor routes also require both flags, authenticated
organization membership, connector policy and Google permission.

Editor reads resolve and pin the actual connection ID. Every later page/read/save
uses that exact connection, so a changed default cannot silently switch accounts.
Drive read access is required to browse. Existing-file edits require the relevant
connector/account write grants and Google's `capabilities.canEdit`. Credentials
stay on the server. All responses are `no-store`; content is excluded from MCP
capability discovery and audit evidence.

Every full-editor save checks the pinned connection, current permissions and Drive
version, and serializes writes through shared file/session locks. If Google
provides an ETag, updates also send If-Match. An unconfirmed write is marked
before dispatch and cannot be retried automatically. Reopen after checking Drive.
There remains a check-then-write window when no ETag is supplied; this is not
Google native collaboration. Different Documents sessions do not share an editor
room.

The existing basic editor routes recheck revision and permissions. Native Docs additionally
use Google's atomic revision write control. Drive binary uploads and Sheets
cell writes have a check-then-write concurrency window; they are not atomic
compare-and-swap and not a replacement for Google's live collaboration engine.
A detected conflict retains the draft, with an explicit reload/discard action.
Uncertain saves are never retried automatically. Disabling a feature stops new
reads/writes without deleting Drive files or changing Calendar/chat behavior.

Design: P1/P2 (data and state), P4 (blocked presence and connection recovery),
P6/S2 (compact files), S5 (user opens a file), C6 (recoverable failure), V1/V2
(host typography and semantic tokens).
