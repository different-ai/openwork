# Proofs

One-off evals an agent writes to prove one change on one PR:
`proofs/<name>.proof.test.ts`. They run only on demand (`gh workflow run pr-proof.yml --ref <branch> -f
pr=<number>`), never automatically, so delete one once its PR has merged. They follow the same lint as core journeys (`pnpm --dir evals
lint:specs`) except that they need no promise.

A proof is not maintained. If what it proves keeps mattering, fold its steps
into one of the core journeys listed in `../journeys.ts`.
