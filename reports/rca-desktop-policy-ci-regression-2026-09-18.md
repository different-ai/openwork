# Desktop policy CI regression — 2026-09-18

## Outcome

The failures in [CI run 35308558274](https://github.com/different-ai/openwork/actions/runs/35308558274) are regressions introduced by the desktop-policy suspension in [#5131](https://github.com/different-ai/openwork/pull/5131), not flaky tests.

This repair keeps desktop restrictions and ordinary desktop bootstrap sign-in optional. It restores the independent request-validation and product behavior that the suspension accidentally bypassed:

- request bodies are still validated before they reach the engine;
- identity installation remains authenticated by the host token;
- an unauthorized OpenWork client still fails closed before the engine;
- local prompts remain independent of the suspended policy endpoint;
- the Cloud distribution's immutable first-launch sign-in gate still renders.

No browser-panel or external-link routing code changes here.

## Control and red receipts

| Check | Green control `071181d2d` | Red `1bb9145f1` | Repaired branch |
| --- | --- | --- | --- |
| Workspace OpenCode proxy | 29 passed, 0 failed | 17 passed, 6 failed | 30 passed, 0 failed |
| Packaged Cloud first launch | 1 passed in 9.55s | 1 failed after the 60s gate timeout | 1 passed in 9.55s |
| Activated Enterprise launch | 1 passed at the former sign-in gate | 1 failed after the 60s gate timeout on the intended local session shell | 1 passed on the local session shell |

The CI artifact and local packaged reproduction showed the same red surface: the Cloud artifact mounted the ordinary signed-out session shell (`Create or connect a workspace` / `What do you need done?`) instead of `Welcome to OpenWork`.

### Before

The broken Cloud first launch skips its immutable sign-in gate and exposes the ordinary session shell.

![Broken Cloud first launch showing the ordinary session shell](https://b8tgacyg507ru26g.public.blob.vercel-storage.com/pr/cloud-first-launch-gate/browser-screenshot-1789748972455-BUbJ3oLErbkdw2wGAOb0wVxJ1TN84Q.png)

### After

The repaired packaged Cloud artifact mounts its expected sign-in gate on a fresh profile.

![Repaired Cloud first launch showing Welcome to OpenWork](https://b8tgacyg507ru26g.public.blob.vercel-storage.com/pr/cloud-first-launch-gate/browser-screenshot-1789749100522-JhKfwCdLXcZif9FiIDMKp56IJl4WNq.png)

## Root causes

### Proxy suite

`assertRequest()` returned before request parsing. Five signed-in prompt cases also retained pre-suspension expectations for a blocking `GET /v1/me/desktop-config`. Together these produced six failures, but only the malformed-body failure represented behavior outside [#5131](https://github.com/different-ai/openwork/pull/5131)'s intended suspension:

1. the policy read is deliberately skipped while desktop policy is suspended;
2. malformed engine JSON was unintentionally forwarded rather than rejected with `400 invalid_request`;
3. the test named “unverified identity” only made `/v1/me/desktop-config` return `401`; it did not fail the host-token authentication on `/den-session/identity` or the client-token authentication on the prompt.

The fix keeps the non-blocking read/startup call and policy-action no-op from #5131, but lets requests continue through the existing body parser before policy actions are skipped. The proxy tests now assert zero policy requests, prove host-token verification still guards identity installation, keep the unauthorized-client and engine-error ordering checks, and explicitly prove that a rejected policy endpoint does not block a local provider prompt.

### Packaged first launch

`desktopSigninRequired()` treated every desktop `requireSignin` value as an optional policy. The packaged Cloud flavor uses that value as an immutable distribution requirement, so it skipped the only gate above its first-launch routes.

The fix distinguishes the Cloud distribution requirement from optional bootstrap policy. Public and Enterprise desktop policy sign-in remains suspended; web sign-in is unchanged.

The activated Enterprise package check still expected the policy sign-in surface removed by #5131. It now proves the activation gate steps aside to the local session shell while both the activation gate and suspended policy sign-in gate stay absent. The unmodified `1bb9145f1` control reproduced its former 60-second timeout on that same local session shell.

## Link-policy ownership and compatibility

[#5123](https://github.com/different-ai/openwork/pull/5123) remains open and owns primary-link routing, affirmative `managed`/`unmanaged` authority, and the fail-closed dialogs for unknown authority, outages, and sign-in races. It was inspected but not merged or copied into this repair.

That pull request overlaps `managed-desktop-policy.ts` mechanically. On rebase, it must retain this repair's request parsing while adding its separate authority return contract. This repair does not alter `browser-panel.mjs`, Electron's policy client, or link decisions, so it neither claims nor changes that separate behavior.

## Verification commands

All checks used pnpm 11.4.0, Bun 1.4.0, and Node 24.20.0 on the local macOS lane.

```text
cd apps/server && bun --conditions=development test src/opencode-proxy.e2e.test.ts
# 30 passed, 0 failed; exit 0

cd apps/server && bun --conditions=development test src/managed-desktop-policy.test.ts
# 5 passed, 0 failed; exit 0

cd apps/app && bun test tests/desktop-policy-optional.test.ts
# 4 passed, 0 failed; exit 0

cd apps/server && pnpm typecheck
# exit 0

cd apps/app && pnpm typecheck
# exit 0

cd packages/types && pnpm build
# exit 0

OPENWORK_EVAL_ELECTRON_BINARY=<fresh-packaged-cloud-binary> pnpm evals:e2e packaged-first-launch --local
# 1 passed; exit 0

OPENWORK_EVAL_ELECTRON_BINARY=<fresh-packaged-enterprise-binary> pnpm evals:e2e packaged-activated-launch --local
# 1 passed; exit 0
```

The packaged proofs used fresh unsigned macOS arm64 Cloud and Enterprise directory artifacts. CI's Linux packaged artifacts independently recorded the same DOM states and timeouts.
