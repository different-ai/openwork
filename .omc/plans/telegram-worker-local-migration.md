# Plan: Repoint Telegram worker `wrk_01kyx45mz8faqtqg395m0ghgbr` from Render to local worker via tunnel

**Status:** `EXECUTED 2026-08-01 ~19:40Z` — infrastructure complete and verified.
Endpoint is **https://openwork.sgctech.ai**, not a Quick Tunnel: all Cloudflare Quick Tunnels and
localhost.run failed (see §11). Remaining: Telegram chat pairing, which only the user can perform.
**Mode:** direct planning. Derived from `HANDOFF-local-worker-migration.md` plus live verification performed 2026-08-01 ~14:46Z.
**Machine:** Windows 11, PowerShell 5.1, repo `C:\cowork-openwork`.

---

## 1. Requirements Summary

Route Telegram traffic for `@adam_osus_bot` to the locally-running OpenWork server instead of the
Render deployment, by pointing `worker_instance.url` at an HTTPS tunnel that fronts
`http://localhost:10000`. Render remains the rollback target.

**Decisions taken (user-confirmed):**
- **Tunnel:** Cloudflare Quick Tunnel now to prove the path end-to-end; convert to a *named* tunnel
  as a follow-up for a stable hostname.
- **Cold start:** keepalive pinger, **no den-api code change and no redeploy**.

---

## 2. Verified state as of 2026-08-01 14:46Z (supersedes parts of the handoff)

| Item | Handoff said | Verified now |
|---|---|---|
| Local worker | "may no longer be running" | **Alive.** PID 33396 listening `0.0.0.0:10000`, uptime 8 477 541 ms (~2.35 h) |
| `/health` | — | `{"ok":true,"version":"0.18.12","opencodeVersion":"1.17.11"}` |
| Engine process | — | `opencode.exe` PID 27940 resident, ~161 MB |
| cloudflared | "not yet started" | **Two processes already running** — PID 28844, PID 49480 |
| Tunnel URLs | — | `primary-acting-messages-maintains` / `priest-bruce-furnished-bookmark`.trycloudflare.com |
| Tunnel reachability | — | **Both dead.** Edge `404` (CF-Ray present, no origin headers). Registered 13:07Z / 13:43Z, stale within ~1 h |
| den-api request timeout | *open question* | **Answered: 15 s.** See §3 |

**Consequence:** handoff Step 0 is already satisfied; Step 1 must start by reaping the two stale
cloudflared processes before launching a fresh tunnel.

---

## 3. Root-cause correction (highest-value finding)

`ee/apps/den-api/src/capability-sources/telegram-worker.ts`:

```
:13  const DEFAULT_REQUEST_TIMEOUT_MS = 15_000
:14  const DEFAULT_POLL_INTERVAL_MS   = 1_000
:15  const DEFAULT_PROMPT_TIMEOUT_MS  = 120_000
:179     signal: AbortSignal.timeout(input.requestTimeoutMs),
:342  const requestTimeoutMs = input.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
```

Every individual worker HTTP call is aborted at **15 s**. The dispatch chain and which calls hit the
engine (and therefore the cold-start window):

| Step | Call | Line | Hits engine? |
|---|---|---|---|
| 1 | `resolveWorkerTarget` → `GET /workspaces` | :223 | No — served by openwork server, ~50 ms even cold |
| 2 | `createSession` → `POST .../opencode/session` | :303 | **Yes** |
| 3 | `readSnapshot` → `GET .../snapshot?limit=100` | :323, :355, :364 | **Yes** |
| 4 | `prompt_async` → `POST .../prompt_async` | :382 | **Yes** |
| 5 | poll `readSnapshot` every 1 s, ≤120 s total | :386-:388 | **Yes** |

Observed engine cold start is 92–158 s, decaying (158 → 142 → 92 → 77 → 33 → ~0.056 s).
**Any cold engine fails at step 2 with a 502**, regardless of which host serves it.

This means the Render worker is most likely **not resource-starved** — den-api simply gives up at
15 s. Migrating to local hardware does not fix this by itself; it works only because a *warm* local
engine answers in ~50 ms, ~300× inside the budget. **Keeping the engine warm is the load-bearing
requirement of this migration**, not the tunnel.

`DEFAULT_PROMPT_TIMEOUT_MS = 120_000` is the overall reply deadline and is ample for MiniMax.

---

## 4. Acceptance Criteria

