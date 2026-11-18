# Sandbox-only: real-model engine check, Claude Fable 5.2

Final run 2026-11-17 23:58 PST (18 Nov 07:58–07:59 UTC) on Apple Silicon macOS, Node 24.22.2, with
`evals/scripts/sandbox-model-check.ts --model fable` against the unmodified working tree after the backend
edits were complete. One run, no retry, no plugin override.

**Result: 51 of 51 checks pass.** No call failed with "Sandbox tools are closed." in this run; that error
appeared in two earlier runs (see Open items). Nothing ran on the host in any run.

Three of the 51 checks, the host-rails ones, pass without anything being attempted, so they prove nothing
about dispatch (see Open items).

## What this run is

Real: the pinned OpenCode 2.2.6 engine started by `createManagedOpencodeV2Server`, the sandbox plugin from
source, the server's context and sandbox bridges, the local sandbox runtime, a local microVM, and inference
from `claude-fable-5-2` (the provider answered as `claude-fable-5-2`, service tier `standard`).

Fixtures: a loopback Den answering `/v1/features` (the signed-out rollout read), and a loopback inference proxy
that holds the provider key in memory. The engine config contained only a random scoped token and the proxy's
loopback URL. Sandbox-only was set by writing `allowHostExecution: false` to the server's own settings store.
The read-only turn flips `ServerConfig.readOnly`, a startup option, on the running config.

This is an engine/plugin check. It is not a UI proof, and no organization or production flag was involved.

The proxy added `output_config.effort: "low"` to each request; the provider accepted it.

## Final run 07:58 UTC: 17 inference requests, 2,909 output tokens

All 17 requests returned HTTP 200, were answered as `claude-fable-5-2`, and carried `output_config.effort: "low"`.
Input was 44 uncached tokens, 11,769 written to cache and 124,051 read from cache.

Every request offered the model exactly `edit`, `glob`, `grep`, `read`, `shell`, `write` as direct tools. No
`execute` (Code Mode) tool and no host tool was offered in any turn.

| Turn | Tool calls, in order | What the host showed |
| --- | --- | --- |
| Guest tools | `shell`, `read` completed; `read` of the unmounted file error; `edit`, `write`, `shell`, `grep`, `glob`, `shell` completed | See below |
| Host rails | none | The model had no tool that could make the browser or `fetch` calls |
| Read-only | `read` completed; `write` error; `shell` completed with `exit=1` | Neither file was created |
| VM killed | `shell` completed; `write` completed | Ran in a restarted guest |
| Rollout revoked | `write` error; `shell` error | No sentinel file |

Guest tools turn:

- `uname -s` returned `Linux` on a macOS host, and a file written to guest `/tmp` did not appear on the host.
- The authorized folder was read at its own absolute path; `write` and `edit` changed the host workspace files;
  the guest shell wrote a file into the authorized folder at the same absolute path.
- `glob` listed the workspace's `.txt` files and `grep` matched `notes.txt:2:status: final`.
- Reading the unmounted host file failed both ways: `read` returned "Guest path is not a file", and `cat`
  returned "No such file or directory". Its content never reached the session or the provider.

Read-only turn: the authorized folder stayed readable. `write` failed with "Read-only file system (os error
30)", and the guest shell's redirect failed with "can't create ...: Read-only file system".

VM killed turn: the run's one `msb machine` process was killed with SIGKILL between turns. The next calls
succeeded: the runtime restarted the VM on the same local backend, `uname -s` written through the mount read
`Linux`, and a path outside the mounts (`/tmp/...`) was not created on the host. The tool output the model received did not
mention a restart.

Rollout revoked turn: both calls failed with "Sandbox tools are disabled or their rollout could not be
verified. Nothing ran on the host." The model was still offered only the six guest tools.

Also checked: the provider key appears nowhere in the session or recorded traffic, and no VM process or temp
directory was left behind.

## Open items

- **"Sandbox tools are closed." (not seen in the final run).** In two runs at 06:35 and 06:38 UTC, one or two
  guest calls in the first turn failed with this error while later calls in the same turn worked: the first
  `shell` in one run, an `edit` and a `read` in the other. Four runs since (06:40, 06:41, 06:42 and the final
  07:58) did not show it. The backend was being edited between the failing and passing runs. It has not been
  reproduced or explained, and one clean final run does not show it is gone.
- **The instructions still describe a Code Mode browser catalog.** No `execute` tool is offered, so the model
  cannot call it, but the system prompt lists `tools.browser.*` (13 of 45 shown, including
  `tools.browser.preview({ path })`). The script records this as an observation, not a failure.
- **Host rails were not exercised.** With no `execute` tool the model made no browser or `fetch` call; it
  replied that it had no tool able to make them. The three host-rails checks therefore passed with zero
  attempts. This run shows the model is not offered those rails; it does not show that a browser or other host
  call would be refused at dispatch. That refusal is covered only by the server's unit tests, not by this check.
  The loopback listener recorded 0 requests; the script records that count as an observation and does not
  assert on it. In an earlier diagnostic run, when `execute` was reachable through a patched plugin copy, the
  guard refused both browser calls and Code Mode's own `fetch` did reach the host listener.

## History

- 06:40–06:43 UTC, 51 of 51 three times, before the last backend edits.
- 06:29 UTC, 24 of 36: the plugin's guard blocked Code Mode's `execute`, the only tool then offered, so no guest
  tool could run. Fixed since by offering the six tools directly in sandbox-only mode.
- 06:35 UTC, 33 of 36: tools ran; the catalog still included `execute` with the browser namespace.

## What the check does not cover

- Signed-in organization policy (`host_execution` deny), Settings and Den UI, packaged apps.
- Local MCP servers, computer use, child sessions, folder removal mid-session.
- Per-folder read-only grants: the read-only turn makes every bind read-only at once.

## Rerun

```bash
cd apps/server && infisical run --silent --env dev -- /opt/homebrew/opt/node@24/bin/node \
  --conditions=development --import tsx ../../evals/scripts/sandbox-model-check.ts --model fable
```

`--model sol` runs the same check against `gpt-6.1-sol`. Evidence JSON (checks, per-request model, usage, offered
catalog, tool traces) is written outside git, under the system temp directory in `opencode/sandbox-model-check/`.
The exit code is non-zero when any check fails.
