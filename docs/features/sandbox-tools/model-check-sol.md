# Sandbox-only: real-model engine check, GPT-6.1 Sol

## Final frozen-source run: PASS — 52/52 checks, exit 0

**2026-11-18 09:24:32.409–09:25:20.115 UTC** (01:24–01:25 Pacific), one run of
the current shared script against actual product source. **No plugin override,
diagnostic whitelist, script edit, assertion change, or retry.** Source/script
fingerprints and the tracked diff matched before and after execution.

Every inference request offered exactly the six native guest primitives:
**`edit, glob, grep, read, shell, write`**. Unlike the earlier failing run, native
write/edit were both offered and actually executed through the guest.

This is a pass for the 52-check **engine/plugin/bridge/local-microVM** harness,
not a claim that all UI, packaging, policy-transition, or adversarial host rails
have been exercised. Important limitations and vacuous checks are explicit below.

## Provider identity, engine, and safety

| Field | Actual recorded value |
| --- | --- |
| Requested model | `gpt-6.1-sol` |
| Provider response model | **`gpt-6.1-sol`**, all 21 inference responses |
| Provider-reported service tier | **`fast`**, all 21 responses |
| Accepted request tuning | `reasoning.effort=low`, `service_tier=priority`; no rejection or fallback |
| Provider adapter / endpoint | `@opencode/ai/providers/openai` / `/v1/responses` |
| HTTP results | All 21 requests HTTP 200 |
| Engine | Pinned `2.2.6`; reported `opencode v2.2.6` |
| Host | macOS `darwin/arm64`, Node `v24.22.2` |
| Usage | 101,353 input + 1,253 output = 102,606 total tokens |
| Completion | All five turns finished, no timeout or fatal error |
| Cleanup | Temporary root removed; no run-owned sandbox VM process left |

`priority` is the accepted **request** value; the provider actually reported
**`fast`**. Neither identity nor service tier was inferred from the request alone.

The script used fresh temporary history/workspace and real provider inference,
product engine/plugins, authenticated context/sandbox bridges, local runtime,
and a local microVM. The Den rollout read (`/v1/features`) and inference proxy
were loopback fixtures. The proxy retained the provider key only in memory; the
engine config held only a random scoped proxy token. No key appeared in the
session or recorded traffic. No production organization/account API, policy,
flag, or UI was changed. No unit-test result substitutes for the guest effects.

## Actual tool traces and witnesses

All calls below were native guest tools; no Code Mode child calls were needed.
The guest phase made nine calls, read-only three, VM-killed two, and rollout-revoked
two. Host rails made **zero** calls.

| Phase / session / inference count | Observed calls and effects |
| --- | --- |
| Guest / `ses_e12071ed2ffeezVDmNQlAzaULV` / 10 requests | `shell` returned **Linux** and a guest scratch nonce; scratch did not exist on the macOS host. Authorized `read` returned its nonce at the original absolute path. `write` created `copy.txt` with that content through the live mount. `edit` changed notes from draft to final. A guest shell wrote into the authorized folder, verified through the live host mount. `glob` found notes/copy; `grep` returned `notes.txt:2:status: final`. Unmounted-secret `read` errored and shell `cat` returned no-such-file. |
| Host rails / `ses_e1206d029ffe4JQfrY0pjc5DcO` / 1 request | **No tool calls.** Model reported browser tabs, file preview, and fetch not attempted because no execute tool was available. Independent host loopback witness: **0 requests**, now an explicit passing assertion. No direct or stale-call rejection was exercised; the no-browser/no-other-tool checks are vacuous with respect to dispatch-time enforcement. |
| Read-only / `ses_e1206bc80ffeqErBRcg7ehKSq4` / 4 requests | Authorized `read` succeeded. Native `write` actually attempted and errored with **Read-only file system (os error 30)**. Native shell write actually attempted and returned `exit=1`, **Read-only file system**. Neither target appeared on the host. |
| VM killed / `ses_e12069707ffeu9eUuhBh10qcLq` / 3 requests | Harness found and killed **1 run-owned microVM process**, verified it did not survive. Subsequent native `shell` and `write` **both completed** using the local guest path. Workspace uname witness contained **Linux**; write file was present. The unmounted host `/tmp` sentinel was absent. This is recovery/no-host-fallback evidence, not a refusal result. |
| Rollout revoked / `ses_e12067f6cffe7gdxvYpiI12X0u` / 3 requests | Native `write` and `shell` **both attempted and refused** with the explicit nothing-ran-on-host error below. No host sentinel file appeared. The catalog remained exactly the same six native guest tools. |

