# @openwork/evidence-provider

Chooses which sandbox provider runs evidence worlds (CI journeys and their
checkpoints) and reviewer previews, and defines what each provider must offer.

- `OPENWORK_EVIDENCE_PROVIDER=freestyle|daytona` selects it: a GitHub repository
  variable for CI (`pr-proof.yml`) and the same variable in the review app's
  environment. Unset means `freestyle`.
- `./checkpoint`: the checkpoint record stored in evidence reports. It names
  the provider that saved it, so old reports keep opening with that provider
  after the default changes.
- `./review`: `ReviewPreviewProvider`, what the review app calls to build,
  launch and open checkpoints.

Implementations: `@openwork/freestyle/review-provider` and
`evals/packages/env/src/freestyle-evidence.ts`. Daytona can be selected but
fails with a clear "not supported yet" error until its implementation lands.
