# Native OpenWork affordances in Code Mode

`nativeAffordanceCodeMode` makes the V2 context plugin's `openwork_context`,
`openwork_query` and `openwork_execute` discoverable in the engine's Code Mode
catalog. The feature defaults off on cloud and self-hosted deployments. It
changes how existing tools can be composed, not which host operations they can
perform. Browser, computer, Drive and Gmail tools remain direct-only.

## Try it and roll it out

Enable the feature for an organization through the existing admin Features
controls. Start a new V2 engine instance to capture the enabled catalog.
Missing feature state and older Den responses remain off. All three existing
direct tools, including sidebar commands, continue working when disabled.
No local environment flag bypasses the rollout.

Ask the assistant to list sidebar groups and move selected sessions, preserving
an exception. With the feature on it can discover the native tools through Code
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
- Native tools mark snapshots admitted to Code Mode. Before every marked command,
  the host rechecks the resolved feature, including for an already captured
  executor. Turning it off rejects later marked writes with `feature_disabled`;
  already dispatched writes may finish. Original direct commands still work.
- Unreachable Den disables the cached rollout grant rather than authorizing new
  Code Mode writes from stale state. Model-access policy retains its existing
  offline behavior.
- Stopping the calling session aborts the request. After an interrupted or
  uncertain write, query state rather than automatically replaying it.
- A later engine restart restores the direct-only catalog. Disabling the
  feature never moves sessions back or deletes groups.

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
