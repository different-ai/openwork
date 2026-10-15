---
name: daytona-windows-cert
description: "test on Windows, enterprise CA, corporate certificate, GPO cert, TLS fetch failed, Windows sandbox, daytona windows, self-hosted cert. Use when validating OpenWork Windows enterprise TLS/OS-trust fixes in a Daytona Windows sandbox."
---

# Daytona Windows Enterprise Certificate Test

Windows companion to `daytona`. Prove the Windows app uses OS trust and spawned runtimes get the OS trust bundle via `NODE_EXTRA_CA_CERTS`. The repro installs a fake corporate CA in the Windows machine store and serves healthy and broken HTTPS control planes.

- Per **Use the Maintained Lever**, reuse `scripts/support/setup-openwork-tls-repro.ps1`, `scripts/support/openwork-doctor.ps1`, and `docs/support/enterprise-network-doctor.md`. Never copy their logic.
- Per **Prove It on the Real Thing**, the verdict is an app-driving `.e2e.test.ts` on `@openwork/testkit`. VNC screenshots are supplementary.

## Prereqs

- Daytona CLI at or above the API version (verified on v0.194). Update with `brew upgrade daytonaio/cli/daytona` and `brew link --overwrite daytona`. Check with `daytona version`.
- `gh` authenticated to `different-ai/openwork`, allowed to create and delete temporary public prereleases.
- A Windows OpenWork build or installer.
- The prerelease is public. Keep secrets (**Scope Secrets**) and customer materials out of the zip.

## 1. Create the Windows sandbox

Windows sandboxes are VM-only, from Daytona's prebuilt `windows` snapshot. Classes: `windows-small` (1 vCPU / 4 GB), `windows-medium` (2 vCPU / 8 GB), `windows-large` (4 vCPU / 16 GB). The verified run used `windows-medium`.

```bash
daytona create --snapshot windows-medium   # prints the sandbox ID and a web terminal URL
SANDBOX_ID="<SANDBOX_ID>"
daytona sandbox start "$SANDBOX_ID"        # Windows sandboxes may auto-stop; restart before continuing
```

## 2. exec vs VNC (the session-0 trap)

- `daytona ssh <ID>` is interactive-only. Scripts fail on its host-key prompt.
- Script setup as `daytona exec <ID> -- <cmd>`, for example `daytona exec "$SANDBOX_ID" -- whoami`.
- exec runs as `nt authority\system` in Windows session 0. It **cannot see the interactive VNC user's app UI**.
- Under exec, `$env:APPDATA` is the SYSTEM profile, not `C:\Users\Administrator`. Never inspect app UI state, userData, or installed app settings through SYSTEM profile paths.
- Use exec for setup and logs. Use VNC to drive the installed app and observe the user-visible result.
- VNC: Daytona Dashboard -> sandbox -> ⋮ menu -> **VNC** -> Connect.

## 3. Get the app build in

Ship large builds as a zip on a temporary **public prerelease**. The Windows image ships `curl.exe` 8.x and `tar`. From the repo root on the host, stage a zip that expands under `C:\ow` and carries the checked-in harness:

```bash
TAG="openwork-win-cert-repro-$(date +%Y%m%d%H%M%S)"
ZIP="/tmp/${TAG}.zip"
# Stage /tmp/openwork-win-cert-upload/openwork as:
#   app/              the Windows app build
#   scripts/support/  setup-openwork-tls-repro.ps1 and openwork-doctor.ps1 from scripts/support/
#   ca-probe.js       copy of .opencode/skills/daytona-windows-cert/scripts/ca-probe.js
ditto -c -k --keepParent /tmp/openwork-win-cert-upload/openwork "$ZIP"
gh release create "$TAG" "$ZIP" --repo different-ai/openwork --prerelease
```

Download and extract inside Windows:

```bash
DOWNLOAD_URL="https://github.com/different-ai/openwork/releases/download/${TAG}/$(basename "$ZIP")"
daytona exec "$SANDBOX_ID" -- cmd /c 'mkdir C:\ow 2>NUL'
daytona exec "$SANDBOX_ID" -- cmd /c "curl.exe -L -o C:\ow\app.zip $DOWNLOAD_URL"
daytona exec "$SANDBOX_ID" -- cmd /c 'tar -xf C:\ow\app.zip -C C:\ow'
```

