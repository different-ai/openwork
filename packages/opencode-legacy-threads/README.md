# V1 history in OpenCode v2

Read local v1 SQLite history without importing it. Select **Continue in v2** to copy one conversation, its descendants, and its required ancestors into native v2 sessions. The original history stays unchanged. New turns live in v2 and do not synchronize back to v1.

The first adapter supports OpenWork's OpenCode `0.0.0-beta-19086` and v1 `1.18.30`. Public v2 `2.x` has different package names and import routes and is not supported by this adapter. Older JSON-file history and database uploads are outside this implementation.

## Standalone setup

Start the engine with a **separate v2 database before startup**. OpenCode can run its migration before a plugin loads; this plugin cannot protect a v1 database used as the running engine's `OPENCODE_DB`.

Build the local package with `pnpm --filter @openwork/opencode-legacy-threads build`. Configure the plugin in the v2 configuration:

```json
{
  "plugins": [{
    "package": "file:///absolute/path/to/packages/opencode-legacy-threads",
    "options": { "legacyDatabase": "/absolute/path/to/v1/opencode.db" }
  }]
}
```

Set `OPENCODE_DB=/absolute/path/to/separate/v2/opencode.db` when launching OpenCode. The source option must be absolute and must identify a different database. The package is currently a local workspace package; it has not been published to a registry.

Use **Browse v1 chats** in the command palette or `/v1-chats`. The plugin page supports search, choosing a chat, older transcript pages, and **Continue in v2**. Review the conversion confirmation, including omitted history and permission/revert resets. It imports through the native client, then opens the native session. The root `server.js` and `tui.js` support local plugin discovery; package exports support named-package discovery.

## Shared service and host integration

`@openwork/opencode-legacy-threads/service` exports:

- `createLegacyHistoryService({ legacyDatabase, targetDatabase? })`: workspace-scoped, paginated `list`, paginated `read`, and `prepareImport`.
- `continueLegacyThread(plan, target, { allowOmissions? })`: validates provenance, serializes imports for one target, uses native import, and recovers a committed import after a lost response.
- `isLegacyThread`: identifies `v1:<source identity>:<session ID>` references. These references must never enter native execution or mutation routes.

The server plugin registers `openwork.legacy-history` RPC methods `list`, `read`, and `prepareImport`. RPC input cannot select a database or workspace directory; ownership follows the plugin's current location. The client owns native import.

OpenWork resolves the legacy source from its host's active v1 profile, independently of the v2 child's environment. Authenticated `/workspace/:id/legacy-history/session` routes expose list, transcript, children, conversion preview, and continuation. Continuation requires collaborator scope, a writable host, active v2 routing, and `confirm: true`. Source paths are never request parameters. Imported chats join OpenWork's existing conversation-home index.

OpenWork merges summaries into its normal v2 thread list, marks unconverted rows **v1 history**, and deduplicates verified imports. Opening an original transcript does not convert or import anything. The composer blocks sending and offers **Convert to v2**, preserves the draft, and navigates to the native chat. Known omissions require **Continue with omissions**. The existing bulk migration remains independent.

## Native converter provenance

`src/vendor/migration-19086.mjs` contains the pure `transformSession` implementation and helpers extracted from the published `@opencode-ai/core@0.0.0-beta-19086` file `dist/database/v1-migration.bun.js`. It uses the matching `@opencode-ai/schema` and Effect versions. The only runtime adaptation is Node SHA-256 in place of `Bun.CryptoHasher`, including the identical deterministic synthetic ID algorithm. `NOTICE` retains upstream's MIT license.

The transfer adapter validates each result with the pinned native `SessionTransfer.Data` schema. It never writes v2 tables or replays historical prompts or tools. Pending/running historical tools become interrupted tool results according to native migration semantics. Invalid message/part rows block conversion; readable originals remain available. Non-inline attachments, unfinished compactions, delegation-only turns, and retry notices receive compatibility warnings. Permission defaults and revert-state resets are shown before conversion.

Native session IDs are preserved. Existing sessions are reused only when source identity, original session ID, and converter version all match. Unverified ID conflicts are reported and never overwritten. Partial import retries resume safely. This implementation serializes requests within the owning host or CLI process; independent processes rely on native import's duplicate-ID conflict handling.

Native migration also preserves the selected agent's name. OpenWork's sidecar registers its `openwork` agent for continued chats. Standalone users must configure their custom v1 agents in v2 before continuing those chats.

## Focused verification

`pnpm --filter @openwork/opencode-legacy-threads build` builds the server and Solid/OpenTUI browser. `pnpm --filter @openwork/opencode-legacy-threads test` checks read-only WAL discovery, paging, workspace ownership, selective conversion, retry recovery, conflicts, omissions, RPC registration, CLI rendering, native-client import, and navigation.

Set `OPENWORK_MIGRATION_V1_BIN` to the pinned v1 executable and `OPENWORK_OPENCODE2_BIN` to the pinned v2 executable to enable `test/native.test.mjs`. That test runs both real engines in temporary profiles, compares transfer messages and session state against OpenCode's own full migration, verifies real custom RPC registration, imports selectively, continues a historical fact through a local model witness, and checks persistence after restart. No paid model is used.

OpenWork's UI proof extends `evals/specs/opencode-v2-chat-routing.e2e.test.ts` with before/after screenshots. Upstream CI owns evidence publication.
