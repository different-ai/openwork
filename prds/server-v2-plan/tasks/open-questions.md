# Open Questions

Agents should use this file when something needs human clarification but work can continue with a reasonable best guess.

## How To Use This File

- Prepend new entries under `## Open Items` so the newest item stays at the top.
- Record the uncertainty, the best guess, and the expected impact.
- Continue working based on the best guess instead of blocking the phase.
- When a human answers, update the existing entry with the resolution instead of creating a duplicate.

## Suggested Entry Format

```md
### Q-YYYYMMDD-XX - Short title
- Phase:
- Problem:
- Best guess used now:
- Impact if guess is wrong:
- Requested human input:
- Status: open
- Resolution:
```

## Open Items

### Q-20260415-04 - Windows SmartScreen and Defender behavior for extracted signed sidecars still needs a real Windows run
- Phase: 10
- Problem: Phase 10 now has an embedded Server V2 runtime path plus a Windows signing workflow, but this macOS/Linux session cannot verify whether SmartScreen or Defender still warns when the signed `openwork-server-v2.exe` extracts and launches signed child binaries on first run.
- Best guess used now: Stable per-version extraction plus pre-signed `opencode.exe` and `opencode-router.exe` should minimize repeated trust churn, but we still expect SmartScreen reputation to depend on the shipped executable's certificate history.
- Impact if guess is wrong: Windows first-run UX may still show avoidable warnings or noticeably slower startup until reputation or packaging adjustments improve.
- Requested human input: Run the documented Windows checklist on a clean Windows machine and record SmartScreen prompts, Defender behavior, and first-run versus second-run startup latency.
- Status: open
- Resolution:

### Q-20260415-03 - macOS notarization of extracted sidecars still needs a signed artifact validation run
- Phase: 10
- Problem: Phase 10 now has an embedded Server V2 runtime path, but this session has no Apple signing identity or notary credentials, so we cannot prove whether a signed/notarized `openwork-server-v2` can extract and launch its bundled sidecars without additional Gatekeeper prompts.
- Best guess used now: The safest release path is to preserve signatures on the extracted sidecar payloads before embedding and sign/notarize the final server executable separately, then validate the whole flow with `codesign`, `notarytool`, and `spctl` on macOS.
- Impact if guess is wrong: Release packaging may need different signing treatment for extracted children, different entitlements, or a different extraction/source layout.
- Requested human input: Run the documented macOS checklist with real signing credentials and confirm whether extracted sidecars launch cleanly after notarization.
- Status: open
- Resolution:

### Q-20260414-02 - Legacy direct-opencode remote workspaces still lack a full server-side credential import path
- Phase: 6
- Problem: Phase 6 now routes remote workspace sessions through Server V2 for `remoteType: openwork` and best-effort `remoteType: opencode`, but the Phase 2 registry import only persists bearer-style remote auth fields. Legacy direct-opencode remotes that relied on browser-held or non-imported credentials still cannot be driven fully through Server V2 without a server-readable auth handoff.
- Best guess used now: Server V2 treats `remoteType: openwork` as the supported remote session path for full Phase 6 migration, and supports `remoteType: opencode` only when the server registry already has usable bearer/basic auth material. The existing app-side direct remote connection path remains the compatibility fallback for any legacy direct-opencode workspace that still depends on missing credentials.
- Impact if guess is wrong: A later phase may need an explicit server-side import or handoff for additional remote auth material before every historical remote workspace can move fully behind Server V2.
- Requested human input: Confirm whether later phases should import more legacy remote-opencode auth material into the server DB, or whether direct-opencode remotes should be deprecated in favor of remote OpenWork workspaces.
- Status: open
- Resolution:

### Q-20260414-01 - Cloud signin state still lives in browser localStorage
- Phase: 2
- Problem: The current desktop app persists OpenWork Cloud signin state in browser localStorage (`apps/app/src/app/lib/den.ts`), which the standalone/server bootstrap path cannot read directly on disk in a portable way.
- Best guess used now: Server V2 owns the new `cloud_signin` table and can import cloud metadata from an explicit JSON handoff (`OPENWORK_SERVER_V2_CLOUD_SIGNIN_JSON`, `OPENWORK_SERVER_V2_CLOUD_SIGNIN_PATH`, or a future `openwork-cloud-signin.json` snapshot) when one is available; otherwise bootstrap records the source as unavailable and continues.
- Impact if guess is wrong: Later desktop migration work may need a different handoff shape or a direct server-side bridge from the app before existing cloud auth can move fully out of app-owned storage.
- Requested human input: Confirm the preferred Phase 4+ handoff path for current cloud signin state: explicit JSON snapshot, Tauri-to-server handoff command, or a different migration mechanism.
- Status: open
- Resolution:
