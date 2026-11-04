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
3. The first upload requires an engine prompt. “Allow once” is never saved.
   “Allow for session” remembers only the same canonical file version, Drive
   folder and account in the same chat and agent. A different file/version,
   destination, account, chat or agent asks again. The host must have witnessed
   that explicit session choice; a blanket pre-allowed rule cannot grant consent.
   Remembering requires an explicit `connectionId`; an unresolved default account
   remains single-request-only, since its identity can change between uploads.
   The engine still evaluates every request, so a later policy deny blocks it.
   Denial, a policy block, cancellation or a missing approval surface send nothing.
4. After approval, the host attaches a single-use exact-file capability to its
   internal extension request. This is a process-local `WeakMap<Request, …>`;
   no JSON input, HTTP header, model tool argument or persisted config can
   grant file access. The destination/account is bound to the same capability.
   Session rules retain the actual file path so path-scoped policy denies still
   apply, and add an opaque exact-match digest binding consent to the destination
   and file version. A saved path rule alone never grants upload consent. The
   approval card shows the actual path and destination. The
   host's consent witness lasts only for this bridge/engine lifetime. Approval
   panels offer “Allow for session” only when the engine provides a saveable
   scope, so one-request-only approvals no longer offer a non-working choice.
5. Multipart and resumable transport read the retained file handle. Identity
   and size/timestamps are checked after the prompt; replacement, symlink
   redirection or edits while waiting require a new request. The handle closes
   on success, rejection or failure. No folder is added to authorized roots.

Ordinary extension calls, older bridge embeddings without preflight, v1,
Gmail/Outlook attachments and Drive pull/push keep their existing root checks.
The normal server authentication, viewer rejection and managed-policy dispatch
remain in place. This fix does not send email, change sharing permissions, or
retry an uncertain upload.

## Long uploads and cancellation

The native upload bridge previously applied a **130-second total transfer
budget** after approval. This cancelled healthy large/resumable uploads and
surfaced as HTTP 499 “Request was canceled,” even though the person had not
pressed Stop. The prepared host dispatch had the same fixed budget.

Both Drive-specific total deadlines are removed. Each preparation/multipart
request and each resumable chunk/probe still has its existing two-minute
network bound. Progress stays within the **same** Google session; uncertain
writes are probed, not restarted as another file. The original caller's Stop
signal is preserved through both prepared and older root-bound dispatch.
Gmail/Outlook's small-attachment budgets and other app-read timeouts are unchanged.

Native activity now says “Couldn't upload … to Google Drive” instead of
“Couldn't drive upload.” No upload is automatically retried after cancellation.

## Verification

- `apps/server/test/approved-drive-upload.test.ts`: exact-file scope, destination
  binding, replay/forgery rejection, invalid/read-only files, replacement and
  edits, canonical symlinks, multipart and resumable bytes.
- `apps/server/test/opencode-v2-drive-upload-approval.test.ts`: canonical prompt,
  preflight before approval, denial/policy behavior, handle cleanup and session
  grant isolation by chat, agent, file version, destination and account,
  plus fresh-consent recovery after transport failure or policy revocation.
- `apps/server/test/drive-upload-session-approval-native.test.ts`: the real
  native engine saves the explicit session choice, repeats the same upload
  without prompting, and asks/denies another destination without sending bytes.
  No paid model or real Google account is used.
- `apps/app/tests/permission-approval-panel.test.tsx`: session approval appears
  only for saveable scopes; actual file paths are shown instead of rule hashes.
- `apps/server/test/drive-upload-duration.test.ts`: three real 45-second chunks
  complete after the old cutoff; the production preflight retains the exact
  caller signal without wrapping it in another total timer. Run separately:
  `pnpm --filter openwork-server test:drive-upload-duration` (about 135 seconds).
- `apps/server/test/drive-upload-stop.test.ts`: caller cancellation still reaches
  an active transfer on the shipping Node HTTP runtime. This Node check is part
  of `test:readiness`; Bun's in-process Node HTTP shim does not reproduce client
  disconnect cancellation, including on the clean previous-commit control.
- `apps/app/tests/engine-tool-sentences.test.ts`: Drive activity uses upload
  wording and a basename, never the noun “drive” as a verb or a full local path.
- `evals/proofs/opencode-v2-drive-upload.proof.test.ts`: real app/server/v2
  engine/Den, synthetic Google and model; declining sends nothing, approving a
  file outside every workspace puts the exact bytes in the selected account only.

No new feature flag: this repairs the existing per-file approval contract;
root-only extension callers are not broadened.

## Local validation (2026-11-04)

- Server and app typechecks: passed.
- Readiness: 108 Bun checks passed (21 files), plus the Node Stop check passed.
- Node 24 focused upload/approval suite, including the native engine: 39 passed,
  zero failures or skips.
- Wall-clock transfer regression: previous commit `95ca342129` cancelled at
  130,065 ms; the fixed branch confirmed all bytes after 135,054 ms, using one
  upload session and three progressing chunks. Both duration tests passed.
- Approval panel tests: 4 passed (`pnpm --filter @openwork/app test:approval-panel`).
- Native session test also runs independently with
  `pnpm --filter openwork-server test:drive-upload-session-native`; it used the
  installed OpenCode v2.2.0 binary. Set `OPENWORK_TEST_OPENCODE2` to test another
  binary; an absent binary is a reported skip, never a pass.
- Session-approval native regression: the same test failed on the initial
  workspace-access fix (`5447eaa38f`) because its permission `save` scope was
  empty, then passed with this follow-up. That control used the same Node,
  native engine binary, dependency links, and synthetic file/transport fixture.
- Spec lint: 141 files, zero errors.
- **UI proof incomplete:** the command
  `pnpm evals:e2e opencode-v2-drive-upload --local --engine v2` failed during
  fixture startup, before the upload scenario: the app remained at
  “Starting OpenWork” past the 60-second interactive deadline, with Vite module
  requests still pending. A clean `origin/dev` control at `2fff515e6b`, using
  the same proof/world and prerequisites, failed with the same startup
  signature. Neither run proves the upload scenario; a successful UI run is
  still required before treating the change as fully verified.