Unmounted host-file read refusal:

> Sandbox bridge request failed (503); host fallback is disabled. Guest path is not a file.

The native shell's `cat` of that same path returned no-such-file. Its contents
remained intact on the host and never appeared in the session or provider requests.

Read-only native write refusal:

> Sandbox bridge request failed (503); host fallback is disabled. sandbox fs error: open: Read-only file system (os error 30)

Rollout-revoked refusal, independently returned by both write and shell:

> Sandbox bridge request failed (503); host fallback is disabled. Sandbox tools are disabled or their rollout could not be verified. Nothing ran on the host.

## Exact tested source

Worktree: `/Users/benjaminshafii/_worktrees/sandbox-tools-microsandbox`.

HEAD before/after: **`8af925bea176d4d3e08ab4f68ec2dd90fe15020f`** plus dirty changes;
this is **not** a claim that the committed HEAD alone contains all tested fixes.
Before/after SHA-256 of `git diff --binary HEAD`:
`d25afd419ea9823be997531ebcea10e2a32526d38db5861cd27be5ee5bf6c1d5`.
The diff hash covers tracked changes only. The following file hashes were observed
at **09:24:25.229817** and **09:25:28.473538 UTC**, all unchanged, before this report
was updated:

| File | SHA-256 before = after |
| --- | --- |
| `evals/scripts/sandbox-model-check.ts` | `df0abb83e6e870651ec9868b1121023c8ccd2ebfa25a766845210ec38b1290a1` |
| `apps/server/src/opencode-plugins/openwork-sandbox-v2.ts` | `f14473ab1fefa08a794e5ab1591a3c74e54a7ba0e1785dac60763faf662a002c` |
| `apps/server/src/sandbox-host-guards.ts` | `449cf401fba42243203359f339a2e21790a26444889293c0743d14146b2304ac` |
| `apps/server/src/local-sandbox-runtime.ts` | `444777db8a6860ab1bb2d83e275ab8bbfb714e066fe8dda729ac84826f8b9358` |
| `apps/server/src/opencode-v2-context-bridge.ts` | `9cd03ad9239121d0ffe2e51ecd8fc5a02c414ce9d575632db6d8f8ca8492a9c2` |
| `apps/server/src/engine-v2-preview.ts` | `4c4423e3aa9915b13627339fdde5be21265fc9d51c94889e3a0f8ffcf98ae8e9` |
| `apps/server/src/opencode-v2-artifacts.json` | `d23c49cbb9181cdb6470e1cb35756857d0f55781a6bc1176bd72d27a78361a2c` |
| `apps/server/src/sandbox-tool-host.ts` | `325c7504915462e67d23589ff0047fbc4b0c4ff4f733c62fd139b34cc79934de` |
| `apps/server/src/managed-opencode-v2.ts` | `b67ccaad4aa62664d03407e4af18bf2754cf305afd4126d2a02fc0da62da6b9a` |
| `apps/server/src/sandbox-tools-bridge.ts` | `d99e223bfe19941c05b3669efe402bf91ba8e442d6c46d51c08d71574c30ff87` |
| `apps/server/src/managed-desktop-policy.ts` | `4f5a45c92e2c1fdc574651d68d3ac335dbc693e99d29c1e02d872f5e5a6258f7` |
| `apps/server/src/sandbox-settings-store.ts` | `ac3baa7ad879867164305867e7578479aa4112373c240f84c2078914473e0f7f` |

