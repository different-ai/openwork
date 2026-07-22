# First-connection Windows Daytona validation — 2026-07-21

Verdict summary:

- W1: Passed.
- W2: Passed.
- W3: Passed.
- W4: Skipped after feasibility checks; no Node/pnpm/bun toolchain or Electron/OpenWork desktop build was present in the Windows sandbox. The Windows-specific bootstrap write path was proven by W1/W2, and the desktop read path was covered by the local `workspace-store` unit test run listed below.

## Sandboxes and branch

- Branch: `feat/first-connection`
- Fix commit pushed during validation: `13e70876f fix(den-api): stamp generic Windows installer downloads`
- Server sandbox: `openwork-server-20260721-141157` (`8682df2a-977c-4bfd-944f-aa957d417346`)
- Windows sandbox: `c42adfa5-1c6e-443b-9087-18dda9768384`
- Den Web: `https://3005-06rjegvkz6agvqbc.daytonaproxy01.net`
- Den API: `https://8788-vxaw8posr6bfnp0a.daytonaproxy01.net`
- Worker proxy: `https://8789-kh8e5tmvlpjspw4v.daytonaproxy01.net`
- Seeded org: `Acme Robotics`, `org_01ky38k960f688xzbf4fqjxbak`
- Initial install token: `xmpart_mIQhf8LAR3HXo7fD9vQLyw_u9kbNU9LB7AfQ`
- Rotated replacement token: `mBfpLaI7isovx4oA6kwoR1DLdpE-hYD13_8hHqS-bR4`

## Setup evidence

Started the public Den server sandbox:

```sh
bash .devcontainer/test-server-on-daytona.sh feat/first-connection
```

Result: server ready with public preview URLs above.

Built and uploaded the Windows generic installer:

```sh
pnpm --filter @openwork/install-config build
bun build --compile --target=bun-windows-x64 --minify apps/installer/src/index.ts apps/installer/src/server-worker.ts --outfile apps/installer/dist/openwork-installer-win-x64.exe
gh release create first-connection-win-installer-20260721141511 apps/installer/dist/openwork-installer-win-x64.exe --repo different-ai/openwork --prerelease --title first-connection-win-installer-20260721141511 --notes "Temporary first-connection Windows installer validation asset."
daytona exec openwork-server-20260721-141157 -- "bash -lc 'curl -L -o /workspace/.openwork-daytona/installer-artifacts/openwork-installer-win-x64.exe https://github.com/different-ai/openwork/releases/download/first-connection-win-installer-20260721141511/openwork-installer-win-x64.exe'"
```

Result: `/workspace/.openwork-daytona/installer-artifacts/openwork-installer-win-x64.exe`, 115,567,616 bytes.

Seeded Acme Robotics:

```sh
daytona exec openwork-server-20260721-141157 -- 'bash -lc '\''cd /workspace && pnpm --filter @openwork/email build && cd /workspace/ee/apps/den-api && OPENWORK_DEV_MODE=1 DEN_ORG_MODE=multi_org DATABASE_URL=mysql://root:password@127.0.0.1:3306/openwork_den DEN_DB_ENCRYPTION_KEY=daytona-den-db-encryption-key-please-change-1234567890 BETTER_AUTH_SECRET=daytona-den-auth-secret-please-change-1234567890 BETTER_AUTH_URL=https://3005-06rjegvkz6agvqbc.daytonaproxy01.net DEN_API_PUBLIC_URL=https://8788-vxaw8posr6bfnp0a.daytonaproxy01.net pnpm exec tsx scripts/seed-demo-org.ts --reset'\'''
```

Result excerpt:

```text
den demo seed · Acme Robotics
✓ org: org_01ky38k960f688xzbf4fqjxbak
✓ 17 members · 12 teams · 3 pending invites
✓ marketplace: mkt_01ky38k985f688xzzbadkpqpg5
✓ done in 11.4s
→ login: alex@acme.test / OpenWorkDemo123!
```

Verified install config returned Acme and public preview URLs:

```sh
curl -sS 'https://8788-vxaw8posr6bfnp0a.daytonaproxy01.net/v1/install-config?token=xmpart_mIQhf8LAR3HXo7fD9vQLyw_u9kbNU9LB7AfQ' | python3 -m json.tool
```

```json
{
  "appName": "OpenWork",
  "clientName": "Acme Robotics",
  "webUrl": "https://3005-06rjegvkz6agvqbc.daytonaproxy01.net",
  "apiUrl": "https://8788-vxaw8posr6bfnp0a.daytonaproxy01.net",
  "requireSignin": true,
  "logoUrl": null,
  "iconUrl": null
}
```

