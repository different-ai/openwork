# Headless inference attribution world (issue #5913)

This is a reusable, entirely local HTTP world, not an attribution helper unit test:

```text
synthetic authenticated principals
  → fake Den mintToken (trust boundary; see below)
  → selected checkout's createHeadlessRunnerClient
  → actual TCP HTTP runner API (@hono/node-server)
  → selected checkout's createRuntime / Runner / SQLite
  → actual TCP HTTP inference gateway fixture
```

`fixtures/inference-gateway.ts` implements OpenAI Chat Completions, Anthropic
Messages and OpenAI Responses, with JSON and SSE responses. It records the real
request method, path, body, model and headers. It does not patch global fetch,
inject a fake model adapter, or replace the runner HTTP API with `app.fetch`.

## Run

From the repository root, with the normal workspace dependencies already present:

```sh
pnpm --filter @openwork-ee/headless-runner exec tsx --conditions=development --test scripts/attribution-world.test.ts
```

The seven tests cover six real runtime cases (three protocols × configured/off)
and the standalone gateway fixture. Each runtime case sends five overlapping
turns, five non-streamed title calls, and a same-session anonymous follow-up:
**66 inference requests** across the six cases. A barrier holds the initial
streams until all five principals have reached the actual gateway, so concurrency
is observed rather than assumed from `Promise.all`.

To produce a machine-readable report, use the CLI:

```sh
pnpm --filter @openwork-ee/headless-runner exec tsx --conditions=development scripts/attribution-world.ts --expect attributed --report /absolute/path/to/branch-report.json
```

The report contains only synthetic member attribution and normalized request
facts; provider credentials and full prompts/headers are not exported. Runner
logs and the JSON report also go to stdout. A failed assertion exits nonzero;
`--report` is written only after every case passes.

### Same harness against a clean dev baseline

Prepare a detached checkout of the exact dev commit being compared. That
checkout needs resolvable workspace dependencies; reuse an existing pnpm store
or already-installed dependency links rather than doing a competing install.
Keep workspace links pointing into the **baseline checkout**, especially
`@openwork-ee/headless-protocol`; linking its entire node_modules directory back
to a branch can silently test a mixture of branch and baseline code.

No harness files need copying. Run this branch's harness with an **absolute**
source root (pnpm exec runs from the headless-runner package directory):

```sh
pnpm --filter @openwork-ee/headless-runner exec tsx --conditions=development scripts/attribution-world.ts --source-root /absolute/path/to/dev-checkout --expect anonymous --report /absolute/path/to/baseline-report.json
```

`--source-root` selects both the runner implementation and the protocol client's
source files, not only the runner. The same mintToken fake still issues synthetic
identity on the baseline; the baseline's unchanged client/runner drop it, so all
66 upstream requests must be anonymous, including when the new header env setting
is present. The normal branch expectation requires exactly six attributed
requests per configured protocol case (three members × turn/title), and no
attribution in the unconfigured cases. Running the baseline with
`--expect attributed` is an intentional red control: it must fail on the first
missing member header, not on setup, auth, or network errors.

## Assertions

- Three positive synthetic members (including two members of one organization and
  a member of another) keep their own identity on streamed turns and title calls.
- The fake Den's rollout-disabled principal and legacy/missing-identity principal
  remain anonymous even while other members have attributed requests in flight.
- No configured header means every request is anonymous, even when trusted Den
  issuance included identity.
- The selected turn alias and deployment-default title alias reach the upstream
  unchanged. Standard provider auth and JSON content-type remain present.
- An existing conversation's next turn without identity does not inherit the
  previous turn's identity. Its prior prompt is deliberately still in history.
- Member/user/org/email attribution, MCP token and provider key are absent from
  model request bodies, runner HTTP snapshots, and the real SQLite database and
  remaining sidecar bytes after close/checkpoint. The fixture uses ASCII identity
  markers, so byte/string checks detect their durable storage without relying
  solely on API filtering.
- An unauthenticated HTTP caller cannot submit identity: the API returns 401 and
  no extra inference request reaches the gateway. `session.owner` is deliberately
  unrelated to the synthetic identity and is not forwarded as an upstream header.

## Trust boundary and limits

**This is not live Den authentication or a production gateway integration test.**
The fake `mintToken` stands in for a trusted Den service that has already
authenticated a member, looked up organization membership, and evaluated its
rollout. It refuses principals outside its fixed synthetic registry, and returns
structured identity only for enabled members. It does not accept identity from
prompt text or session ownership. Den's real authorization, membership lookup,
feature evaluation and token/resume-grant issuance require their own tests.

The runner is authenticated with a fixed fixture service bearer token. Model
access uses a fixed fixture deployment key; this world does not provision a
customer gateway, call paid models, or exercise browser/computer/MCP tools,
resume-grant recovery, background tasks, redirect handling, or provider retries.
Those have separate focused tests. Captured headers live only in fixture memory;
the explicitly requested JSON report is evidence, not runner persistence.

Every case uses fresh ephemeral loopback ports and a separate on-disk database.
It ignores ambient production config by supplying an explicit env object. Polls
are deadline-bounded; turn timeout, stream barrier timeout and node:test deadlines
bound failures. Finally blocks stop the runner, force-close HTTP connections,
close SQLite and remove fixture scratch directories. No daemon, timer, real
credential, service resource or conversation survives a successful run.
