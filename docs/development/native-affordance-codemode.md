# Native OpenWork affordances in Code Mode

The V2 context plugin's `openwork_context`, `openwork_query` and
`openwork_execute` are discoverable in the engine's Code Mode catalog by default
on cloud and self-hosted deployments. `nativeAffordanceCodeMode` is retired.
This changes composition, not host authority. Browser, computer, Drive and Gmail
tools remain direct-only.

## Try it

Ask the assistant to list sidebar groups and move selected sessions, preserving
an exception. It can discover the native tools through Code
Mode's `search` and run a query → loop of moves → verification query in one script.
Discover exact paths rather than hard-coding a namespace. Native tool results
are JSON text; parse them before inspecting fields.

## Boundaries and recovery

- Code Mode calls reuse the existing restricted context bridge. Queries remain
  read-only; commands remain limited to the existing session-group host routes.
  Arbitrary UI commands, engine mutations and extension calls are not added.
- Existing workspace resolution, session/group validation, confirmation for
  group removal, and verification of the saved assignment remain unchanged.
- Conversation-browser credentials still cannot authorize context/group calls.
- Stopping the calling session aborts the request. After an interrupted or
  uncertain write, query state rather than automatically replaying it.
- No feature switch removes Code Mode access. Existing host authorization and
  validation still apply to every command.

## Verification

Run one test at a time:

```sh
pnpm exec bun test apps/server/test/openwork-context-codemode-v2.test.ts
pnpm exec bun test apps/server/test/openwork-context-codemode-cancellation-v2.test.ts
pnpm exec bun test apps/server/test/openwork-context-codemode-native.test.ts
pnpm exec bun test apps/server/test/openwork-session-groups.test.ts
pnpm exec bun test apps/server/test/live-provider-sync.test.ts
pnpm --filter openwork-server typecheck
pnpm --filter @openwork/features test
pnpm features:check
```

The native test uses the actual V2 binary and a deterministic model-protocol
fixture, not a mocked Code Mode interpreter. It discovers callable paths and
runs a script that moves two sessions, preserves an exception and verifies the
result. Host route responses use an in-memory fixture; this is not a full
sidebar UI E2E test. Set `OPENWORK_TEST_OPENCODE2` when the binary is not at the
packaged macOS path.
