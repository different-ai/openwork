# Attached Managed-Web Canary

Operator-only, synthetic Daytona journey. This is NOT a normal PR/CI test and
does not provision infrastructure. The parent owns all sandboxes, credentials,
gateway/provider setup, egress isolation and teardown, including residue on failure.
The test owns only fresh, headed **local Chrome**, through the existing `chrome()`
builder. No Electron, headless-Web substitute, auth injection or API-driven chat.

## Parent Setup

- Use an isolated Den API/Web and the genuine managed-Web gateway from the exact
  integrated commit. All four supplied URLs must be bare HTTPS
  `*.daytonaproxyNN.net` origins, with no signed paths, queries or credentials.
  The parent must make these origins accessible to local Chrome and the worker.
- Seed one verified synthetic `.test` or `.invalid` email/password account in an
  otherwise empty org, with Web entitlement. No real account, billing or mail.
  Leave its Cloud worker unprovisioned: the first gateway visit must visibly
  provision it. Do not precreate the note or prefill a conversation.
- Configure the gateway's Den API/Web bootstrap, CORS/trusted origins and approved
  Web-handoff return origin for this isolated deployment. The test clicks the
  real gateway sign-in button, attaches the real Den popup, uses Email -> Next ->
  Password -> Sign in, and follows the actual handoff back to the gateway.
- Run the fixture below on the parent-owned control VM. Assign one organization
  model with display title **Canary**, model ID **cloud-web-canary**, an
  OpenAI-compatible chat-completions provider, base URL `${CANARY_MODEL_URL}/v1`,
  and the fixture key. Route title/compaction models here too. Disable all paid
  providers, production connectors/telemetry and unrelated outbound services.
- Use real OpenCode v1 with its advertised `write` and `read` tools, allowed in
  the canary workspace. Set Den `CLOUD_IDLE_STOP_MINUTES=1`; the default
  `CLOUD_IDLE_LOOP_SECONDS=60` fits the bounded four-minute wait. Keep the image
  version current to avoid testing an unrelated auto-update during wake.

## Environment And Commands

Parent supplies these environment variables securely, never in committed files:

| Variable | Meaning |
| --- | --- |
| `CANARY_DEN_API_URL`, `CANARY_DEN_WEB_URL` | Isolated Den origins |
| `CANARY_GATEWAY_URL` | Genuine Web gateway origin, not a worker preview |
| `CANARY_EMAIL`, `CANARY_PASSWORD` | Verified synthetic login |
| `CANARY_ORG_ID`, `CANARY_USER_ID` | Expected org and owning user ID (not membership ID) |
| `CANARY_WORKER_ID` | Optional expected worker ID; otherwise captured after UI provisioning |
| `CANARY_MODEL_URL`, `CANARY_MODEL_KEY` | Fixture origin and bearer key (at least 16 characters) |
| `CANARY_MARKER` | Unique synthetic 8-128 character identifier: letters, digits, `_`, `-` |
| `CANARY_WORKSPACE_PATH` | Worker directory; default `/tmp/openwork-workspace` |
| `CANARY_FILE_NAME` | Plain `.txt` filename; default `web-canary-note.txt` |
| `PORT` | Fixture listen port; default `8099` |

The fixture is a **single uploadable file**, uses only Node built-ins and never
opens a worker file, executes a command, forwards a model request or calls an
inference upstream. It binds `0.0.0.0` for the real worker to reach it. Start with
the parent-provided environment on the control VM (Node 24+):

```sh
node model.mjs
```

`GET /health` returns only `{ok:true}` without authentication. `/v1/models`,
`/v1/chat/completions` and read-only `/stats` require `Authorization: Bearer
${CANARY_MODEL_KEY}`. Stats expose counters and read hashes, not prompts, tool
arguments, file contents or keys. A fresh fixture process is required per run.
SIGINT/SIGTERM closes its listener; remote teardown remains the parent's job.

On the local Chrome machine, from the integrated worktree, after exporting the
table's variables:

```sh
pnpm install --frozen-lockfile
pnpm --dir evals install --frozen-lockfile
OPENWORK_EVAL_DAYTONA=0 OPENWORK_EVAL_LIVE=1 CANARY_CONSENT=isolated-synthetic-daytona pnpm evals:pr specs/cloud-web-canary.live.test.ts
```

This exact-name live lane bypasses E2E auto-placement/provisioning. The world
also refuses remote placement itself. Missing requirements skip as **Incomplete**;
an incorrect consent value or origin fails before Chrome launches.

