# Free Auto rollout

Signed-in free Auto requires the deployment master switch and an eligible organization enrolled in the rollout. Both Den and Gateway read the organization flag for issuance, status and each new request, including requests with previously issued keys. Turning enrollment off does not erase usage or prevent an already admitted response from settling.

- `INFERENCE_FREE_ENABLED=false` is the global kill switch (the default).
- `INFERENCE_FREE_ROLLOUT_ALL_ORGS=false` is the default: organizations are not enrolled until a platform administrator enables **Free Auto rollout** under **/admin → Organizations**.
- Enrollment is stored as `metadata.inferenceFree.rolloutEnabled`. Only allowlisted platform administrators can change it. Organization owners cannot enroll themselves.
- For a broad rollout, set `INFERENCE_FREE_ROLLOUT_ALL_ORGS=true` consistently on Den API and Gateway. This enrolls organizations without an explicit override. An explicit `false` still excludes an organization; `PATCH /v1/admin/organizations/:organizationId/free-auto` with `{ "enabled": null }` restores the deployment default.
- DPA restrictions, live Models subscriptions, `offerAllowed:false`, effective desktop policy and the weekly person-wide allowance still apply. Enrollment does not bypass them or change paid inference.
- Signed-out desktop access remains controlled by `ANONYMOUS_INFERENCE_ENABLED`; it has no organization. Keep that switch off during a signed-in organization pilot.

The admin row reports enrollment and shows “Enabled, deployment off” when the global master switch is off. Enrollment changes preserve unrelated metadata and record the platform administrator and previous state in the organization audit trail. Enable a test organization, verify signed-in Auto and allowance accounting, then disable it and verify an existing key can no longer start a request before changing the broad rollout default.
