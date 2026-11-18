# Sandbox-only: real-model engine check, GPT-6.1 Sol

## Latest coordinated run: FAIL — 41/51 checks passed

**2026-11-18 07:58:02.466–07:59:01.250 UTC** (17 Nov 23:58–23:59 Pacific),
exit **1**, actual product source, **no plugin override, whitelist, or shared-script edit**.
The ten source/script fingerprints below and tracked diff were unchanged before
and after the run. Earlier mixed-source failures are retained briefly at the end.

**Blocking defect:** the provider receives only native `glob, grep, read, shell`,
not the required six primitives. **`write` and `edit` are absent**, and `execute`
is also absent, so the model cannot reach them through Code Mode. The instructions
still describe `browser (45 tools, 13 shown)` even though no browser/execute tool
is callable. This is not a successful six-tool sandbox-only experience.

## Confirmed model, tier, engine, and safety

| Field | Recorded value |
| --- | --- |
| Requested model | `gpt-6.1-sol` |
| Actual response model | **`gpt-6.1-sol`**, all 17 inference responses |
| Provider-reported service tier | **`fast`**, all 17 responses |
| Accepted request tuning | `reasoning.effort=low`, `service_tier=priority`; no tuning rejection/fallback |
| Adapter / endpoint | `@opencode/ai/providers/openai` / `/v1/responses` |
| HTTP results | All 17 requests HTTP 200 |
| Engine | Pinned `2.2.6`; actual `opencode v2.2.6` |
| Host | macOS `darwin/arm64`, Node `v24.22.2` |
| Usage | 79,702 input + 1,119 output = 80,821 total tokens |
| Completion | All five turns finished; no timeout or fatal harness error |
| Cleanup | Temporary root removed; no run-owned sandbox VM process left |

The actual tier is `fast`; `priority` is the accepted **request** value, not a
replacement name for the observed tier.

Real: product engine, plugin, authenticated context/sandbox bridges, local runtime,
local microVM, live authorized mounts, and provider inference. Fixtures: loopback
Den `/v1/features` and a loopback inference proxy. Fresh history/workspace; the proxy
retains the real provider key only in memory, and engine config contains only a
random scoped proxy token. The key was absent from session/recorded traffic. No
production organization/account API, flag, policy, or UI was changed. No unit-test
result substitutes for the real model/guest effects reported here.

## Actual behavior and tool traces

The guest turn made **8 tool calls**: four shell, two read, one glob, one grep.
The other turns made two, one, and one calls as detailed below; host rails made none.
No write/edit tool call occurred in any phase.

| Phase / engine session | Observed attempts and outcomes |
| --- | --- |
| Guest tools / `ses_e12564fc9ffeZZ7lo5xu3btEmn` (9 inference requests) | Native `shell` returned **Linux** and a guest scratch nonce; that scratch file was absent on the macOS host. Native authorized `read` returned its nonce at the original absolute path. Native `shell` wrote the authorized-folder file, verified through the host's live mount. Native `glob` found `notes.txt`; native `grep` returned `notes.txt:2:status: draft`. Unmounted-secret native `read` errored; native shell `cat` returned no-such-file. One additional guest-shell `command -v execute; command -v write; command -v edit` returned empty output. **No write/edit call**: copy absent, notes unchanged. |
| Host rails / `ses_e1255e9b8ffe1idHIkpGZd0TgD` (1 inference request) | **No tool calls.** The model explicitly reported all three browser/preview/fetch probes not attempted because no execute tool was available. Loopback witness: 0 hits. The harness's no-browser/no-other-tool passes are **vacuous**, not runtime rejection witnesses. |
| Read-only / `ses_e1255d225ffeFOk4aN6Mop3NSm` (3 inference requests) | Native authorized read still succeeded. Native shell write returned `exit=1` and **Read-only file system**; no authorized-folder file appeared on the host. **Write tool not attempted** because unavailable: absence of its file is not evidence that the write implementation enforced read-only. |
| VM killed / `ses_e1255a8a6ffeJ4xE264vlmL938` (2 inference requests) | Harness found/killed **1 run-owned microVM process**, verified it did not survive. Subsequent native shell completed; workspace uname file contained **Linux** and the unmounted host `/tmp` sentinel was absent. **Write tool not attempted**, its output file absent. This is a guest recovery/no-host-fallback observation, not an unavailable-error result. |
| Rollout revoked / `ses_e12558d27ffeEJ4ZBJ9Vzuq38D` (2 inference requests) | Native shell attempted and refused with the error below. No host sentinel. **Write tool not attempted**, so the requirement to call both tools failed. |

Unmounted-secret read refusal:

> Sandbox bridge request failed (503); host fallback is disabled. Guest path is not a file.

Unmounted-secret shell returned `cat: can't open '…/hostonly/secret.txt': No such
file or directory`. The secret remained intact on the host and never appeared in
the session or any provider request.

Rollout-revoked shell refusal:

> Sandbox bridge request failed (503); host fallback is disabled. Sandbox tools are disabled or their rollout could not be verified. Nothing ran on the host.

### The ten failed checks

1. Exactly-six catalog in guest, VM-killed, and rollout-revoked phases: **3 failures**.
2. Guest write/edit calls ran: **2 failures**.
3. Guest write/edit changed live workspace files: **2 failures**.
4. Both requested tools were called in read-only, VM-killed, and rollout-revoked phases: **3 failures**.

The reported 41 passes must not obscure these failures or the vacuous negative
checks. Tests were not loosened, operations were not substituted with shell to
manufacture write/edit success, and the shared harness was not modified.

## Source identity

Worktree: `/Users/benjaminshafii/_worktrees/sandbox-tools-microsandbox`.