The first server route check exposed a real bug: `/v1/install/win-x64` redirected to the versioned desktop app (`openwork-win-x64-0.17.30.exe`) instead of serving the mounted generic installer with the filename tag. I fixed and pushed `13e70876f`, restarted the Den stack from that commit, and rechecked:

```text
HTTP/2 200
content-type: application/vnd.microsoft.portable-executable
content-length: 115567616
content-disposition: attachment; filename="OpenWork-Installer--8788-vxaw8posr6bfnp0a.daytonaproxy01.net--xmpart_mIQhf8LAR3HXo7fD9vQLyw_u9kbNU9LB7AfQ.exe"
body bytes 115567616
first bytes b'MZ'
```

Created Windows sandbox and downloaded the stamped filename using `curl.exe -L -OJ` from PowerShell:

```powershell
$url="https://8788-vxaw8posr6bfnp0a.daytonaproxy01.net/v1/install/win-x64?token=xmpart_mIQhf8LAR3HXo7fD9vQLyw_u9kbNU9LB7AfQ"
Set-Location C:\ow
curl.exe -L -OJ $url
```

Result:

```text
Directory of C:\ow
07/21/2026  09:24 PM       115,567,616 OpenWork-Installer--8788-vxaw8posr6bfnp0a.daytonaproxy01.net--xmpart_mIQhf8LAR3HXo7fD9vQLyw_u9kbNU9LB7AfQ.exe
```

## W1 — stamped filename resolves Acme config

Command shape:

```powershell
& "C:\ow\OpenWork-Installer--8788-vxaw8posr6bfnp0a.daytonaproxy01.net--xmpart_mIQhf8LAR3HXo7fD9vQLyw_u9kbNU9LB7AfQ.exe" --headless --dry-run
Get-Content "$env:LOCALAPPDATA\openwork\desktop-bootstrap.json"
```

Output:

```text
EXIT_CODE=0
LOCALAPPDATA=C:\WINDOWS\system32\config\systemprofile\AppData\Local
BOOTSTRAP=C:\WINDOWS\system32\config\systemprofile\AppData\Local\openwork\desktop-bootstrap.json
--- W1 OUTPUT ---
OpenWork Installer — Acme Robotics
[openwork-installer] Configured via install link.
[write-config] Writing deployment configuration...
[check-version] Checking your deployment for the supported app version...
[check-version] Deployment supports OpenWork 0.17.30.
[done] Dry run ok: openwork-win-x64-0.17.30.exe available; config written to C:\WINDOWS\system32\config\systemprofile\AppData\Local\openwork\desktop-bootstrap.json.
--- W1 BOOTSTRAP ---
{
  "baseUrl": "https://3005-06rjegvkz6agvqbc.daytonaproxy01.net",
  "apiBaseUrl": "https://8788-vxaw8posr6bfnp0a.daytonaproxy01.net",
  "requireSignin": true,
  "brandAppName": "OpenWork",
  "writtenAt": "2026-07-21T21:24:35.991Z"
}
```

Verdict: Passed.

## W2 — renamed exe asks for install link, then `--install-link` succeeds

Command shape:

```powershell
Copy-Item $stampedExe "C:\ow\OpenWork-Installer (1).exe" -Force
& "C:\ow\OpenWork-Installer (1).exe" --headless --dry-run
$env:OPENWORK_INSTALLER_UI="manual"; & "C:\ow\OpenWork-Installer (1).exe"
curl local UI HTML and assert "It's in the copy box on your team's install page"
& "C:\ow\OpenWork-Installer (1).exe" --headless --dry-run --install-link "https://3005-06rjegvkz6agvqbc.daytonaproxy01.net/install?token=xmpart_mIQhf8LAR3HXo7fD9vQLyw_u9kbNU9LB7AfQ"
```

Output:

