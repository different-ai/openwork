# Demo factory — offline rehearsal specifications

Compose a reusable demo from YAML beats and generate a presenter script, a paste
map, and a structured execution plan. Everything checked in here is fictional.
This tool **does not run the product**, provision fixtures, sign in, read secrets,
contact connectors, post to Slack, or create Automations. It only reads local YAML
and writes local documents. No demo or production environment is needed.

## Quick start

From the repository root, with the repository's Node 24 and pnpm dependencies
installed (`pnpm install --frozen-lockfile`):

```sh
# On Homebrew Macs when another Node is first on PATH:
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
node --version

# Validate the manifest and all selected branches, without writing files:
node scripts/demo/factory/generate.ts --check

# Generate the eight-beat default employee sequence:
node scripts/demo/factory/generate.ts

# Also document optional branches, including unproven drafts:
node scripts/demo/factory/generate.ts --include-optional

# Use a different manifest or a fictional personalization overlay:
node scripts/demo/factory/generate.ts \
  --demo scripts/demo/factory/demos/acme-default.yaml \
  --personalization scripts/demo/factory/personalization.example.yaml \
  --out scripts/demo/factory/generated/personalized

node --test scripts/demo/factory/factory.test.ts
pnpm exec tsc --noEmit --strict --target es2023 --module nodenext \
  --moduleResolution nodenext --allowImportingTsExtensions --skipLibCheck \
  scripts/demo/factory/schema.ts scripts/demo/factory/compile.ts \
  scripts/demo/factory/generate.ts scripts/demo/factory/factory.test.ts
```

The CLI rejects unknown flags and invalid YAML with a nonzero exit code. Paths
supplied as arguments are relative to the current directory. Defaults are relative
to this tool, so the default manifest also works from another directory.
Dependencies are resolved from `apps/server` (its direct `yaml` and `zod`
dependencies); there is no separate install, new dependency, or build step here.
The local `package.json` only declares the module format.

## Generated outputs

Default output: `scripts/demo/factory/generated/<demo-id>/` (gitignored).
Generation replaces the three named files; use a separate `--out` directory when
you need to retain a previous version. Never point it at source files. Do not
commit generated customer-specific outputs or overlays.

| File | Purpose |
| --- | --- |
| `script.md` | Start-state checklist, surface assignments, sequence, per-beat **DO / SAY / PASTE / SEE**, checks, fallback, avoid list, Q&A, and reverse-order reset checklist. |
| `prompts.json` | Exact paste-name → rendered text map for the selected sequence; includes non-prompt paste values such as the fictional sign-in email. Never contains a resolved secret. |
| `plan.json` | Version 1, strict-schema declarative plan: desktops, readiness requirements, ordered actions and checks, dependencies, narration, expected results, timing, optional/draft labels, prompts, global audience/boundaries, and reset instructions. |

JSON is deterministic and has no timestamp or environment-derived values. The
plan is deliberately **not a browser runner**. Action and check types describe
what a future driver or a human must implement/verify; the compiler does not
assert that files exist, that a receipt is real, or that a setting is enforced.
`mode: declarative-only` and `live_proof: pending` make that limit explicit.

## Manifest and beat contract

`schema.ts` is the executable contract. Unknown keys fail rather than silently
becoming ignored instructions. Copy `demos/acme-default.yaml` and a small beat to
start a new fictional sequence.

A demo declares:

- `id`, `title`, and named string `variables` (`{{display_name}}`, etc.).
- `start_state.auth`: persona and signed-in/out state per surface.
- `start_state.retained`: expected prebuilt chats, files, Artifacts, Automations,
  and run states. These are requirements, **not evidence**.
- `start_state.facts`: named prerequisites that must be checked off before use.
- `beats`: ordered main sequence; `optional`: independent branches after main.
- `desktops`: unique desktop IDs, each owning one or more surfaces. These are
  logical assignments, not hosts or connection instructions.

