# Evidence Roll Program

Reuse what the spec lane already records — `photoRoll` — and add the two
missing adapters: a collection view across all rolls, and a PR publisher with
a thin skill. Leave schema room for live Daytona handoffs and resumable rolls.

## What already exists on dev (verified at 3e052843f)

`@openwork/fraimz` ships three proof primitives (#3322, #3359):

- `screenshot(surface)` → `Shot { png, hash, route, at }`
- `validate(shot, expectations)` → `SeenFacts { ok, description, results:
  [{ expectation, passed, evidence }], model, cached }` — vision-graded
  per-claim assertions with an on-disk cache
- `photoRoll(name)` → per-run roll: `add(shot, seen?)` writes
  `NN-<caption>.png` (pixel-hash dedupe, caption = first expectation);
  `close()`/dispose writes **`roll.json`** (summary + frames with per-
  expectation PASS/FAIL) and a self-contained **`index.html`** under
  `evals/results/rolls/<stamp>-<name>/`

Slow specs already produce rolls (app-smoke, first-run-local,
first-run-cloud-share, models-available, app-den-tls-fault, …). **`roll.json`
is the record layer.** The flow lane (`evals/runner`) is deprecated; its blob
upload + gh posting knowledge in `runner/reporters/pr.ts` gets lifted, not
imported.

## Gaps this program closes

1. No way to see rolls *collected* — each roll has its own index.html, but
   there is no roll-of-rolls.
2. No way to put a roll on a PR.
3. No reserved room for "agent drives to the iteration point, human takes
   over on a held Daytona surface".

## Architecture

```
 CAPTURE   spec lane: screenshot + validate + photoRoll          (exists)
 RECORD    roll.json per roll                                    (exists)
 RENDER    pure: roll.json[] → collection html · roll.json → PR markdown  (S1)
 PUBLISH   local collection index · PR sticky comment            (S1)
           living Daytona index · held-surface handoff           (S2)
```

Rules: capture never knows where evidence goes; renderers/publishers never
know where it came from; unknown fields in roll.json are ignored, never fatal.

## Slices

### S1 — collect + publish (this PR)

New package `evals/packages/evidence` (`@openwork/evidence`, zero new npm
deps):

- `scanRolls(resultsDir)` — read `rolls/*/roll.json` (validating reader,
  tolerant of unknown fields); legacy result dirs (fraimz.html / loose pngs)
  become minimal read-only entries.
- `renderCollectionHtml(entries)` — the photo roll of photo rolls:
  newest-first, one card per roll (name, date, pass/fail summary badge, first
  frame as thumbnail, link to the roll's own index.html). Written to
  `evals/results/rolls/index.html`.
- `renderPrMarkdown(roll, urls)` — claim → screenshot gallery with
  per-expectation PASS/FAIL, roll summary, repro footer; wrapped in a
  `<!-- photo-roll -->` sticky marker.
- `publish-pr` — upload the roll's PNGs to Vercel Blob
  (`BLOB_READ_WRITE_TOKEN` env, Infisical fallback — pattern lifted from the
  deprecated `runner/reporters/pr.ts`), then create-or-update the single
  sticky comment via `gh`. `--dry-run` prints the markdown. Without a token:
  post verdicts-only and say so in the comment.
- CLI: `pnpm --dir evals run roll` (build collection, `--open`) and
  `pnpm --dir evals run publish:pr -- --pr <n> [--roll <dir|name>] [--dry-run]`
  (default: newest roll).
- Skill `.opencode/skills/pr-photo-roll`: judgment only — pick the roll,
  never post an image `roll.json` cannot attribute, then shell the CLI.
- Additive capture metadata: `photoRoll` records `gitSha`/`branch` in
  roll.json (small, optional fields; renderers tolerate absence).

#### S1 results — PASSED (verified 2026-08-01, branch `feat/evidence-roll`)

- Unit lane: `pnpm --dir evals run test` → **108 pass / 0 fail** (scan,
  renderers, publisher dry-run with injected stubs, and real-writer
  compatibility: a roll produced by the actual `photoRoll()` API reads back
  through `scanRolls`). `pnpm --dir evals run typecheck` clean.
- Real end-to-end: `hosts.chrome()` (headless, real CDP) rendered the
  generated collection page, `screenshot()` captured real pixels,
  `validate()` (OpenAI vision) graded both expectations **PASS**
  ("collection lists at least one roll card", "card shows a pass/fail
  badge"), `photoRoll` recorded roll.json + per-roll index.html; collection
  rebuilt with the new roll included. Publisher then posted the sticky
  gallery to this program's own PR with Blob-hosted images (see PR).
- Environment finding, out of scope here: `hosts.desktop()` local spawn on
  this Mac brought up Electron CDP but no page target within 120s (twice) —
  the app-spec path's home remains the warm Daytona nightly
  (`OPENWORK_EVAL_APP_SPECS=1`).

### S2 — living index + handoff

Permanent Daytona sandbox serving an append-only archive of roll dirs;
`publish:daytona` pushes a roll and regenerates the same collection html.
Reserved roll.json fields (documented now, written later): `surfaces:
[{ id, kind, cdpUrl?, novncUrl?, apiUrl?, sandboxId?, holdUntil? }]` and
frame/roll-level `handoff { surfaceId, instructions, credentialsHint }`.
Hold semantics: a provisioned surface skips teardown, stamps `holdUntil`,
and the PR/index renders "continue from here" (noVNC + seeded creds only —
never bearer tokens; TTL mandatory).

### S3 — resumable rolls

Optional Daytona snapshot per frame (`snapshotRef`) so every photo gains
"resume from this exact state"; video shots as an additional capture kind.

## Risks

1. Blob token availability — env → Infisical fallback; degrade to
   verdicts-only comment, stated in the comment body.
2. Comment noise — one sticky comment per PR, edited in place.
3. roll.json drift — reader is tolerant; version field added additively if a
   breaking change is ever needed.
