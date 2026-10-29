# Terraform modules

Follow [MODULE_CONTRACT.md](MODULE_CONTRACT.md). Keep three native modules and
one shared contract; document platform exceptions instead of hiding them.

## Changes

- Test `init`, `validate`, and `test` on both Terraform and OpenTofu (>= 1.11).
  Use no tool-specific language or test features.
- Keep separate lock files per registry only in executable examples/roots.
  Select the matching lock and verify `init -lockfile=readonly` with each tool.
- Run one migration step before rollout. Application replicas never migrate.
  Failed or unknown outcomes block promotion; inspect before a deliberate retry.
- Keep secrets out of state where supported; document unsupported paths.
  Never rotate authentication/encryption keys by surprise. Guard existing
  deployments with explicit value preservation before conversion.
- The managed AWS installer consumes the shared AWS module with explicit
  legacy-secret compatibility mode. Never rotate existing keys or demote its
  strict current SecretVersion. Preserve native address moves/forget blocks and
  skip_destroy for core revisions; never add wildcard deregistration rights.
  Its runner must drain legacy tasks before strict promotion/migration, replan
  desired counts, and verify completed strict redeployment. Bootstrap permission
  changes require scoped grants, customer re-approval and installer-owner review.
  Direct users still default to write-only; managed live proof is separate.
- Keep provider/backend configuration in executable roots, not library modules.
- Use approved branches for stacked PRs; do not rewrite or push to their bases.
  Sign commits and include a DCO sign-off (`git commit -S -s`).

## Live-test hygiene

- Use authorized disposable infrastructure with an `exp-` prefix and a cost cap.
  Destroy and independently verify absence, including delayed/soft-deleted assets.
  Report estimates as estimates, not settled bills; never leave paid tests idle.
- Use test passwords no longer than 32 characters, with uppercase, lowercase,
  digits, and symbols. Respect sign-in rate limits; do not disable protection to
  recover a test or repeatedly retry rejected credentials.
- Run long applies/destroys detached, retain their PID/result, and wait on status
  rather than fixed sleeps. Expect cloud quota/capacity errors; inspect partial
  resources before retrying and verify cleanup after failed provisioning.
- Do not add desktop specs to module PRs. `evals/specs` is retired; follow the
  current repository proof conventions for any separately authorized app proof.
- Keep credentials, local state, account bindings, and private run artifacts out
  of commits and public evidence. Screenshots must contain only neutral content.
