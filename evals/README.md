# OpenWork tests and test evidence

All new executable end-to-end coverage lives in
[`specs/**/*.test.ts`](./specs) and imports `test` from `@openwork/testkit`.
Tests that drive Electron, Den, or another app surface use `.e2e.test.ts`.
The legacy corpus under `flows/` is frozen compatibility coverage, not an
authoring path.

## Paved path

Use the skills in this order:

1. `write-a-spec`
2. `run-tests`
3. `diagnose-a-red-run` when the run fails
4. `publish-evidence` for the existing ambient test evidence

Demo-driven feature work still starts with `/voiceover`. Approve the narration
before code, create a fresh worktree, then translate its paragraphs directly
into `evals/specs/<slug>.e2e.test.ts`. Do not create a separate narration or
legacy-flow artifact.

## Install and run

`evals/` is a standalone pnpm workspace so its tooling cannot affect product
installs or image builds.

```bash
pnpm --dir evals install
pnpm evals:pr                      # app-less PR project
```

### CLI

Run the E2E lane with `pnpm evals:e2e [test-names...]`. Naming a test
auto-satisfies the opt-in flags declared in its source, but value-bearing
environment variables such as `OPENWORK_EVAL_MODEL` are never auto-set. Vision
judging is deferred by default; add `--with-llm-vision` to judge inline. Use
`--daytona` for Daytona resources, `--den <url>` to reuse Den, or
`--publish --pr <number>` to judge and publish existing evidence.

| Exit | Named test | Unfiltered E2E suite | Publish |
| --- | --- | --- | --- |
| `0` | Passed | Passed, or incomplete with expected skips | Published |
| `1` | Failed | Failed | Failed claims published, or publish failed |
| `2` | Incomplete because it skipped | Not used | Claims pending judgment |

Run one app-driving test through the E2E project:

```bash
OPENWORK_EVAL_E2E_TESTS=1 \
  pnpm --dir evals exec vitest run --config vitest.config.ts \
  --project e2e specs/<slug>.e2e.test.ts
```

Set `OPENWORK_EVAL_DAYTONA=1` to place supported resources in Daytona
sandboxes. Leave it unset for isolated local resources. See `run-tests` for
environment requirements and the cold-boot verdict check.

## Authoring contract

- Import `test` from `@openwork/testkit`.
- Name app-driving files `<slug>.e2e.test.ts`; app-less tests use `<slug>.test.ts`.
- Acquire resources in dependency order with `needs()` → `server()` → `app()`.
- Drive user-visible behavior and assert observable outcomes. Backend, file,
  and process checks may witness side effects but do not replace the journey.
- Bound every wait and declare external requirements in `needs()` so missing
  dependencies skip with a named reason.
- Assert both positive and negative sides of identity or permission boundaries.

## Composable packages and diagnostics

The packages under [`packages/`](./packages) are independently consumable, but
new executable coverage is always assembled as a test under `specs/`.

| Package | Owns |
| --- | --- |
| `@openwork/testkit` | test fixture plus `needs()`, `server()`, `app()`, mock, and placement resources |
| `@openwork/cdp` | raw CDP client, targets, `Surface`, and `attachSurface` |
| `@openwork/labs` | egress, identity-provider, release-feed, and mock-MCP labs |
| `@openwork/hosts` | local and Daytona hosts and `resolveHost()` |
| `@openwork/behaviors` | framework-free actions and observations over narrow handles |
| `@openwork/matchers` | pure findings over facts, with no I/O |
| `@openwork/test-evidence` | screenshot capture, visual validation, and ambient test-evidence recording used by testkit |
| `@openwork/timeline` | timing spans for long test journeys |
| `@openwork/test-artifacts` | index, render, and PR publication for completed test runs |

Because behaviors and matchers do not depend on a test context, they also power
the standalone diagnostic script:

```bash
node evals/scripts/diagnose.mts https://den.customer.example
```

It imports only `@openwork/behaviors` and `@openwork/matchers` and can point at
a real endpoint without creating test evidence.