The verified run single-quoted the literal URL: `daytona exec "$SANDBOX_ID" -- cmd /c 'curl.exe -L -o C:\ow\app.zip <release-download-url>'`.

If the zip holds only the app, fetch the support scripts from the same branch (these URLs use `dev`). Never rewrite them:

```bash
daytona exec "$SANDBOX_ID" -- cmd /c 'mkdir C:\ow\openwork\scripts\support 2>NUL'
daytona exec "$SANDBOX_ID" -- cmd /c 'curl.exe -L -o C:\ow\openwork\scripts\support\setup-openwork-tls-repro.ps1 https://raw.githubusercontent.com/different-ai/openwork/dev/scripts/support/setup-openwork-tls-repro.ps1'
daytona exec "$SANDBOX_ID" -- cmd /c 'curl.exe -L -o C:\ow\openwork\scripts\support\openwork-doctor.ps1 https://raw.githubusercontent.com/different-ai/openwork/dev/scripts/support/openwork-doctor.ps1'
daytona exec "$SANDBOX_ID" -- cmd /c 'curl.exe -L -o C:\ow\openwork\ca-probe.js https://raw.githubusercontent.com/different-ai/openwork/dev/.opencode/skills/daytona-windows-cert/scripts/ca-probe.js'
```

## 4. Stand up the enterprise-TLS repro

`scripts/support/setup-openwork-tls-repro.ps1` creates a fake corporate root and intermediate. It trusts the root in `Cert:\LocalMachine\Root`, maps `poc.openwork.test` to localhost, and serves:

- `https://poc.openwork.test:8443`: healthy chain.
- `https://poc.openwork.test:9443`: broken chain, intermediate removed.

The PowerShell listeners die when their `daytona exec` session closes. Never run them only in a one-off exec. Persist them with a scheduled task that runs as SYSTEM and keeps the session alive:

