# Cloud admin-to-member assignment flows

End-to-end scenarios for proving an organization admin can assign cloud-managed
resources to another user, and the member desktop receives, understands, uses,
and loses access cleanly.

These flows should run against a Daytona Den server sandbox plus a real Electron
desktop sandbox through CDP. Prefer two desktop profiles or two Electron
sandboxes when validating owner and member UI simultaneously.

## Preflight

1. Start the Den server sandbox:
   ```bash
   bash .devcontainer/test-server-on-daytona.sh [branch-or-commit]
   ```

2. Start the member Electron sandbox against the printed Den URLs:
   ```bash
   bash .devcontainer/test-on-daytona.sh [branch-or-commit] \
     --den-base-url DEN_WEB_URL \
     --den-api-base-url DEN_API_URL \
     --record-video \
     --recording-name cloud-admin-to-member-assignment
   ```

3. Create or seed an org with:
   - Owner/admin account.
   - Member account.
   - A local workspace in the member desktop.

4. For provider evals, do not print API keys. Read the key inside the sandbox
   only when calling the Den provider creation API.

### Daytona setup notes

- Better Auth validates request origins. If a regenerated Daytona preview URL
  returns `403 INVALID_ORIGIN`, run Den auth setup from inside the server sandbox
  against `http://127.0.0.1:8788` with `Origin: http://localhost:3005`.
- If Electron was already started with stale Den preview URLs, restart Electron
  with the current Den URLs before member sign-in checks:
  ```bash
  daytona exec <electron-sandbox> -- 'bash -lc "kill <electron/opencode-pids> 2>/dev/null || true"'
  daytona exec <electron-sandbox> -- \
    "bash -lc 'cd /workspace && \
      OPENWORK_DEN_BASE_URL=DEN_WEB_URL \
      OPENWORK_DEN_API_BASE_URL=DEN_API_URL \
      DAYTONA_SECRETS_ENV=/tmp/no-daytona-secrets \
      bash /opt/openwork-daytona/start-daytona-electron.sh --detach'"
  ```
- Do not chain `pkill -f electron` with restart in one `daytona exec`; it can
  terminate the exec wrapper and leave CDP half-hung. Use direct PIDs or split
  kill/restart commands.
- Seeded display members may not have password auth. For a real member login,
  create an invitation as owner, sign up the member, mark the test email verified
  in the local Den DB when email delivery is not available, then accept the invite.
- The desktop member state can be bootstrapped for CDP-driven evals by setting:
  `openwork.den.baseUrl`, `openwork.den.apiBaseUrl`, `openwork.den.authToken`,
  `openwork.den.activeOrgId`, `openwork.den.activeOrgSlug`, and
  `openwork.den.activeOrgName` in localStorage, then reloading the renderer.

## Verified run: 2026-06-02

- Server sandbox: `openwork-server-20260602-154721`
- Electron sandbox: `openwork-test-20260602-155000`
- Org: `Acme Robotics`, `org_01kt58ejd1extvd0p7nqagxaky`
- Member email: `eval-member-1780444561@acme.test`
- Member org membership id: `om_01kt5c8w72fk4skf8bs9qywk9v`
- Assigned provider: `Assigned Member GPT-5.5 1780444660`
- Assigned provider id: `lpr_01kt5cc1xffk4skfds5gj880fb`
- Recording: `https://8090-yza3uc4rvulniu5q.daytonaproxy01.net/recordings/cloud-admin-to-member-assignment.mp4`

### Verified timings

- Member invite/create/accept path completed through Den API and local DB email
  verification workaround.
- Provider create + member assignment API: `485ms`.
- Member desktop sync after opening AI Providers: provider visible within `10s`.
- Member task execution returned `Assigned provider OK` in about `25s`.
- Provider deletion API: `309ms`.
- Member desktop removal sync after opening AI Providers: provider gone within
  `8s`.

### Verified UI signals

- Before assignment removal, Settings -> AI Providers showed:
  - `2 providers connected`.
  - `Assigned Member GPT-5.5 1780444660`.
  - `Cloud`.
  - `Imported`.
  - `openai · Credential ready · 1 models · managed provider`.
- Model picker showed `Assigned Member GPT-5.5 1780444660` with `GPT-5.5`.
- Session metadata used:
  ```json
  {
    "providerID": "lpr_01kt5cc1xffk4skfds5gj880fb",
    "modelID": "gpt-5.5",
    "variant": "medium"
  }
  ```
- After admin deleted the provider, Settings -> AI Providers showed:
  - `1 provider connected`.
  - only `OpenCode Zen` connected.
  - `No cloud providers are available for this org yet.`

## Flow 1: Admin assigns LLM provider, member uses it

**Goal:** A provider created by an admin becomes visible and usable by an
assigned member without manual workspace-file editing.

### Admin setup

1. Sign into Den as org owner/admin.
2. Create or invite the member account and ensure it belongs to the org.
3. Create an org-managed LLM provider with at least one usable model.
4. Assign the provider to the member directly or to a team containing the member.
5. Record the provider id, display name, model id, assignment timestamp, and API
   response duration.

### Member desktop steps

