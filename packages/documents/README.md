# Connected documents

`@openwork/documents` is a reusable document workspace. Workbot supplies its
signed-in transport and identity; other hosts can use the same browser and
provider/editor contracts without embedding Workbot.

## Documents workspace

- One navigation: a Recent / My Drive switch beside the search, then quiet list
  controls (sort, list or grid, refresh). No second sidebar or list of recent files.
- Recent files from Drive API v3, ordered by `recency desc`, excluding folders,
  not a fabricated list or local browsing history.
- Folder breadcrumbs (only inside a folder), folder-scoped search, pagination,
  list/grid views and name/date sorting of loaded files.
- Files open in internal tabs with close buttons and an unsaved-change dot. Switching or reordering tabs retains unsaved edits; closing an edited tab offers save, keep editing, or discard. Drag tabs to reorder, or focus a tab and use Alt+Shift+Left/Right. Delete closes the focused tab. The tab row appears once a file is open, with All documents fixed first.
  Closing a dirty file or leaving Documents asks whether to keep/discard edits.
  Page unload uses the browser's unsaved-changes protection.
- Missing/expired Drive access shows Connect/Reconnect through Den's existing
  connections page. Parent sign-in revalidation retains the document owners,
  masked, instead of unmounting them. A different person or organization cannot
  reveal a retained draft even when they can read the same file.
- Directory denial remains latched even with no open tabs and after later
  outages. Only a fresh identity and authorized directory read clear it.
- Each locked file has a non-extending 15-minute recovery deadline. Files are
  checked independently: an allowed draft can return while another stays
  locked, retryable or individually discardable. Hosts must implement
  `verifyScope`; without it recovery remains locked. A full page refresh does
  not restore memory-only drafts.
- Files open as lightweight read-only previews without an Office session or a
  Cloud worker startup. Word and Excel use the existing bounded readers;
  PowerPoint and OpenDocument show bounded text previews. PDF/images and native
  Google previews continue through their existing routes.
- A host that passes `editingEnabled` adds **Edit** when the member also has
  write access. Native Google/text edits stay inline. Office editing starts the
  full engine only after this action, keeps the preview visible with progress
  until the document loads, and offers cancel, retry and Open in Drive on
  failure. **Preview** closes a clean editing session. No OpenWork host passes
  it today: Workbot and Den serve previews only.
- Explicit Save to Drive writes to the original file; no background writes.

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

## Workbot authorization

`workbotDocuments` remains off by default on cloud and self-hosted, and requires
Workbot. Both the Workbot site and Den independently check availability. Den's proxy accepts read-scoped requests to allowlisted listings, metadata,
read-only document views and file previews. Following document links also
requires `workbotWorkspaceAssistant`. Drive reads pin the authorized connection;
OneDrive reads use the member's Microsoft 365 connection. Credentials stay on
the server, file reads use `no-store`, and contents do not enter chat, MCP
capability discovery or audit evidence. To edit a file, open it in its original
application.
