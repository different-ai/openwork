# Remove a saved legacy provider key

- Feature: `legacyProviderCredentialRemoval`
- Deployments: cloud and self-hosted
- Author: `yomgui`
- Default: **off**
- Status: implementation draft; executable proof and real screenshots are still required before review/rollout.

## What changes

On a shared legacy custom or catalog provider, **Remove saved key** removes the
organization credential without deleting the provider. Its row ID, definition,
credential mode, models, model-row identities, access grants and member bindings
are not rewritten. Native Gateway credentials, managed OpenWork providers and
`per_member` bindings are outside this action.

The focused `DELETE /v1/llm-providers/{id}/credential` route reads the row within
the active organization under a write lock, applies the existing provider-update
authorizer (permission holder or creator, including existing privileged-session
checks), and changes only `apiKey` and `updatedAt`. Already missing is a no-op204.
Concurrent clears serialize. Other provider edits keep their existing
last-write-wins semantics and may save a credential again, including an editor
that loaded the old credential before removal. Serialize configuration writers;
this action does not retrofit optimistic locking onto the full provider editor.
The existing route audit pipeline records `llm_provider.credential.remove` with
its normal outcome suffix and target provider; no secret payload is recorded.

Desktop sync stops receiving the organization key. It removes an old local copy
only while its hash still matches the last synced value. A different personal
local value is preserved. Offline/signed-out devices retain copies until sync.
This action does not revoke or rotate a key at the upstream provider.

## Try it in an isolated fixture

Enable the feature for a synthetic organization/member using the existing
platform-admin feature controls, then open **AI Gateway → AI Providers → Legacy
Providers** and a shared provider with a synthetic saved key. Select **Remove
saved key**, check the consent copy, cancel once, then confirm. Verify
**Credential missing**, the same provider/models/grants, and no upstream call.
Never use real credentials for the proof.

With the feature off, the saved-key action is locked with an availability reason
(DESIGN P4); the API answers404 `feature_disabled`. Without provider-update
permission/creator ownership it is locked with the existing permission reason,
and the server independently refuses the request.

## Disable / rollback

Use the central feature kill switch or turn the rollout off. New removal requests
are refused and the action is locked; stored provider state and completed removals
are not rolled back. A request admitted before disable may finish its credential
clear. No key is restored, no mode is changed, and no model/grant is deleted.
To restore a credential deliberately, an authorized manager uses the existing
provider editor. Disabling the feature does not revoke upstream keys either.

## Design and required evidence

Reuses Den's `ConfirmDialog` / Base UI AlertDialog (cancel focus, focus trap,
Escape, error retention, reauthentication handoff), `DenButton` secondary/loading
and destructive confirmation variants, `DenNotice` status/error feedback,
`permissionLockReason`, and the existing credential state. No new navigation,
modal system, colors or radius scale. DESIGN rules: P1, P4, P5, P8–P11, S2,
C1/C2/C5/C6, V2–V4. This is not a redesign of the existing legacy screen.

**Screenshots: NotRun / missing.** A real1440px headless Den proof must capture
flag-off, saved credential, confirmation, injected server failure/inflight, and
success. Do not substitute mock UI or a placeholder image.

Authored checks (not yet executed):

- `ee/apps/den-api/test/api/legacy-provider-credential-removal.api.test.ts`
- `apps/server/test/cloud-provider-credential-removal.test.ts`
- `evals/proofs/legacy-provider-credential-removal.proof.test.ts`

Before rollout: run those on the exact PR head in an admitted isolated lane;
generate/typecheck contracts without committing ignored outputs; run feature
checks and Mint validation/broken-links; attach real screenshots and the proof
report. Review the public guide's availability note with the deployment rollout;
there is no default-enable or release claim in this change.
