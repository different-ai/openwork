# Daytona Server Sync Eval Report

Date: 2026-05-21
PR: https://github.com/different-ai/openwork/pull/1887

## Topology

- Server sandbox: `openwork-server-20260521-195504`
- Electron sandbox: `openwork-test-20260521-200726`
- Den Web: `https://3005-8a1fmav0r1lc67wb.daytonaproxy01.net`
- Den API: `https://8788-fsjfdaoh0xoklgyn.daytonaproxy01.net`
- Worker proxy: `https://8789-lex0iaxjjidavjfz.daytonaproxy01.net`
- Electron CDP: `https://9825-acrhqyxitcliiodm.daytonaproxy01.net`

The server sandbox ran MySQL, Den API, Den Web, and worker proxy. The Electron sandbox ran the real desktop app and talked to the server sandbox over Daytona preview URLs.

## Baseline Checks

- Den Web health: `GET /api/den/health` returned `{"ok":true,"service":"den-api"}`.
- Den API health: `GET /health` returned `{"ok":true,"service":"den-api"}`.
- Worker proxy: `GET /unknown` returned HTTP `404`, proving the proxy process was reachable.
- Electron CDP connected and `navigator.userAgent` contained `Electron/35.7.5`.

## Desktop Login

Result: pass.

- Created and verified a Den user on the Daytona server.
- Created a desktop handoff grant from Den API.
- Pasted the full `openwork://den-auth?...` link into the desktop Cloud Account manual sign-in flow.
- Electron showed `OpenWork Cloud Connected` and `Signed in as daytona-proof-1779419514@example.com`.
- Den API logs showed:
  - `POST /v1/auth/desktop-handoff/exchange 200`
  - `GET /v1/me/orgs 200`

Finding: raw one-time grant paste is fragile in split Den Web/Den API deployments because the manual flow only receives the grant and derives the exchange base from the configured Den Web base URL. Pasting the full deep link works because it carries the explicit `denBaseUrl`.

## User Pre-Population

Result: pass.

- Created organization `Daytona Sync Eval`.
- Invited and accepted two users:
  - `daytona-sync-user-1-1779420561@example.com`
  - `daytona-sync-user-2-1779420561@example.com`
- Verified from the Electron renderer using Den API fetch that the active org had `memberCount: 3` and included the owner plus both invited users.

Observation: the desktop Cloud Account page shows the active organization but does not expose a member list, so member sync verification was API-backed from the Electron runtime rather than a visible member-management UI.

## LLM Provider Sync

Result: pass.

- Created custom org LLM providers through Den API.
- Cloud Providers settings displayed the providers as available/imported.
- Direct provider list from Electron renderer took about `69ms`.
- A newly created provider appeared in the Cloud Providers UI after pressing Refresh in about `252ms`.
- After a local workspace was created, cloud-provider sync wrote providers into `/workspace/sync-eval/opencode.jsonc`.
- A provider created after workspace sync was imported into `opencode.jsonc` when opening the workspace Cloud Providers settings.

Observation: automatic interval sync is configured for `5 * 60 * 1000` ms. Immediate sync happens on sign-in, Den settings changes, workspace availability, and opening cloud-provider settings.

## Marketplace And Plugin Sync

Result: pass.

- Created plugin `Sync Eval Plugin 1779420801` through Den API.
- Created marketplace `Sync Eval Marketplace 1779420801` through Den API.
- Attached the plugin to the marketplace through Den API; attach returned HTTP `201`.
- Desktop Marketplace settings showed the marketplace and plugin immediately after navigation.
- Clicking Import succeeded and showed `Imported Sync Eval Plugin 1779420801 with 0 files. Reload workspace to apply config changes.`

Observation: the API allows adding a plugin to a marketplace, and the desktop marketplace UI can see and import it. This test used a metadata-only plugin with zero config files, so follow-up coverage should add a config object to prove non-empty file import.

## Issues Found

- Fixed in this PR: desktop cloud settings sync overwrote a custom Den API URL with the Den Web URL. This broke split Daytona Den Web/Den API topologies.
- Not fixed in this PR: raw manual sign-in grant paste does not reliably target the Den API in split Den Web/Den API deployments. Use the full `openwork://den-auth?...&denBaseUrl=...` handoff link for now.
- Follow-up recommended: add a non-empty plugin/config-object eval so marketplace import proves actual file materialization, not just plugin visibility and zero-file import.

## Commands And Checks

- `bash -n .devcontainer/test-on-daytona.sh`
- `bash -n .devcontainer/test-server-on-daytona.sh`
- `bash -n .devcontainer/start-daytona-server.sh`
- `bash -n .devcontainer/create-daytona-openwork-server-snapshot.sh`
- `pnpm --filter @openwork/app typecheck`