1. Sign into the desktop app as the member.
2. Select the assigned organization in Cloud Account.
3. Create or open a local workspace.
4. Open Settings -> AI Providers or Cloud Providers.
5. Refresh cloud providers or wait for auto-sync.
6. Verify the assigned provider appears with clear state:
   - Provider name is visible.
   - Badge or copy indicates it is cloud-managed.
   - Credential state says `Credential ready`.
   - Import/connected state is not ambiguous.
7. Click `Reload now` if shown.
8. Open the model picker and select the assigned cloud model.
9. Run:
   ```text
   Reply with exactly: Assigned provider OK
   ```
10. Verify the assistant response is exactly:
    ```text
    Assigned provider OK
    ```
11. Verify session metadata uses the cloud provider id (`lpr_...`) and model id.

### Expected outcome

- Member does not need to edit `opencode.jsonc` manually.
- Member sees a clear cloud-managed provider state and can select the model.
- Real task execution succeeds with the assigned provider.
- Permission boundaries remain clear: member can consume the provider but cannot
  create/edit org providers unless their role allows it.
- Record timing for assignment-to-visible and assignment-to-usable.

## Flow 2: Admin removes provider assignment, member loses access cleanly

**Goal:** Removing a provider assignment stops exposing the provider/model to the
member and leaves local providers untouched.

### Admin setup

1. Start from Flow 1 with a working assigned provider.
2. As owner/admin, remove the provider assignment or delete the provider.
3. Record removal timestamp and API response duration.

### Member desktop steps

1. Keep member desktop open.
2. Trigger provider sync by opening Settings -> AI Providers / Cloud Providers,
   switching org context, or waiting for the sync interval.
3. Click `Reload now` if shown.
4. Verify the removed provider disappears from:
   - Connected provider list.
   - Cloud provider imported/available list.
   - Model picker.
   - Workspace cloud-import metadata.
5. Attempting to continue with the removed model after reload should fail with a
   clear provider unavailable state, not silently use another provider.

### Expected outcome

- Removed provider is reconciled out of the workspace on the next sync.
- Member UI clearly shows the provider is gone or unavailable.
- Local non-cloud providers remain connected and selectable.
- Record timing for removal-to-gone.

## Flow 3: Admin assigns desktop policy, member UI updates clearly

**Goal:** A desktop policy assigned by an admin applies to the member UI without
an app restart and explains why actions are blocked.

### Admin setup

1. Sign into Den as owner/admin.
2. Create or edit a desktop policy.
3. Disable a visible capability such as built-in extensions.
4. Assign the policy to the member or to a team containing the member.
5. Save the policy and record the timestamp.

### Member desktop steps

1. Sign into the desktop app as the member.
2. Select the assigned organization.
3. Open Settings -> Extensions -> My Extensions.
4. Refresh desktop policy context by switching orgs, refreshing Cloud Account, or
   waiting for policy refresh.
5. Confirm blocked built-ins are absent from the normal catalog.
6. Click `Show hidden`.
7. Confirm blocked built-ins appear with `Disabled by organization`.
8. Reload the desktop app.
9. Confirm the policy applies immediately from cached desktop config before the
   network refresh completes.

### Expected outcome

- Member sees clear organization-controlled explanations.
- Blocked actions are hidden or disabled consistently.
- Policy persists across reload from cached desktop config.
- Network refresh updates the policy when available and preserves cached policy
  on transient failures.

## Flow 4: Admin removes desktop policy, member UI restores access

**Goal:** Removing a policy assignment restores member access without requiring
manual local cleanup.

### Admin setup

1. Start from Flow 3 with a policy applied.
2. Remove the member/team policy assignment or re-enable the disabled capability.
3. Save and record the timestamp.

### Member desktop steps

1. Keep the member desktop open.
2. Refresh desktop policy context by switching orgs, refreshing Cloud Account, or
   waiting for policy refresh.
3. Open Settings -> Extensions -> My Extensions.
4. Open the composer extension menu.

### Expected outcome

- Previously blocked built-ins return to normal UI.
- Composer extension shortcuts return.
- Existing local hidden/disabled preferences remain independent of org policy.
- Record timing for policy-removal-to-restored.

## Flow 5: Member permission boundary is clear

**Goal:** A non-admin member can consume assigned resources but cannot manage org
resources they do not have permission to administer.

### Steps

1. Sign in as the assigned member.
2. Open cloud resource management surfaces.
3. Verify assigned providers/marketplaces are visible and usable.
4. Attempt to create/edit/delete an org provider or policy through UI or API.

### Expected outcome

- Consumption is allowed for assigned resources.
- Management controls are hidden, disabled, or return a clear forbidden error.
- The UI does not imply that the member can fix admin-controlled assignment or
  credential issues locally.

## Required evidence

- Recording URL from the member desktop run.
- Assignment-to-visible, assignment-to-usable, removal-to-gone timings.
- Screenshots or recording segments showing clear member UI states:
  `Credential ready`, cloud-managed badge/copy, `Disabled by organization`, and
  removed/unavailable state.
- Confirmation that no secret values were printed or written into repo docs.
