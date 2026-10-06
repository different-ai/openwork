# Design review

Every evidence screenshot gets an advisory design review, so a layout problem
does not depend on the spec author noticing it. It never changes a test's
verdict.

Two passes, because each catches what the other misses:

| Pass | Reads | Catches | Needs |
| --- | --- | --- | --- |
| Measured | `NN-caption.layout.json`, written beside each screenshot by `screenshot()` | Text over text, a page wider than the window, row values drifting away from their names, columns a few pixels off, faint or tiny text | Nothing |
| Judged | The PNG, `rubric.md` and `DESIGN.md` | Rules a DOM cannot answer: header rows on plain lists, tinted status panels, dark selection outlines, internals in the viewport, copy rules | `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` |

`rubric.md` packs the rules from the team's **OpenWork Design** plugin
(`openwork-paper-design`, `paper-design-consistency-audit`,
`openwork-ui-source-map`, plus the craft skills) that a screenshot can show.
`DESIGN.md` is read as it is in the checkout, so a rule change applies to the
next review. When a plugin skill changes, update its section in `rubric.md` in
the same PR.

## Run it

```sh
pnpm evals:e2e <slug> --local                                # records screenshots with layout
pnpm --dir evals design:review -- --test-run latest          # both passes when a key is set
pnpm --dir evals design:review -- --test-run latest --no-vision
```

It writes `design-review.json` beside `test-run.json` and prints one line per
note. Fix `medium` notes or say in the PR why the screen is right as it is.

## In CI

The trusted `judge-vision` job in `pr-proof.yml` runs
`evals/scripts/design-review-journeys.mjs` after judging screenshot claims.
Notes go to the job summary and into the proof record; the review report shows
them on each screenshot (count in the gallery, outlined regions and the notes
in the viewer) and the evidence comment counts them. The step is
`continue-on-error`: a finding or a provider error never fails the job.
