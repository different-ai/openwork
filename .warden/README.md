# Local Warden preflight

Prerequisites: Node 20 or newer and approved Pi/OpenAI credentials. The repository pins
the native CLI through `pnpm warden:check`; do not substitute a global install.

## Final review

Run journey checks first. Then assign one owner and record both refs:

```sh
git rev-parse HEAD
git rev-parse origin/dev
pnpm warden:check
git rev-parse HEAD
git rev-parse origin/dev
```

The bare config mode reviews committed branch changes against the configured
`dev` base. It is the final policy check; explicit `--git` or file mode does not
have the same fail policy. The working tree should be clean because unstaged
and untracked files are not reviewed. Do not commit unless the user authorized
it.

Only completed expected applicable skills, verified scope, and no blockers
means reviewed with no blockers. Exit 0 with no files or no matching triggers
is `Not reviewed` or `Not applicable`, with scope explicit, never clear.
Missing credentials, CLI/model errors, cancellation, or partial skill coverage
is `Incomplete`. Record the expected and actually reviewed skills, both
before/after refs, exact command, exit code, scope, and run reference. Keep
private analysis logs private; do not attach them to a public PR.

For quick iteration on authorized but uncommitted work, use:

```sh
pnpm warden:check --staged
pnpm warden:check --skill <name>
```

These are diagnostics only: `--staged` sees the index only, and `--skill`
provides partial coverage. Do not use `--fix`. After the last edit, rebase, base
update, policy change, or model change, rerun bare `pnpm warden:check` with all
applicable skills. Do not run it in every parallel subagent.

Finish with each native finding ID, classification, evidence, `Clear when`, and
disposition, plus the run metadata above. Reuse native IDs and deduplicate an
already-reported root cause; never invent durable advisory IDs. A suggested
reproduction is not an executed test. Local clearance never authorizes GitHub
approval, must not be cached across changes, and must not be pushed across
branches or worktrees as approval evidence.
