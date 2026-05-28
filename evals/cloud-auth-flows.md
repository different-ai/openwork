# Cloud auth flows

End-to-end user flows for signing the desktop app into OpenWork Cloud through a
Daytona-hosted Den server. These flows should run against a real Electron app
through CDP, not a web-only build.

## Preflight

1. Start the Den server sandbox:
   ```bash
   bash .devcontainer/test-server-on-daytona.sh [branch-or-commit]
   ```

2. Start the Electron sandbox against the printed Den URLs:
   ```bash
   bash .devcontainer/test-on-daytona.sh [branch-or-commit] \
     --den-base-url DEN_WEB_URL \
     --den-api-base-url DEN_API_URL
   ```

3. Connect to the printed Electron CDP URL with `browser_list` and verify the
   target is the real desktop app:
   ```js
   navigator.userAgent
   ```
   Expected: contains `Electron/`.

4. In all flows, use the desktop Settings route unless explicitly stated:
   ```js
   window.location.hash = '#/settings/cloud-account'
   ```

## Flow 1: Cloud sign-in happy path

**Goal:** A signed-out desktop user signs into a Daytona Den server and sees the
connected cloud account in Electron.

### Setup

Create a Den Web account through the UI or through Den API. If using API setup,
read the dev OTP from `/tmp/den-api.log` in the server sandbox and complete email
verification before starting desktop handoff.

### Steps

1. Open Settings -> Cloud -> Account.
2. Verify the page shows `Signed out`, `Sign in`, `Create account`, and `Paste sign-in code`.
3. From Den Web, start a desktop handoff or create one through Den API:
   ```bash
   curl -H "authorization: Bearer $TOKEN" \
     -H 'content-type: application/json' \
     --data '{"desktopScheme":"openwork"}' \
     "$DEN_API_URL/v1/auth/desktop-handoff"
   ```
4. Paste the full `openwork://den-auth?...&denBaseUrl=...` link into `Paste sign-in code`.
5. Click `Finish sign-in`.

### Expected outcome

- Cloud Account shows `Connected`.
- The signed-in email is visible.
- The active organization appears if one exists.
- `localStorage.openwork.den.authToken` is present.
- Den API logs include `POST /v1/auth/desktop-handoff/exchange 200` and `GET /v1/me/orgs 200`.

## Flow 2: Raw code fallback

**Goal:** Verify whether pasting only the one-time grant works in the current
deployment topology.

### Steps

1. Start from a signed-out desktop session.
2. Create a fresh desktop handoff grant.
3. Paste only the `grant` value, not the full deep link.
4. Click `Finish sign-in`.

### Expected outcome

- In same-origin Den Web/API deployments, sign-in should succeed.
- In split Den Web/API deployments, this may fail with a clear user-visible error.
- No partial auth state is persisted when the exchange fails.

### Regression caught

This catches desktop manual-auth flows that derive the exchange URL from the
wrong base in split Den Web/API deployments.

## Flow 3: Expired or consumed handoff grant

**Goal:** A bad handoff grant fails safely.

### Steps

1. Complete Flow 1 with a grant so it is consumed.
2. Sign out from Cloud Account.
3. Reopen `Paste sign-in code`.
4. Paste the same full deep link again.
5. Click `Finish sign-in`.

### Expected outcome

- The UI shows a useful failure message.
- `localStorage.openwork.den.authToken` remains empty.
- The Cloud Account page stays signed out.
- Den API returns `404 grant_not_found` for the exchange.

## Flow 4: Cloud sign-out cleanup

**Goal:** Signing out removes cloud auth state without breaking local state.

### Steps

1. Start signed in from Flow 1.
2. Open Settings -> Cloud -> Account.
3. Click `Sign out`.
4. Navigate to Cloud Providers and AI Providers.

### Expected outcome

- Cloud Account shows `Signed out`.
- Cloud Providers requires sign-in or shows no org providers.
- Cloud-managed provider IDs (`lpr_*`) are not shown as connected local providers.
- Local providers such as manually configured OpenAI remain available if they existed before sign-out.

## Flow 5: Workspace-less cloud state

**Goal:** A user can sign in before creating a local workspace, but workspace
sync actions wait until a workspace exists.

### Steps

1. Start from the Welcome page with no selected workspace.
2. Navigate directly to `#/settings/cloud-account`.
3. Complete Flow 1.
4. Navigate to Cloud Providers and Settings -> Extensions marketplace.
5. Create a local workspace.
6. Reopen Cloud Providers and Settings -> Extensions marketplace.

### Expected outcome

- Account sign-in succeeds before a workspace exists.
- Provider/plugin import actions are disabled, hidden, or fail with a clear workspace-required message before workspace creation.
- After workspace creation, provider/plugin import actions become available.

## Flow 6: Org switch sync

**Goal:** A user in two organizations switches active orgs and the desktop cloud
tabs reflect the selected org.

### Setup

Create two orgs for the same account. Add at least one provider or marketplace
to each org with distinct names.

### Steps

1. Sign into Cloud Account.
2. Select Org A.
3. Open Cloud Providers and record the visible provider names.
4. Return to Cloud Account and select Org B.
5. Open Cloud Providers and Settings -> Extensions marketplace.

### Expected outcome

- Cloud Account shows the newly selected org.
- Cloud Providers no longer shows Org A-only providers.
- Marketplace no longer shows Org A-only marketplaces.
- Den API logs show provider/marketplace requests for the active org context.
