# Native affordance Code Mode verification

Branch: `fix/native-affordances-codemode`
Base: `d4b32a6f4e` (`origin/dev` when rebased)

## Scope

The feature is **not deployed or enabled**. `nativeAffordanceCodeMode` defaults
off on cloud and self-hosted deployments. A rollout-enabled, newly started V2
engine publishes the existing context/query/sidebar-command tools to Code Mode.
All existing direct tools continue working when disabled.

Rebasing onto current dev reused its restricted session-group bridge rather
than adding another command endpoint. Host validation, workspace resolution,
confirmation and saved-assignment checks stay in the existing implementation.
Browser, computer, Drive and Gmail tools are not exposed to Code Mode.

## Regression witness

`apps/server/test/openwork-context-codemode-native.test.ts` uses the real
packaged OpenCode V2 binary and a deterministic model-protocol fixture. It
first discovers exact tool paths, then emits one Code Mode script that queries
groups, moves two sessions, preserves an exception and verifies groups again.
The group routes use an in-memory backing fixture; this is not sidebar UI E2E.
No real user session assignments are modified.

- Current dev plugin, built into a temporary control plugin directory:
  **Failed as expected**, 0 pass / 1 fail / 0 skip. Neither native tool appears
  in Code Mode discovery.
- Rebased changed plugin under Bun: **Passed**, 1 pass / 0 fail / 0 skip.
- Rebased changed plugin with the host under Electron's Node runtime:
  **Passed**, 1 pass / 0 fail / 0 skip.

## Rebased checks

Tests were rerun after rebasing; old pre-rebase verdicts are not used.
Node-based checks use Node 24.22.1, as required by current dev.

| Check | Result |
| --- | --- |
| `pnpm exec bun test apps/server/test/openwork-context-codemode-v2.test.ts` | 3 pass, 0 fail, 0 skip |
| `pnpm exec bun test apps/server/test/openwork-context-codemode-cancellation-v2.test.ts` | 1 pass, 0 fail, 0 skip |
| `pnpm exec bun test apps/server/test/openwork-context-codemode-native.test.ts` | 1 pass, 0 fail, 0 skip |
| Same native witness under Electron-as-Node/tsx | 1 pass, 0 fail, 0 skip |
| `pnpm exec bun test apps/server/test/openwork-session-groups.test.ts` | 4 pass, 0 fail, 0 skip |
| `pnpm exec bun test apps/server/test/live-provider-sync.test.ts` | 12 pass, 0 fail, 0 skip; includes offline rollout revocation |
| `pnpm --filter @openwork/features test` | 20 pass, 0 fail, 0 skip |
| `pnpm --filter openwork-server typecheck` | Exit 0 |
| `pnpm features:sync` and `pnpm features:check` | Exit 0 |
| `pnpm den:contract` with dedicated localhost MySQL on port 33307 | Exit 0; regenerated ignored OpenAPI/SDK artifacts |
| `git diff --check` | Exit 0 |

The 41 distinct tests pass; the repeated Electron run is not additional coverage.
No sidebar screenshot or full-product UI E2E claim is made. API contracts are
regenerated locally after rebasing, but remain ignored build artifacts under
current dev's contract policy.

## Activation and recovery

Merge/build the change, enable the feature for the intended organization via
normal admin rollout controls, then start a new V2 engine. Current installed
processes are not patched. A captured Code Mode tool marks its requests; the
host rechecks the feature before every marked write. The kill switch and
unreachable Den reject subsequent marked writes without reverting assignments.
Original direct commands remain available. An uncertain write must be checked
through a query before retrying.

See `docs/development/native-affordance-codemode.md` for rollout and boundaries.