| # | Criterion | Test |
|---|---|---|
| AC1 | Exactly one cloudflared process runs, owning the active tunnel | `wmic process where "name='cloudflared.exe'"` returns 1 PID |
| AC2 | Fresh tunnel URL captured from log | `https://<slug>.trycloudflare.com` matched in logfile |
| AC3 | Tunnel reaches local worker | `GET https://<tunnel>/health` → HTTP 200, body byte-identical to `http://127.0.0.1:10000/health` **and** response carries origin headers (not a bare edge 404) |
| AC4 | Engine warm before repoint | `GET /workspace/ws_752b9be892bc/opencode/config` → 200 in **< 5 s** on a second consecutive call |
| AC5 | Keepalive running | Ping loop alive; engine `/opencode/session` stays < 5 s across ≥3 probes spaced ≥60 s |
| AC6 | DB repointed | `wi-update.js` prints `affectedRows=1`; AFTER row `url` equals the tunnel URL exactly, no trailing slash |
| AC7 | End-to-end delivery | Message to `@adam_osus_bot` produces a proxied request in `worker-stdout.log` **and** a bot reply in Telegram |
| AC8 | Rollback proven available | Render URL retained verbatim; rollback command staged and reviewed |

---

## 5. Implementation Steps

### Step 1 — Reap stale tunnels, launch a fresh Quick Tunnel
Kill PIDs 28844 and 49480 (both confirmed dead at the edge — safe to terminate; neither is the
session host process). Then launch one tunnel. **Flag is `--logfile`, not `--log-file`.**

```powershell
$cf = "C:\Program Files (x86)\cloudflared\cloudflared.exe"
$l  = "C:\Users\USER\AppData\Local\Temp\opencode\cf-fresh.log"
Remove-Item $l -ErrorAction SilentlyContinue
$p = Start-Process -FilePath $cf -ArgumentList @(
  "tunnel","--url","http://localhost:10000","--no-autoupdate",
  "--logfile",$l,"--metrics","127.0.0.1:0") -NoNewWindow -PassThru
Start-Sleep 25
Select-String -Path $l -Pattern "https://[a-z0-9-]+\.trycloudflare\.com" |
  % { $_.Matches[0].Value } | Select-Object -Unique
```
*Satisfies AC1, AC2.*

### Step 2 — Verify the tunnel truly reaches the origin
Do **not** accept a 200 alone — the stale tunnels returned a plausible-looking edge response.
Compare the body against localhost and confirm origin headers are present.
*Satisfies AC3.*

### Step 3 — Warm the engine
Single request with a ≥240 s timeout, then a second call to confirm it dropped to < 5 s.
Re-read `/workspaces` first if the engine must be addressed directly — **port and Basic-auth
credentials rotate on every server restart** (they were 54410, then 52740).
*Satisfies AC4.*

### Step 4 — Start the keepalive pinger
Background loop hitting `/workspace/ws_752b9be892bc/opencode/session` every 60 s so the engine
never re-enters the 92–158 s window while den-api's 15 s budget is in force. Must be started
**before** the DB repoint and must outlive this session.
*Satisfies AC5.*

### Step 5 — Repoint the database
```powershell
$env:NEWURL = "https://<fresh-tunnel-host>"
node C:\Users\USER\AppData\Local\Temp\opencode\wi-update.js
```
`UPDATE worker_instance SET url = ? WHERE worker_id = 'wrk_01kyx45mz8faqtqg395m0ghgbr'`.
Record the BEFORE row verbatim before proceeding — it is the rollback value.
*Satisfies AC6, AC8.*

### Step 6 — End-to-end test
Request a message to `@adam_osus_bot`; tail `worker-stdout.log` and report arrivals with durations.
If **no request arrives at all**, check the Telegram binding *before* suspecting the tunnel:
connection `tgc_01kyxyjnsdfk2at17j2nfd7wd2` was never re-verified as bound to
`wrk_01kyx45mz8faqtqg395m0ghgbr`, and the pairing link had expired.
*Satisfies AC7.*

---

## 6. Risks and Mitigations

| # | Risk | Likelihood | Mitigation |
|---|---|---|---|
| R1 | **Quick tunnel goes stale** — already observed twice within ~1 h. DB then points at a dead host and the bot is down with no fallback | **High** | AC3 verification; keep rollback staged; convert to named tunnel as agreed follow-up. Re-verify tunnel health immediately before declaring success |
| R2 | Engine goes cold → every message 502s at den-api's 15 s abort | High without keepalive | Step 4 keepalive; AC5 re-probes |
| R3 | Silent edge 404 mistaken for success | Medium | AC3 requires body match **and** origin headers, not just a status code |
| R4 | Telegram connection not bound to this worker | Medium | Step 6 checks binding before blaming the tunnel |
| R5 | Wrong process killed | Low | Only PIDs 28844/49480 (verified cloudflared via `wmic` command line). **Never** kill the argument-less `opencode.exe` — that hosts this session |
| R6 | Engine port/credentials rotated | Medium | Always re-read `/workspaces` before addressing the engine directly |
| R7 | PowerShell 5.1 footguns | Medium | No `-Environment` on `Start-Process`; never use `$host`; keep commands short — long one-liners fail silently |
| R8 | Secret leakage | Low | Reference secrets by source only. **Rotate the ngrok authtoken** (leaked plaintext into its own error log) and the Render API key if this session is shared |