```text
SETUP_REQUIRED_EXIT=2
UI_URL=http://127.0.0.1:58286/
UI_COPY_STRING_FOUND=True
INSTALL_LINK_EXIT=0
LOCALAPPDATA=C:\WINDOWS\system32\config\systemprofile\AppData\Local
BOOTSTRAP=C:\WINDOWS\system32\config\systemprofile\AppData\Local\openwork\desktop-bootstrap.json
--- W2 SETUP REQUIRED OUTPUT ---
[openwork-installer] Installer is not configured. Paste an OpenWork install link, or run with --install-link <url>.
--- W2 UI OUTPUT ---
[openwork-installer] UI ready at http://127.0.0.1:58286/
--- W2 INSTALL LINK OUTPUT ---
OpenWork Installer — Acme Robotics
[openwork-installer] Configured via install link.
[write-config] Writing deployment configuration...
[check-version] Checking your deployment for the supported app version...
[check-version] Deployment supports OpenWork 0.17.30.
[done] Dry run ok: openwork-win-x64-0.17.30.exe available; config written to C:\WINDOWS\system32\config\systemprofile\AppData\Local\openwork\desktop-bootstrap.json.
--- W2 BOOTSTRAP ---
{
  "baseUrl": "https://3005-06rjegvkz6agvqbc.daytonaproxy01.net",
  "apiBaseUrl": "https://8788-vxaw8posr6bfnp0a.daytonaproxy01.net",
  "requireSignin": true,
  "brandAppName": "OpenWork",
  "writtenAt": "2026-07-21T21:26:13.264Z"
}
```

Verdict: Passed.

## W3 — rotated link reports expired/replaced copy

Rotated the install link:

```sh
curl -sS -X POST 'https://8788-vxaw8posr6bfnp0a.daytonaproxy01.net/v1/orgs/org_01ky38k960f688xzbf4fqjxbak/install-links' \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  --data '{"rotate":true}'
```

Result:

```json
{"token":"mBfpLaI7isovx4oA6kwoR1DLdpE-hYD13_8hHqS-bR4","installPageUrl":"https://3005-06rjegvkz6agvqbc.daytonaproxy01.net/install?token=mBfpLaI7isovx4oA6kwoR1DLdpE-hYD13_8hHqS-bR4"}
```

Confirmed old token was invalid at the Den API:

```text
HTTP/2 404
{"error":"install_link_not_found"}
```

Then posted the old install page link to the installer UI's loopback `/api/resolve-link`:

```text
UI_URL=http://127.0.0.1:59086/
RESOLVE_STATUS=400
EXPIRED_MESSAGE_FOUND=True
--- W3 REQUEST ---
{"installLink":"https://3005-06rjegvkz6agvqbc.daytonaproxy01.net/install?token=xmpart_mIQhf8LAR3HXo7fD9vQLyw_u9kbNU9LB7AfQ"}
--- W3 RESOLVE RESPONSE ---
{"error":"install_link_expired","message":"This install link has expired or was replaced. Ask your workspace admin for a fresh one from the Members page."}
HTTP_STATUS:400
```

Verdict: Passed.

## W4 — Windows app bootstrap pickup

Attempted source-dev-run prerequisites on the Windows VM:

```cmd
where node && node --version && where pnpm && where bun
```

Result:

```text
INFO: Could not find files for the given pattern(s).
```

PowerShell `Get-Command winget,choco,node,pnpm,bun,electron` also returned no matching commands. Checked for an existing app executable in likely locations:

```cmd
dir C:\ow\OpenWork.exe C:\ow\OpenWork\OpenWork.exe C:\ow\openwork\app\OpenWork.exe 2>NUL
```

Result: command exited 1 with no matching files. There was no Electron/OpenWork desktop build present to run in node mode, and installing the full Node/pnpm/bun/Electron dev stack plus source checkout was outside the remaining Windows validation timebox.

Fallback coverage run locally:

```sh
pnpm --filter @openwork/desktop exec node --test electron/workspace-store.test.mjs
```

Result:

```text
tests 21
pass 21
fail 0
```

Verdict: Skipped on the Windows sandbox with an honest note. W1/W2 prove the Windows `%LOCALAPPDATA%\openwork\desktop-bootstrap.json` write path; the local desktop unit test suite covers the corresponding bootstrap read/import behavior, including Windows installer bundle cases.

## Verification commands for the code fix

```sh
pnpm --filter @openwork-ee/den-api exec bun test test/installer-artifacts.test.ts test/install-link-access.test.ts
pnpm --filter @openwork-ee/den-api build
pnpm --filter @openwork/desktop exec node --test electron/workspace-store.test.mjs
```

Results:

- Den API targeted tests: 38 pass, 0 fail.
- Den API build/typecheck: passed.
- Desktop workspace-store tests: 21 pass, 0 fail.

## Cleanup

Stopped, not deleted, both Daytona sandboxes:

```sh
daytona sandbox stop c42adfa5-1c6e-443b-9087-18dda9768384
daytona sandbox stop openwork-server-20260721-141157
```

Deleted the temporary GitHub prerelease used only to transfer the installer into the server sandbox:

```sh
gh release delete first-connection-win-installer-20260721141511 --repo different-ai/openwork --yes
```
