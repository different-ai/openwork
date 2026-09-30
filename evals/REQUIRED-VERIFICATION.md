# Required verification rollout

Invariant: selected evidence is not required verification. Twelve passing smoke
records cannot satisfy a planned history journey awaiting environment approval.
The stable **Required verification** check belongs to the current PR head, not the
default-branch SHA of a chained workflow.

## Trust and lifecycle

Product journeys' isolated authorization job reads default-branch controller code.
It validates the Warden workflow ID/path, repository, PR event, run attempt,
successful clearance and the single same-base-repository PR association against
the live PR API. It creates a pending check before planning or environment gates.
PR source is read as data only; no PR helpers or dependency hooks execute in this
credentialed job. Changes to existing guarded review machinery remain blocked.

The versioned receipt binds repository, PR/SHA, upstream and producer run/attempt,
policy and spec-level plan. Its digest is endorsed by an authenticated check write;
an artifact containing plausible IDs or hashes is not authority. Only the isolated
controller jobs receive checks:write. The completion controller separately validates
the producer, upstream, authorization job and endorsement before using results.
It checks exact-attempt job/step conclusions alongside spec outcomes, exact SHA,
placement and explicit engine constraints. Daytona also requires the sandbox SHA.
Duplicate, skipped, cancelled, missing or unresolved execution cannot pass.

Evidence review finalizes the check before optional presentation, including on
cancelled or failed producers, without needing review storage credentials. The
separate required-status sticky comment never replaces manual/selected evidence.
Missing receipts, API errors, unsupported chains and stale heads fail closed;
they may leave a pending check rather than manufacture a test failure or pass.
Rerunning only failed jobs without a new authorization receipt is incomplete:
rerun the entire Product journeys workflow. A new push needs a new current-head
check; an earlier head's success is not reused. Warden failure or an unresolvable
PR cannot produce a passing required check.

## Policy limits

Selection remains critical plus changed spec files. It does not infer semantic
relevance from arbitrary product code. This is spec-level verification, not a new
enumeration of every test, engine or world. Engine is required only when supplied
at spec execution level; case examples do not imply an engine matrix. Existing
manual and excluded dispositions remain in the authenticated plan and are not
counted as passing coverage. Unresolved required metadata is incomplete. Jev
remains advisory and cannot override the deterministic check.

## Enable enforcement only after validation

This change does **not** configure branch protection or bypass environment approval.
The new default-branch controller cannot securely validate its own PR through a
credentialed hosted preview. The secret-free PR job runs the focused contracts.
After merging, validate on a non-machinery PR: waiting for pr-slow-specs approval,
all required specs passing, failed/skipped/cancelled execution, full rerun with a
new attempt, a newer push, and manual evidence preservation. Confirm the actual
PR-head check, job links and required-status comment, including no evidence yet.
Only then should an administrator require **Required verification**, bound to the
GitHub Actions app. Do not require Evidence review or its optional publishing job.
If controller delivery/API access fails, repair/re-run trusted authorization or
completion; do not convert missing verification into success.