---

## 7. Verification Steps

1. `wmic` shows exactly one cloudflared PID.
2. Tunnel `/health` body byte-matches localhost `/health`, with origin headers.
3. Two consecutive engine `config` calls: second < 5 s.
4. Keepalive probes at ≥60 s spacing all < 5 s.
5. `affectedRows=1`; AFTER row equals the tunnel URL.
6. `worker-stdout.log` shows the proxied request chain (`/workspaces` → `session` → `snapshot` → `prompt_async`) and Telegram shows a reply.

---

## 8. Rollback

```powershell
$env:NEWURL = "https://den-worker-telegram-worker-wrk-01ky.onrender.com"
node C:\Users\USER\AppData\Local\Temp\opencode\wi-update.js
```
Then stop the tunnel and keepalive. Note: reverting to Render restores the *previous broken
behaviour*, since per §3 Render fails the same 15 s budget on a cold engine — rollback restores the
prior state, it does not restore a working bot.

---

## 9. Out of Scope / Follow-ups

- **F1 — Named Cloudflare tunnel** (agreed): stable hostname, DB row set once, survives restarts.
- **F2 — Hindsight recall is broken on Windows.** `uvx hindsight-embed@latest` misdetects Git Bash as
  `linux-amd64`, installs a Linux binary to `/home/sgctechai/.local/bin`, then looks for it at
  `C:\Users\USER\.local\bin\hindsight` / `C:\Users\USER\.hindsight\bin\hindsight` (both absent), so the
  `127.0.0.1:9077` daemon never starts and `agent_knowledge_recall` hangs. Likely fix: set
  `hindsightApiUrl` to the existing hermes/`.pg0` instance. Also: this session's MCP connection is
  dead (`-32000`) and needs a reconnect.
- **F3 — Raise `DEFAULT_REQUEST_TIMEOUT_MS`** (`telegram-worker.ts:13`) so a cold engine survives.
  Deliberately excluded here (needs a den-api redeploy) but it is the only fix that repairs the
  Render worker too.

---

## 11. Execution outcome (2026-08-01)

**Tunnel strategy changed mid-execution, with user approval.** Every ephemeral tunnel failed:

| Attempt | Result |
|---|---|
| Cloudflare Quick Tunnel × 3 (quic) | registered cleanly, then edge `404`; only 1 of 4 connections each time |
| Cloudflare Quick Tunnel (`--protocol http2`) | identical — disproved the QUIC hypothesis |
| localhost.run | TLS connected, connection dropped, no HTTP response |

Failures reproduced **from an independent external network** (contabo-old), so they were not local.
The Host-header hypothesis was also eliminated: the worker returns 200 when called with the tunnel's
Host header.

**Final architecture** — permanent, not ephemeral:

```
Telegram -> den-api (Render) -> https://openwork.sgctech.ai
              -> nginx on contabo-old (Let's Encrypt, expires 2026-10-30)
              -> 127.0.0.1:10010  (reverse SSH tunnel)
              -> Windows host 127.0.0.1:10000  (openwork server)
              -> managed opencode engine
```

Verified: `/health` 200 in 0.68 s with true origin headers; `/workspaces` 200 returning
`ws_752b9be892bc`; `/opencode/config` 200 in 801 ms then 453 ms; worker log shows engine calls at
40-71 ms. All far inside den-api's 15 s budget. DB `affectedRows=1`, AFTER row correct.

`openwork-worker-supervisor.ps1` supervises the reverse tunnel **and** warms the engine every 60 s.

### Outstanding
- **Telegram chat pairing.** `telegram_chat_binding` has 0 rows, so `telegram.ts:232-233` returns
  early and never reaches `runTelegramWorkerPrompt` (:270). A message today replies *"This private
  chat is not paired with OpenWork."* User must create a pairing link in OpenWork Connect.
  (The `telegram_connection` binding to this worker **was** verified correct — that caveat is closed.)
- **Supervisor task registration was blocked** by a permission classifier. It runs in this session
  only and will not survive a reboot until registered.
- **Secrets in plaintext**: `check-tg-state.js` holds TiDB credentials, `wi-update.js` holds a Render
  API token, both under `%LOCALAPPDATA%\Temp\opencode`. Rotate and clean up, along with the ngrok token.

## 10. Open Assumption

`wi-update.js` was written by the previous agent and has not been re-read this session. Step 5 should
begin by reading it to confirm it still targets the correct row and prints BEFORE/AFTER as described.