HEAD before/after: **`993b576c3cbc381c5bf2b22d9f45ac22c59de6c6`**; dirty product tree,
not a clean-commit claim. SHA-256 of `git diff --binary HEAD` before/after:
`33231fca6ad5fe087973a7ace1298969cd024e00d5676d91b320402c870e8b7a`.
This covers tracked differences; the per-file fingerprints include the untracked
script/guard. Observed at 07:57:55.535 and 07:59:10.001 UTC; all matched:

| File | SHA-256 |
| --- | --- |
| `evals/scripts/sandbox-model-check.ts` | `601cd1e486d5c33e785469df9832b4365ead99c25e4806286922d51f5e6a01ab` |
| `apps/server/src/opencode-plugins/openwork-sandbox-v2.ts` | `3ed25a7ad1b35eb6ae8521782424af7764a7a4ac83cd7e30810098fc7881b291` |
| `apps/server/src/sandbox-host-guards.ts` | `449cf401fba42243203359f339a2e21790a26444889293c0743d14146b2304ac` |
| `apps/server/src/local-sandbox-runtime.ts` | `73aa985d208edd1453fe00c3f81840991b00465a3ed9b9c8d08f7e387024bc45` |
| `apps/server/src/opencode-v2-context-bridge.ts` | `9cd03ad9239121d0ffe2e51ecd8fc5a02c414ce9d575632db6d8f8ca8492a9c2` |
| `apps/server/src/engine-v2-preview.ts` | `0dfb8c480eb7a3f5f4d9a3575efc1b635576f5a19fdc1cc61fc291b8392d4646` |
| `apps/server/src/opencode-v2-artifacts.json` | `d23c49cbb9181cdb6470e1cb35756857d0f55781a6bc1176bd72d27a78361a2c` |
| `apps/server/src/sandbox-tool-host.ts` | `325c7504915462e67d23589ff0047fbc4b0c4ff4f733c62fd139b34cc79934de` |
| `apps/server/src/managed-opencode-v2.ts` | `fbfef6c35fd8e8dfe27957932cb610283067216bcb85664d67be2c6ad5175050` |
| `apps/server/src/sandbox-tools-bridge.ts` | `d99e223bfe19941c05b3669efe402bf91ba8e442d6c46d51c08d71574c30ff87` |

## Evidence and rerun

Latest evidence, outside git:
`/var/folders/8j/hhcc8zs100d3fd654fjkk9580000gn/T/opencode/sandbox-model-check/sandbox-model-check-sol-2026-11-18T07-58-02-466Z.json`

Evidence SHA-256:
`13ca6c01e927b53197f71549018f0507d5601ac7bd4cbe6b2b26dbddac1649db`.
`pluginOverride: null`, `passed: false`, no fatal error.

```bash
cd apps/server
infisical run --silent --env dev -- /opt/homebrew/opt/node@24/bin/node \
  --conditions=development --import tsx ../../evals/scripts/sandbox-model-check.ts --model sol
```

Only this report was edited by this tester; no shared source edits, commit, or push.

## Limitations

- Engine/plugin evidence, **not** Settings/Den UI, signed-in organization-policy,
  packaged-app, or shipping-platform proof.
- Host-rail calls were not dispatched. Catalog withholding was observed; direct or
  stale-call host-side denial was not exercised by this model turn. Loopback fetch
  hits are observations, not a failing assertion in the harness.
- The read-only phase resets `config.readOnly` to false **before** the VM-kill
  phase. Its next call also has a changed mount fingerprint and may deliberately
  recreate the VM. Thus VM kill/recovery/no-host-fallback was witnessed, but this
  does not isolate same-mount-plan crash handling from mount-plan recreation.
- Live folder removal, local MCP, computer use, child sessions, alias/hardlink
  attacks, cancellation, and durable guest-state recovery are not covered here.

## Earlier failure records (superseded, not erased)

Both older runs used the same HEAD above and original script SHA-256
`aea54b234389e50e01da1b96ecee71f5c03c43f6328dccaa4d9b3c98340877fc`,
without overrides. Both returned actual `gpt-6.1-sol`, tier `fast`. Their plugin
changed during execution, so they are **mixed-source failures**, not stable-tree
baselines. Full checks, tool inputs/outputs, sessions, and provider records remain
in these JSON files under the same evidence folder:

| Run UTC | Result / evidence basename | Source boundaries and key observations |
| --- | --- | --- |
| 06:34:36.348–06:35:14.866 | **27/36**, exit 1; `sandbox-model-check-sol-2026-11-18T06-34-36-348Z.json` | Plugin SHA-256 `668a2976264bbc4766a03d4ed4fc77370105d32bc1640b91c1b4842c6dac88ba` → `2f421009019801c0bb189381b631cc4990c9670e9a306cbab0074315b2ca71a4`. Code Mode refused before guest children; catalog included browser. Native authorized read succeeded; write/edit absent; one stale shell reported `Sandbox tools are closed.` No Linux scratch witness. 14 requests, 88,280 input / 1,044 output tokens. |
| 06:35:42.764–06:36:21.678 | **29/36**, exit 1; `sandbox-model-check-sol-2026-11-18T06-35-42-764Z.json` | Plugin `2f421009019801c0bb189381b631cc4990c9670e9a306cbab0074315b2ca71a4` → `d3277e3af4130bd9920aee34f5cc8317ebb7511fcb0780e3aa8dbad1c2ead835`. Linux/scratch and authorized native read/shell write passed; native write/edit missing; execute discovery blocked; browser still described. 12 requests, 58,480 input / 915 output tokens. |

Both preserved host secrets, refused the rollout-revoked native shell, created no
host sentinel, and cleaned up. Browser/fetch probes were outer-blocked, not
successfully executed inside a safe interpreter. No diagnostic run is presented
as product evidence.