## Evidence and command

Full final JSON, outside git:
`/var/folders/8j/hhcc8zs100d3fd654fjkk9580000gn/T/opencode/sandbox-model-check/sandbox-model-check-sol-2026-11-18T09-24-32-409Z.json`

Evidence SHA-256:
`45ee7daa98aed2e356b46ed793ce680fff4973ec8fc77b9054ff0d8e46dfb5f0`.
`passed: true`, 52 checks, no failures, `pluginOverride: null`, no fatal error.

```bash
cd apps/server
infisical run --silent --env dev -- /opt/homebrew/opt/node@24/bin/node \
  --conditions=development --import tsx ../../evals/scripts/sandbox-model-check.ts --model sol
```

Only this report was edited by this tester; no shared-source change, commit, or push.

## Limitations and residual observations

- **Stale instructions remain:** provider requests still describe the browser's
  Code Mode catalog (`browser (45 tools, 13 shown)`). Actual API tool definitions
  are exactly the six native guest tools, and no execute/browser tool is offered.
  This is a residual instruction-consistency issue, not evidence of a callable
  host browser in this run.
- Browser/preview/fetch probes were **not attempted**. Catalog withholding and
  zero witness hits were observed; dispatch-time denial of malicious/stale host
  calls was not proven by the model's no-call host-rails turn.
- `config.readOnly` resets to false before VM kill. The next operation also has a
  changed mount plan, so this witnesses kill/recovery/no-host-fallback but does not
  isolate same-mount-plan crash handling from deliberate mount-plan recreation.
- No Settings/Den UI, packaged platform, signed-in org policy, legacy bootstrap,
  safe sidecar setting transition, forced mount revocation, or compaction-specific
  flow is exercised here. Those source fixes require their own focused evidence.
- Local MCP, computer use, child sessions, alias/hardlink attacks, cancellation,
  and durable guest-state recovery are outside this harness.

## Earlier failures — retained, superseded by the final run

All earlier runs below were real inference, no overrides, actual model
`gpt-6.1-sol`, tier `fast`, on HEAD `993b576c3cbc381c5bf2b22d9f45ac22c59de6c6`.
JSON basenames below resolve under the same evidence folder as the final JSON.

| Run UTC / result | Failure record |
| --- | --- |
| **07:58:02.466–07:59:01.250 / 41/51, exit 1** | Stable-source failure: only `glob,grep,read,shell` offered; native write/edit absent. Thus write/edit effects and both-tool attempts in read-only/VM-killed/revoked phases failed; catalog failed in three phases. Shell/read/glob/grep, live authorized shell write, read-only shell denial, secret isolation, VM recovery, and revoked shell refusal worked. Host rails made zero calls. Evidence `sandbox-model-check-sol-2026-11-18T07-58-02-466Z.json`, SHA-256 `13ca6c01e927b53197f71549018f0507d5601ac7bd4cbe6b2b26dbddac1649db`; script SHA-256 `601cd1e486d5c33e785469df9832b4365ead99c25e4806286922d51f5e6a01ab`, plugin SHA-256 `3ed25a7ad1b35eb6ae8521782424af7764a7a4ac83cd7e30810098fc7881b291`. |
| **06:34:36.348–06:35:14.866 / 27/36, exit 1** | Mixed-source failure: Code Mode outer guard blocked guest children; browser still described; write/edit unavailable and one stale shell said `Sandbox tools are closed.` Evidence `sandbox-model-check-sol-2026-11-18T06-34-36-348Z.json`. |
| **06:35:42.764–06:36:21.678 / 29/36, exit 1** | Mixed-source failure: Linux/scratch and live authorized native read/shell write worked, but write/edit remained missing and execute discovery was blocked. Evidence `sandbox-model-check-sol-2026-11-18T06-35-42-764Z.json`. |

These failures are not recategorized as passes. Full provider records, checks,
sessions, and tool traces remain in their JSON files. No diagnostic run is used
as product evidence.
