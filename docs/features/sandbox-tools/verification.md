# Sandbox-only verification

Scope: local microsandbox, required-only mode, Den/local permission controls and host-rail admission. No production
organization, feature rollout, provider configuration or customer data was mutated. Tests use disposable local Den
instances and runtime profiles; real-model keys remain in an in-memory inference proxy.

## Placement

A disposable Daytona default sandbox exposed `/dev/kvm`, but its normal `daytona` user (uid 1001) received
`PermissionError: [Errno 13] Permission denied: '/dev/kvm'` on `os.open(..., O_RDWR)`. CPU virtualization flags alone
were not treated as usable KVM. The probe sandbox was deleted. Thus real microVM/native Electron work runs on this
Apple Silicon Mac. Portable Den/Settings controls use the Daytona-supported proof lane; its final receipt is
recorded below once that run completes. No remote result is represented as a microVM result.

## Completed local product proof

Command:

```sh
MICROSANDBOX_LIVE=1 MICROSANDBOX_PRODUCT_PROOF=1 \
  pnpm evals:e2e sandbox-only --local --engine v2 --surface electron
pnpm evals:e2e sandbox-controls --local --engine v2
```

Native proof: **4 passed, 0 failed, 0 skipped**; controls proof: **3 passed, 0 failed, 0 skipped**. Both drive real
UI and record screenshots/assertions. The native proof uses Electron's embedded Node runtime and an actual local
microVM, not a fake provider. The deterministic model is a tool-calling witness; real-model tests are separate.

| Claim | Independent witness |
| --- | --- |
| Required mode executes in guest | Native `shell` returns Linux; inference sees exactly six direct guest tool names; unmounted host nonce cannot be read |
| Absolute live mounts | Authorized Folder is added through the supported API; guest reads at that exact host path; changes both directions match bytes independently |
| Read-only | Separate actual-provider API test confirms guest file writes and shell redirection fail while reads succeed; no fabricated UI control |
| Sandbox unavailable | Invalid runtime directory produces a real SDK startup failure, tool errors and no host sentinel |
| Org/local controls | Den team toggle changes member rule; managed local switch is locked; a direct local-Allow API save cannot weaken effective org denial |
| Flag off | New control absent for unaffected users, no new host rule, and ordinary tool reads the host-only nonce |
| Persistence | Signed-out local preference survives reload and explicit opt-out restores host access |

Intermediate failures are retained. Product proof found and fixed: unsupported Bun SQLite/JSONC eager bundling under
Electron, duplicate host policy/runtime singleton caches in the bridge bundle, and an overbroad host guard that
blocked the app's text-only session instructions update. No failing assertion was removed to obtain these passes.

## Automated checks

- Adapter offline suite: **23 passed**; separate adapter live suite previously **18 passed** on this Mac.
- Exact Static CI command: **419 passed**, no failures/skips. The original CI failure was a missing Docker snapshot
  workspace dependency closure; both package COPY entries were added, leaving the assertion intact.
- Den `test:api:security`: **159 passed**, no failures/skips. Audit coverage: **940/940** routes, disposable DB removed.
- Agent-permission type tests: **10 passed**. Server/native-engine sandbox regressions: **39 passed** in the full
  backend run, plus the product-proof integration regressions. Desktop computer-policy tests: **2 passed**.
- `pnpm check`: all eight checks pass, including typecheck, feature registry and proof spec lint.
- Server and desktop typecheck/build passed. Electron Node import of the final embedded-server bundle succeeds.

## Real models

See [Fable](model-check-fable.md) and [Sol](model-check-sol.md) for per-request provider-reported identities, effort,
service tiers, tool traces and intermediate failures. Fable uses accepted low effort; Sol requests low effort and
a fast/priority tier and reports the actual returned tier. Separate tester subagents run the two models in parallel,
with independent VM/runtime roots and no diagnostic plugin override.

The harness exercises actual OpenCode 2.2.6 sessions with real inference, the same plugin/host bridge/local runtime
and actual microVMs. Rollout is supplied by a loopback Den fixture; this is not a real production-flag proof.
Unadvertised host-tool checks with no model attempt do **not** establish dispatch enforcement; the hostile native
registry/MCP and host-route tests provide that separate coverage. Loopback witness observations are not inflated
into active exploit attempts.

## Evidence locations

Proofs are under `evals/proofs/`; worlds under `evals/worlds/sandbox-only.ts`. Galleries and machine assertions are
recorded under ignored `evals/results/test-runs/`, not committed screenshots. Final receipts and the PR publication
link are added after the committed-head reruns. Keys, runtime tokens and transient private connection URLs must not
be copied into public PR text.

Remaining limits: not a same-user OS jail, old desktop compatibility requires version restrictions for a complete
read-tool guarantee, all MCP transports/delegation are disabled in required mode, guest scratch resets on mount
recreation, and native signed release packaging/Claude CLI-provider runtime need separate validation.