Source-only checks (no canary resources or credentials):

```sh
node --check evals/worlds/fixtures/cloud-web-canary/model.mjs
node --test evals/worlds/fixtures/cloud-web-canary/model.test.mjs
pnpm --dir evals exec tsc --noEmit --strict --skipLibCheck --module preserve --moduleResolution bundler --target es2023 --lib es2023,dom,dom.iterable,esnext.disposable --types node,vitest/globals --allowImportingTsExtensions --allowJs --jsx react-jsx specs/cloud-web-canary.live.test.ts
```

## Proof Boundary

Worker-list requests respect the API's 50-row maximum. `workspacePath` is nullable
Den metadata; when present it must match setup, but a null value is not replaced
with an assumed directory. Workspace/session continuity comes from the browser
route and fresh correlated engine read result, not an independent filesystem
observation. The CLI restart receipt's `runtimeReachable` means
HTTP liveness only; successful tool execution is the later readiness gate.

### Explicit CLI-Managed Smoke

`CANARY_MODE=cli-managed` selects the separately named manual-restart journey in
the same spec. It does **not** prove automatic provisioning, Den idle-stop, or
automatic wake. The operator creates both VMs and a unique volume using only
the authenticated Daytona CLI; CLI credentials never leave that CLI. Seed a
healthy synthetic worker, matching runtime tokens and the real runtime endpoint
in the isolated Den. Set its image version to the pinned snapshot, give the
endpoint a future expiry, disable the Den idle loop, and point Den's provider
API at a loopback tripwire with an explicitly non-authenticating sentinel.

Also supply `CANARY_RUNTIME_URL` (the owned runtime's bare HTTPS preview origin),
`CANARY_WORKER_ID`, and `CANARY_CLI_LEDGER` (an owner-private JSON file outside
the checkout). The ledger declares `mode: "cli-managed"`, a unique
`prefix: "cwc-<8 lowercase hex digits>"`, and `createdSandboxes` containing
`{role, id, name}` entries for `control` and `runtime`. Names must be the prefix
plus `-control` or `-runtime`. CLI info must confirm both the exact ID and name
before a fixture operation. Keep the real bootstrap at
`/tmp/cloud-web-canary/start.sh` inside the owned runtime for restart. The control
VM's loopback port 8098 exposes read-only `/stats` with `{requests: number}` and
counts/rejects all provider requests; it must never simulate provisioning.

With Chrome navigated away, the named fixture action calls CLI stop, verifies
CLI info reports stopped, calls CLI start, relaunches that bootstrap and checks
real runtime health before returning to the UI. Worker GETs assert identity,
not physical lifecycle. The operator still owns teardown on every outcome.
No Den deprovision call may use the sentinel. Model/read-receipt assertions are
identical to the full managed journey. No skipped managed test is disguised as
a passed CLI result: exactly the selected scope runs.

The deterministic protocol issues one write, waits for its correlated engine
result, issues read, then validates the **new read result** before answering.
It selects the actual advertised tool names and argument schemas, not a shell
substitute. Unknown required parameters and mismatched reads fail closed.
It supports current and legacy OpenCode v1 numbered text-file output. A new user
turn always gets a new read call, even when its prompt repeats. Old-history
results cannot satisfy it. A two-second SSE split lets Chrome assert an actual
partial assistant answer before the completed answer.

The spec reloads the same route, navigates away (including the original login
opener), and observes Den's stored worker `healthy -> stopped -> healthy` through
GET `/v1/workers`. It never polls `/cloud/instance` or `/gateway/resolve`, which
can wake/provision workers. Reopening the conversation is the wake action.
The second response must follow a new read receipt with the original normalized
read-content hash (the observed line plus LF), without another write. The response
and hash both derive from the correlated tool result; neither independently
observes runtime file bytes. This covers real-engine read-result and session
continuity, not filesystem persistence after restart or wake, raw-byte equality,
or newline encoding. It also does not prove sandbox identity retention:
the asserted identities are worker, workspace and
session. Fixture `upstreamCalls:0` covers this fixture only; the parent's provider
configuration/egress controls own the environment-wide no-paid-calls boundary.

Protocol self-tests fabricate tool results and are **not** persistence proof.
No live verdict or screenshots are included. Parent must integrate first, run on
that exact head, inspect the live evidence, then tear down every owned resource.