## Ambient evidence and verdicts

The testkit fixture opens and closes a test-evidence recorder around each test.
Screenshots become test artifacts, visual validation records their expectations,
and assertion evidence carries witness assertions. Do not create or pass recorder handles.

Report `Passed` only when every claim has observable evidence in the test run.
A failed assertion is `Failed`; missing requirements, tooling failure, or
missing test evidence is `Incomplete` or a named skip. A green suite containing
skips is not proof.

Publish an already completed test run with the `publish-evidence` skill:

```bash
pnpm evals:e2e --publish --pr <number> [--test-run <path|directory-id|latest|name>]
```

`evals:e2e --publish` judges and publishes test evidence without rerunning tests.
Its optional `--test-run` argument selects an existing test run by path,
directory ID, record name, or `latest` at
publish time. Custom screenshots and recordings are supplementary and
never determine the pass/fail verdict.

## Standalone isolated Den

For an isolated Den API without Electron or Den Web, use the development helper:

```bash
pnpm --dir evals dev:den -- up --port 8891 --database openwork_den_my_eval --seed
pnpm --dir evals dev:den -- down --port 8891 --drop-database
```

The port and database are generated when omitted. The helper starts MySQL,
pushes the current schema, and prints the eval URL exports and teardown command.
It also adds the printed `OPENWORK_EVAL_DEN_WEB_URL` to the trusted origins;
without that origin, Better Auth rejects eval sign-in with
`403 INVALID_ORIGIN`.

## Daytona E2E tests

Start the maintained Electron sandbox path:

```bash
daytona organization use "<org-name>"
bash .devcontainer/test-on-daytona.sh [branch-or-commit] --artifacts-volume
```

Then run the selected `.e2e.test.ts` with both
`OPENWORK_EVAL_E2E_TESTS=1` and `OPENWORK_EVAL_DAYTONA=1`. Use direct CDP tools
only to explore or debug. Convert repeatable new coverage into a testkit test;
do not add a legacy flow. [`daytona-flows.md`](./daytona-flows.md) retains the
manual sandbox notes.

## CDP manual-debugging tools

The `opencode-chrome-devtools` plugin exposes these browser tools. Every call
takes `browser_url`; target-specific calls also use the selected target ID.

| Tool | Purpose |
| --- | --- |
| `browser_list` | list page targets on a CDP endpoint |
| `browser_navigate` | navigate a target |
| `browser_snapshot` | inspect the accessibility tree and stable UIDs |
| `browser_click` | click a snapshot UID |
| `browser_fill` | fill an input by UID |
| `browser_eval` | inspect state or run debugging JavaScript |
| `browser_screenshot` | capture a PNG checkpoint |

Use these calls for exploration and debugging, not as replacement verdict
evidence. Repeatable executable coverage belongs in a testkit test, where
observable assertions and validated screenshots are recorded as test evidence.

## Frozen legacy flow compatibility

The existing `evals/flows/**` corpus and `evals/runner/**` remain available only
for compatibility. The corpus is frozen:

- Deleting an obsolete flow is allowed.
- Adding, modifying, copying, renaming, or scaffolding a flow is forbidden.
- A user request for new coverage always goes to `evals/specs` and
  `@openwork/testkit`.

Only when a user explicitly requests an existing legacy flow, load the
`run-evals` or the deprecated `fraimz` compatibility skill and run that unchanged flow:

```bash
pnpm evals:legacy --list
pnpm evals:legacy --flow <existing-id> --cdp-url <electron-cdp-url>
pnpm evals:legacy:demo --flow <existing-id> --cdp-url <electron-cdp-url>
```

If the existing flow is broken or obsolete, report that limitation rather than
changing it. Legacy results continue to land under `evals/results/`; they do
not define the evidence contract for new work.

## Historical scenario notes

The remaining Markdown scenario documents describe existing product journeys
and manual debugging procedures. They are not templates for new executable
coverage. New automation derived from them belongs in `specs/`.
