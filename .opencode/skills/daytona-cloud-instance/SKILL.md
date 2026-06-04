---
name: daytona-cloud-instance
description: Daytona cloud instance, Den server, OpenWork Cloud, Marketplace onboarding. Use when the user asks to run, launch, start, validate, or record a Daytona cloud/Den instance for OpenWork Cloud flows.
---

# Daytona Cloud Instance

Use this skill to launch or validate an OpenWork Cloud/Den Daytona server sandbox and collect useful URLs for desktop sign-in and Marketplace onboarding demos.

## Goal

Start the Den cloud stack in Daytona, confirm it is reachable, and return the URLs needed by Electron/Desktop validation.

## Fast Path

From the repo root, prefer the existing Daytona helper when available:

```bash
bash .devcontainer/test-on-daytona.sh $(git rev-parse --abbrev-ref HEAD) --server-only --artifacts-volume
```

If the branch is local-only, push it first or apply the local diff manually in the sandbox before validating.

If a sandbox already has manual patches, do not keep stacking new manual edits
on top of them. Either stash them in the sandbox and check out the pushed PR
branch, or create a fresh sandbox. A common safe sequence is:

```bash
daytona exec "$SERVER_SANDBOX" -- 'bash -lc '\''cd /workspace && git fetch origin <branch> && git stash push -u -m sandbox-manual-patch && git checkout -B <branch> FETCH_HEAD'\'''
daytona exec "$ELECTRON_SANDBOX" -- 'bash -lc '\''cd /workspace && git fetch origin <branch> && git stash push -u -m sandbox-manual-patch && git checkout -B <branch> FETCH_HEAD'\'''
```

## Expected Services

The Den server sandbox should expose:

- Den Web: port `3005`
- Den API: port `8788`
- Worker proxy: port `8789`
- Artifacts server: port `8090` when `--artifacts-volume` or recording is enabled

Get URLs with:

```bash
daytona preview-url "$SERVER_SANDBOX" -p 3005
daytona preview-url "$SERVER_SANDBOX" -p 8788
daytona preview-url "$SERVER_SANDBOX" -p 8789
daytona preview-url "$SERVER_SANDBOX" -p 8090
```

## Dev Auth Defaults

For local and Daytona cloud testing, run Den API with:

```bash
OPENWORK_DEV_MODE=1
```

In dev mode, email verification is disabled by default so seeded/demo users can sign in without a real inbox. Override explicitly when needed:

```bash
DEN_REQUIRE_EMAIL_VERIFICATION=true
DEN_REQUIRE_EMAIL_VERIFICATION=false
```

Production defaults to requiring email verification unless explicitly disabled.

Validate the escape hatch against Den API directly before recording UI:

```bash
curl -fsS -X POST "$DEN_API_URL/api/auth/sign-in/email" \
  -H 'Content-Type: application/json' \
  --data '{"email":"alex@acme.test","password":"OpenWorkDemo123!"}'
```

If this returns `403` asking for verification, Den API is not running the branch
or did not restart after the auth change. Restart Den API before recording.

## Health Checks

Validate the server before driving UI:

```bash
curl -fsS "$DEN_API_URL/health"
curl -fsS "$DEN_WEB_URL/api/den/health"
```

Validate seeded auth if present:

```bash
curl -fsS -X POST "$DEN_WEB_URL/api/auth/sign-in/email" \
  -H 'Content-Type: application/json' \
  --data '{"email":"alex@acme.test","password":"OpenWorkDemo123!"}'
```

If the Den Web proxy returns `503` but the direct Den API request succeeds,
continue debugging the proxy separately. Do not claim the browser sign-in path
passed from the direct API response alone.

## Den Web Mode

Prefer production Den Web for recordings. Next dev behind a Daytona proxy can
leave client-only pages stuck on server-rendered loading states or produce
origin/HMR problems.

Build and run production Den Web in the server sandbox:

```bash
daytona exec "$SERVER_SANDBOX" -- 'bash -lc '\''cd /workspace && pnpm --filter @openwork-ee/den-web build'\'''
daytona exec "$SERVER_SANDBOX" -- 'bash -lc '\''pkill -f "next dev --hostname 0.0.0.0 --port 3005" || true; pkill -f "next-server" || true'\'''
daytona exec "$SERVER_SANDBOX" -- 'bash -lc '\''cd /workspace && nohup pnpm --filter @openwork-ee/den-web exec next start --hostname 0.0.0.0 --port 3005 > /tmp/den-web-prod.log 2>&1 &'\'''
```

Then verify:

```bash
daytona exec "$SERVER_SANDBOX" -- 'curl -fsS http://127.0.0.1:3005/api/den/health'
```

If `daytona exec` appears to hang after starting `next start`, run a second
status command. The server may be running while the original shell remains open
because of background-process output handling.

## Desktop Den Session Bridge

The gold path is a real Den Web sign-in plus desktop deep-link handoff. If the
Daytona proxy breaks browser form submit or custom-protocol handling, you may
bridge only after proving direct Den API auth works, and you must report the
caveat in the PR evidence.

For a desktop Marketplace proof, inject the validated Den session into the
Electron renderer with the exact storage keys the app reads:

```js
localStorage.setItem('openwork.den.baseUrl', DEN_WEB_URL)
localStorage.setItem('openwork.den.apiBaseUrl', DEN_API_URL)
localStorage.setItem('openwork.den.authToken', TOKEN)
localStorage.setItem('openwork.den.activeOrgId', ORG_ID)
localStorage.setItem('openwork.den.activeOrgSlug', ORG_SLUG)
localStorage.setItem('openwork.den.activeOrgName', ORG_NAME)
window.dispatchEvent(new CustomEvent('openwork-den-settings-changed'))
window.dispatchEvent(new CustomEvent('openwork-den-session-updated', { detail: { token: TOKEN } }))
```

Use this only as a Daytona workaround. The final report must distinguish:

- Den API auth passed.
- Den Web/deep-link handoff was bridged because of Daytona proxy behavior.
- Desktop Marketplace sync/import behavior passed.

## Recording Flow

For founder/designer proof, record the actual journey:

1. Den sign-in page shows clear Cloud value proposition.
2. User signs in on Den.
3. Den dashboard explains Marketplaces contain plugins and assigned marketplaces sync to desktop.
4. Pretend download/open desktop handoff.
5. Desktop signed-out Marketplace nudge says OpenWork works without an account.
6. Desktop signs in to OpenWork Cloud.
7. Marketplace refresh shows `OpenWork Marketplace` and org marketplaces.
8. Built-ins show `Built-in`, with no install/remove actions.
9. A live org plugin installs and appears in My Extensions as `Connected`.
10. Workspace files materialize under `.opencode`.

Before every screenshot, check native overlays:

```bash
daytona exec "$ELECTRON_SANDBOX" -- 'bash -lc '\''DISPLAY=:99 wmctrl -l; ! DISPLAY=:99 wmctrl -l | grep -q "Authorize folder"'\'''
```

Do not publish a screenshot or video if a native folder picker is visible.

Also inspect at least one representative screenshot locally with the `Read`
tool or another image viewer before sharing links. Window-list checks are not
enough: a browser or app window can still obscure the claimed content.