```bash
ENCODED=$(python3 - <<'PY'
import base64
script = r'''
$ErrorActionPreference = "Stop"
$repo = "C:\ow\openwork"
$cmdPath = "C:\ow\start-openwork-tls-repro.cmd"
$cmd = @"
@echo off
cd /d "$repo"
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\support\setup-openwork-tls-repro.ps1
powershell -NoProfile -ExecutionPolicy Bypass -Command "while (`$true) { Start-Sleep -Seconds 3600 }"
"@
Set-Content -LiteralPath $cmdPath -Value $cmd -Encoding ASCII
schtasks /create /f /sc onstart /ru SYSTEM /tn OpenWorkTlsRepro /tr $cmdPath
schtasks /run /tn OpenWorkTlsRepro
'''
print(base64.b64encode(script.encode("utf-16le")).decode())
PY
)
daytona exec "$SANDBOX_ID" -- powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand "$ENCODED"
```

Check the healthy listener. The doctor run is optional diagnostics:

```bash
daytona exec "$SANDBOX_ID" -- cmd /c 'netstat -ano | findstr :8443'
daytona exec "$SANDBOX_ID" -- powershell -NoProfile -ExecutionPolicy Bypass -File 'C:\ow\openwork\scripts\support\openwork-doctor.ps1' -WebUrl https://poc.openwork.test:8443 -ApiUrl https://poc.openwork.test:9443 -ExpectedIssuerMatch "OpenWork TLS Repro"
```

## 5. Verify the fix

### Probe Electron's view of the Windows machine store

`scripts/ca-probe.js` counts CA subjects matching `OPENWORK_TLS_REPRO_CA_MATCH` (default `OpenWork TLS Repro`) in `tls.getCACertificates("system")` and `tls.getCACertificates("default")`. It prints the counts as JSON. It exits 1 when `reproInSystem` is 0. Copy it to `C:\ow\ca-probe.js` and run Electron in node mode. Adjust the executable path for your unpacked build or installed app:

```bash
daytona exec "$SANDBOX_ID" -- cmd /c 'copy C:\ow\openwork\ca-probe.js C:\ow\ca-probe.js'
daytona exec "$SANDBOX_ID" -- cmd /c 'set ELECTRON_RUN_AS_NODE=1 && "C:\ow\openwork\app\OpenWork.exe" C:\ow\ca-probe.js'
# verified result: {"systemCount":42,"reproInSystem":6,"defaultCount":150,"reproInDefault":0}
```

This is the crucial #2562 check for the GPO/enterprise-CA case. The Windows system store (`LocalMachine\Root`) holds the repro corporate CA. The bundled Mozilla roots do not.

### Verify the installed app via VNC

1. Connect over VNC (section 2).
2. Launch or install OpenWork as the interactive user.
3. Point the self-hosted/control-plane URL at `https://poc.openwork.test:8443`. Expect success.
4. Repeat with `https://poc.openwork.test:9443`. Expect a named certificate/chain error, not a vague `fetch failed` banner.

Use `daytona` for normal Electron driving patterns. For PR evidence, encode this path and its TLS assertions in `evals/specs/<slug>.e2e.test.ts` (`write-a-spec`), run it with `run-tests`, and take the verdict from its ambient test evidence.

### Verify the app's generated CA bundle path

The userData folder is `C:\Users\<User>\AppData\Roaming\com.differentai.openwork`, **not** `C:\Users\<User>\AppData\Roaming\OpenWork`. exec runs as SYSTEM, so name the interactive user's path:

```bash
daytona exec "$SANDBOX_ID" -- cmd /c 'dir "C:\Users\Administrator\AppData\Roaming\com.differentai.openwork\system-ca-bundle.pem"'
daytona exec "$SANDBOX_ID" -- cmd /c 'set ELECTRON_RUN_AS_NODE=1 && "C:\ow\openwork\app\OpenWork.exe" C:\ow\ca-probe.js "C:\Users\Administrator\AppData\Roaming\com.differentai.openwork\system-ca-bundle.pem"'
```

Expect `reproInBundle` of 1 or more. Do not `findstr` the bundle: it holds only PEM blocks, so subject names are base64-encoded and a text search never matches.

Gotcha: `system-ca-bundle.pem` is written once per launch, then memoized. After adding a CA, restart the app before expecting it there. Real fleets have the GPO CA at boot, so customers rarely hit this.

## Shell/quoting gotchas

- zsh strips backslashes in unquoted Windows paths. Quote the whole `cmd /c` payload:

```bash
daytona exec "$SANDBOX_ID" -- cmd /c 'dir "C:\Users\Administrator\AppData\Roaming\com.differentai.openwork"'
```

- The intermediate `cmd` layer can eat pipes (`|`) inside `daytona exec ... -- powershell -Command '...'`. For anything with pipes or nested quotes, use `powershell -EncodedCommand` with a base64 UTF-16LE payload:

```bash
ENCODED=$(python3 - <<'PY'
import base64
command = r'Get-ChildItem Cert:\LocalMachine\Root | Where-Object Subject -like "*OpenWork TLS Repro*"'
print(base64.b64encode(command.encode("utf-16le")).decode())
PY
)
daytona exec "$SANDBOX_ID" -- powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand "$ENCODED"
```

- `%ERRORLEVEL%` expands at parse time in `cmd` one-liners. To propagate exit codes, use PowerShell and `$LASTEXITCODE`:

```bash
daytona exec "$SANDBOX_ID" -- powershell -NoProfile -ExecutionPolicy Bypass -Command 'curl.exe --version; exit $LASTEXITCODE'
```

- `cmd /c` plus `timeout` fails under `daytona exec` with "input redirection is not supported". Sleep with `ping -n`:

```bash
daytona exec "$SANDBOX_ID" -- cmd /c 'ping -n 6 127.0.0.1 >NUL'
```

## Cleanup

Stop the scheduled repro. Remove the certificates, hosts entries, and port bindings with the setup script's `-Cleanup`. Per **Touch Only What You Own**, delete the sandbox and prerelease by the exact ID and tag you created:

```bash
daytona exec "$SANDBOX_ID" -- cmd /c 'schtasks /end /tn OpenWorkTlsRepro'
daytona exec "$SANDBOX_ID" -- powershell -NoProfile -ExecutionPolicy Bypass -File 'C:\ow\openwork\scripts\support\setup-openwork-tls-repro.ps1' -Cleanup
daytona sandbox delete <ID>
gh release delete <tag> --repo different-ai/openwork --cleanup-tag --yes
```
