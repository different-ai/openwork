# Approving a local file for Google Drive

The native v2 `openwork_drive_upload` tool accepts a workspace-relative path
or an absolute local file path. An absolute file does not have to be inside a
registered workspace. The person approves **that exact file and Drive
folder/account**, not access to the file's parent directory.

Previously, the engine asked for approval, then the host rejected an outside
file with `File was not found inside an authorized workspace root.` The
operation approval and the root-only file resolver were independent.

## Boundary

1. The host checks the file before showing the approval prompt. Relative paths
   still resolve inside configured workspace/authorized roots. Absolute paths
   resolve to a canonical regular file, whose path is shown for approval.
2. Preflight opens and checks the file but does not read or send its bytes.
   Missing/empty/invalid files fail before the prompt. Read-only hosts refuse.
3. A fresh engine prompt is required on every call. Denial, a policy block,
   pre-allowed rules, cancellation or a missing approval surface send nothing.
4. After approval, the host attaches a single-use exact-file capability to its
   internal extension request. This is a process-local `WeakMap<Request, …>`;
   no JSON input, HTTP header, model tool argument or persisted config can
   grant file access. The destination/account is bound to the same capability.
5. Multipart and resumable transport read the retained file handle. Identity
   and size/timestamps are checked after the prompt; replacement, symlink
   redirection or edits while waiting require a new request. The handle closes
   on success, rejection or failure. No folder is added to authorized roots.

Ordinary extension calls, older bridge embeddings without preflight, v1,
Gmail/Outlook attachments and Drive pull/push keep their existing root checks.
The normal server authentication, viewer rejection and managed-policy dispatch
remain in place. This fix does not send email, change sharing permissions, or
retry an uncertain upload.

## Verification

- `apps/server/test/approved-drive-upload.test.ts`: exact-file scope, destination
  binding, replay/forgery rejection, invalid/read-only files, replacement and
  edits, canonical symlinks, multipart and resumable bytes.
- `apps/server/test/opencode-v2-drive-upload-approval.test.ts`: canonical prompt,
  preflight before approval, denial/policy behavior and handle cleanup.
- `evals/proofs/opencode-v2-drive-upload.proof.test.ts`: real app/server/v2
  engine/Den, synthetic Google and model; declining sends nothing, approving a
  file outside every workspace puts the exact bytes in the selected account only.

No new feature flag: this repairs the existing per-file approval contract;
root-only extension callers are not broadened.

## Local validation (2026-11-04)

- Server typecheck: passed.
- Bun readiness suite: 105 passed, zero failures (21 files).
- Node 24 focused upload/approval suite: 35 passed, zero failures or skips.
- Spec lint: 141 files, zero errors.
- **UI proof incomplete:** the command
  `pnpm evals:e2e opencode-v2-drive-upload --local --engine v2` failed during
  fixture startup, before the upload scenario: the app remained at
  “Starting OpenWork” past the 60-second interactive deadline, with Vite module
  requests still pending. A clean `origin/dev` control at `2fff515e6b`, using
  the same proof/world and prerequisites, failed with the same startup
  signature. Neither run proves the upload scenario; a successful UI run is
  still required before treating the change as fully verified.