A beat filename must match its `id`. Each beat supplies `surface`, `label`,
`status`, `requires`, optional `provides`, `do`, `say`, `paste`, `see`, `checks`,
`reset`, `fallback`, `expect_seconds`, `questions`, and `avoid`.

- Surfaces: `desktop`, `admin`, `workbot`, `slack`, `slide`.
- Labels: `REAL` (intended real product operation), `SEEDED` (prepared fictional
  content), `MOCKED` (explicit stand-in). Labels do not certify live proof.
- Status: `grounded` means authored/source-grounded, **not live-verified**;
  `draft` means pending rehearsal and is forbidden in the main sequence.
- Q&A entries contain either `answer` or a library `beat` reference, never both.
  Unselected targets are clearly marked as library-only: they do not auto-run or
  bypass prerequisite validation. Compose/revalidate a branch before presenting.

### Start/show dependencies

Use an `ask` with a globally unique `turn` and a paste-map `prompt` key. Set
`same_thread: false` to start a new chat, or return to a known chat before a
`same_thread: true` follow-up. Every started turn must eventually have an explicit
`wait_turn` and `show` referencing that turn, on the same surface. Other beats can
run between start and show; returning from an unrelated retained chat requires
`return_to_chat`. Checks referencing a turn require a prior wait. A generic
`show` without a turn is for retained/manual content and cannot satisfy a started
turn's show requirement.

Facts must exist before a beat requires them and cannot be overwritten by later
providers. Each optional beat must validate after main **on its own**, and the
combined optional sequence must also validate. This prevents accidental reliance
on an optional branch the presenter skipped. Main cannot rely on optional output.
A start/show pair must both be in main, or in one self-contained optional beat;
optional branches cannot finish an otherwise unfinished main turn.

Validation also catches duplicate IDs, references, prompt keys, surface/auth
assignments, unresolved or nested placeholders, missing paste refs, forward or
cross-surface turn refs, invalid action/check shapes, and unsafe output globs.
YAML aliases and duplicate mapping keys are rejected. Only selected beat text is
interpolated: unused library beats may require additional variables for another
demo, but their schema and Q&A target existence are always checked.

### Optional drafts are not live claims

The example keeps these distinct and outside the default sequence:

| Beat | Surface | Required future proof |
| --- | --- | --- |
| `workbot_chat` | Workbot | A new read-only reply in an isolated direct fixture conversation. |
| `workbot_in_sample_slack` | Slack | A reply in the approved isolated sample thread; not a desktop Slack connector read. |
| `cloud_automation_run` | Desktop | A retained successful Automation run with a durable **Cloud placement** receipt. A schedule or desktop run is not sufficient. |

Their readiness facts are explicitly `PENDING LIVE PROOF`. `--include-optional`
only includes rehearsal documentation; it neither supplies proof nor authorizes
posting/running anything. A saved Workflow is also an optional draft. None of
these were tested against a live service for this implementation. Other library
beats remain available without being inserted into the example by default.

## Personalization and safety

Use `personalization.example.yaml` for fictional overlays. Top-level display name,
employee/admin personas, and industry replace their corresponding variables;
`variables` applies last and may override only keys declared by the demo.
`audience_roles` and global `avoid` instructions appear in the script and plan.
Variable expansion is a single pass; nested placeholders are rejected.

Keep real personalization outside this public repo. Never put a password, token,
actual identity, customer reference, or production URL in these files or generated
outputs. `sign_in.secret_ref` is an opaque handle for a future approved sign-in
flow, not a credential; it cannot also be any selected paste-map key. This is not
a general-purpose secret scanner. Real sign-in and live proof are separate,
explicitly authorized work. Reset instructions are documentary and never run.

## Tests and scope

The Node test suite exercises the checked-in YAML, independent optional branches,
strict schema, cross-references, personalization, async turn lifecycle, secret
handle isolation from paste keys, deterministic outputs, and the actual CLI using
temporary directories. No network, model calls, live fixture preparation, browser
session, deploy, or production access is required. Run `pnpm check` separately for
the repository checks; the focused tests/typecheck above are not a substitute for
those checks or live product proof.
