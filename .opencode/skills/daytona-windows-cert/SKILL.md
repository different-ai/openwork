---
name: daytona-windows-cert
description: "test on Windows, enterprise CA, corporate certificate, GPO cert, TLS fetch failed, Windows sandbox, daytona windows, self-hosted cert. Use when validating Micx Windows enterprise TLS/OS-trust fixes in a Daytona Windows sandbox."
---

# Skill: Daytona Windows Enterprise Certificate Test

Run the verified Windows repro for Micx enterprise TLS behavior: install a
fake corporate CA into the Windows machine store, serve healthy and broken HTTPS
control planes, install a Windows build, and prove the desktop app and spawned
runtimes use the operating system trust path.

Use this as the Windows companion to `daytona-electron-test`. For executable
end-to-end or PR verdict evidence, use an app-driving `.slow.test.ts` spec with
`@micx/testkit`; custom VNC screenshots are supplementary. Reuse the repo
support assets instead of copying their logic: `scripts/support/setup-micx-tls-repro.ps1`,
`scripts/support/micx-doctor.ps1`, and `docs/support/enterprise-network-doctor.md`.

## When to use

- User says "test on Windows", "Windows sandbox", or "daytona windows".
- User is validating an enterprise CA, corporate certificate, GPO cert, or
  self-hosted cert path on Windows.
- User reports `TLS fetch failed`, `fetch failed`, or a certificate-specific
  failure when connecting Micx to a self-hosted control plane.
- User needs to prove the Windows app uses OS trust and spawned runtimes receive
  the OS trust bundle via `NODE_EXTRA_CA_CERTS`.

## Prereqs

- Daytona CLI must be at least the API version. The verified CLI was v0.194:

```bash
brew upgrade daytonaio/cli/daytona
brew link --overwrite daytona
daytona version
```

- `gh` must be authenticated to `different-ai/micx` and able to create/delete
  temporary public prereleases.
- Have a Windows Micx build or installer ready. Keep secrets and customer
  materials out of the temporary release asset.

## 1. Create the Windows sandbox

Windows sandboxes are VM-only and are created from Daytona's prebuilt `windows`
snapshot. Available classes are `windows-small` (1 vCPU / 4 GB),
`windows-medium` (2 vCPU / 8 GB), and `windows-large` (4 vCPU / 16 GB). The
verified path used `windows-medium`:

```bash
daytona create --snapshot windows-medium
```

The command prints a sandbox ID and a web terminal URL. Save the ID once:

```bash
SANDBOX_ID="<SANDBOX_ID>"
```

Windows sandboxes may auto-stop. Restart the sandbox before continuing:

```bash
daytona sandbox start <ID>
```

Use the saved shell variable for later commands:

```bash
daytona sandbox start "$SANDBOX_ID"
```

## 2. exec vs VNC (the session-0 trap)

**Important:** `daytona ssh <ID>` is interactive-only and fails from scripts on
the host-key prompt. Use this shape for setup commands instead:

```bash
daytona exec <ID> -- <cmd>
```

For example:

```bash
daytona exec "$SANDBOX_ID" -- whoami
```

`daytona exec` runs as `nt authority\system` in Windows session 0. That is useful
for admin setup, but it **cannot see the interactive VNC user's app UI**, and
`$env:APPDATA` resolves to the SYSTEM profile, not `C:\Users\Administrator`.
Do not inspect app UI state, userData, or installed app settings through SYSTEM
profile paths.

Human GUI access is: Daytona Dashboard -> sandbox -> ⋮ menu -> **VNC** ->
Connect. Use `exec` for setup and logs; use VNC to drive the installed Micx
app and observe the user-visible result.

## 3. Get the app build in

For large Windows builds, zip the build, attach it to a temporary **public
prerelease**, and download it inside the VM with the Windows-bundled `curl.exe`
and `tar`. The `curl.exe` 8.x and `tar` binaries ship in the Windows image.

From the repo root on the host, stage a zip that expands under `C:\ow`. Include
the app build plus the support scripts from this repo so the VM reuses the
checked-in harness:

```bash
TAG="micx-win-cert-repro-$(date +%Y%m%d%H%M%S)"
ZIP="/tmp/${TAG}.zip"
# Put your Windows app build under /tmp/micx-win-cert-upload/micx/app
# and include scripts/support/setup-micx-tls-repro.ps1 plus
# scripts/support/micx-doctor.ps1 under micx/scripts/support/.
# Include .opencode/skills/daytona-windows-cert/scripts/ca-probe.js as
# micx/ca-probe.js.
ditto -c -k --keepParent /tmp/micx-win-cert-upload/micx "$ZIP"
gh release create "$TAG" "$ZIP" --repo different-ai/micx --prerelease
```

The release command shape from the verified session was:

```bash
gh release create <tag> <zip> --repo different-ai/micx --prerelease
```

Download and extract inside Windows:

```bash
DOWNLOAD_URL="https://github.com/different-ai/micx/releases/download/${TAG}/$(basename "$ZIP")"
daytona exec "$SANDBOX_ID" -- cmd /c 'mkdir C:\ow 2>NUL'
daytona exec "$SANDBOX_ID" -- cmd /c "curl.exe -L -o C:\ow\app.zip $DOWNLOAD_URL"
daytona exec "$SANDBOX_ID" -- cmd /c 'tar -xf C:\ow\app.zip -C C:\ow'
```

The Windows download/extract shape from the verified session was:

```bash
daytona exec "$SANDBOX_ID" -- cmd /c 'curl.exe -L -o C:\ow\app.zip <release-download-url>'
daytona exec "$SANDBOX_ID" -- cmd /c 'tar -xf C:\ow\app.zip -C C:\ow'
```

If the zip only contains the app, fetch the support scripts from the same branch
instead of rewriting them:

```bash
daytona exec "$SANDBOX_ID" -- cmd /c 'mkdir C:\ow\micx\scripts\support 2>NUL'
daytona exec "$SANDBOX_ID" -- cmd /c 'curl.exe -L -o C:\ow\micx\scripts\support\setup-micx-tls-repro.ps1 https://raw.githubusercontent.com/different-ai/micx/dev/scripts/support/setup-micx-tls-repro.ps1'
daytona exec "$SANDBOX_ID" -- cmd /c 'curl.exe -L -o C:\ow\micx\scripts\support\micx-doctor.ps1 https://raw.githubusercontent.com/different-ai/micx/dev/scripts/support/micx-doctor.ps1'
```

## 4. Stand up the enterprise-TLS repro

`scripts/support/setup-micx-tls-repro.ps1` creates a fake corporate root and
intermediate, trusts the root in `Cert:\LocalMachine\Root`, maps
`poc.micx.test` to localhost, and serves:

- `https://poc.micx.test:8443` — healthy chain.
- `https://poc.micx.test:9443` — broken chain with the intermediate removed.

Do not run the listeners only inside a one-off `daytona exec`; the PowerShell
listeners die when that exec session closes. Persist them with a scheduled task
that runs as SYSTEM and keeps the session alive:

```bash
ENCODED=$(python3 - <<'PY'
import base64
script = r'''
$ErrorActionPreference = "Stop"
$repo = "C:\ow\micx"
$cmdPath = "C:\ow\start-micx-tls-repro.cmd"
$cmd = @"
@echo off
cd /d "$repo"
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\support\setup-micx-tls-repro.ps1
powershell -NoProfile -ExecutionPolicy Bypass -Command "while (`$true) { Start-Sleep -Seconds 3600 }"
"@
Set-Content -LiteralPath $cmdPath -Value $cmd -Encoding ASCII
schtasks /create /f /sc onstart /ru SYSTEM /tn MicxTlsRepro /tr $cmdPath
schtasks /run /tn MicxTlsRepro
'''
print(base64.b64encode(script.encode("utf-16le")).decode())
PY
)
daytona exec "$SANDBOX_ID" -- powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand "$ENCODED"
```

Verify the healthy listener is up:

```bash
daytona exec "$SANDBOX_ID" -- cmd /c 'netstat -ano | findstr :8443'
```

Optional diagnostic output from the checked-in doctor script:

```bash
daytona exec "$SANDBOX_ID" -- powershell -NoProfile -ExecutionPolicy Bypass -File 'C:\ow\micx\scripts\support\micx-doctor.ps1' -WebUrl https://poc.micx.test:8443 -ApiUrl https://poc.micx.test:9443 -ExpectedIssuerMatch "Micx TLS Repro"
```

## 5. Verify the fix

### Probe Electron's view of the Windows machine store

Copy `.opencode/skills/daytona-windows-cert/scripts/ca-probe.js` into the VM as
`C:\ow\ca-probe.js`. Its contents are intentionally small and reusable:

```bash
daytona exec "$SANDBOX_ID" -- cmd /c 'copy C:\ow\micx\ca-probe.js C:\ow\ca-probe.js'
```

```js
const { X509Certificate } = require("node:crypto");
const tls = require("node:tls");

const needle = (process.env.MICX_TLS_REPRO_CA_MATCH || "Micx TLS Repro").toLowerCase();

function countMatchingSubjects(certificates) {
  let count = 0;
  for (const pem of certificates) {
    try {
      const certificate = new X509Certificate(pem);
      if (certificate.subject.toLowerCase().includes(needle)) count += 1;
    } catch {
      // Ignore entries that are not parseable X.509 certificates.
    }
  }
  return count;
}

const system = tls.getCACertificates("system");
const bundled = tls.getCACertificates("default");

const result = {
  systemCount: system.length,
  reproInSystem: countMatchingSubjects(system),
  defaultCount: bundled.length,
  reproInDefault: countMatchingSubjects(bundled),
};

console.log(JSON.stringify(result, null, 2));

if (result.reproInSystem === 0) {
  process.exitCode = 1;
}
```

Run Electron in node mode. Adjust the executable path for your unpacked build or
installed app:

```bash
daytona exec "$SANDBOX_ID" -- cmd /c 'set ELECTRON_RUN_AS_NODE=1 && "C:\ow\micx\app\Micx.exe" C:\ow\ca-probe.js'
```

The verified result was:

```json
{"systemCount":42,"reproInSystem":6,"defaultCount":150,"reproInDefault":0}
```

This is the crucial #2562 verification for the GPO/enterprise-CA case: the
Windows system store (`LocalMachine\Root`) contains the repro corporate CA, while
the bundled Mozilla roots do not.

### Verify the installed app via VNC

Drive the installed Micx Windows app through VNC, not `daytona exec`.

1. Open Daytona Dashboard -> sandbox -> ⋮ menu -> **VNC** -> Connect.
2. Launch or install Micx as the interactive user.
3. Point the self-hosted/control-plane URL at `https://poc.micx.test:8443`.
   The request should succeed.
4. Repeat against `https://poc.micx.test:9443`. The request should fail with
   a named certificate/chain error, not a vague `fetch failed` banner.

Use `daytona-electron-test` for normal Electron driving patterns. If this is PR
evidence, translate the user-visible path and TLS assertions into an
`evals/specs/<slug>.slow.test.ts` test via `write-a-spec`, run it with
`run-tests`, and use its ambient tape for the verdict. The VNC checklist and
captures above remain supplementary setup and debugging evidence.

### Verify the app's generated CA bundle path

The real Windows userData folder is:

```text
C:\Users\<User>\AppData\Roaming\com.differentai.micx
```

It is **not** `C:\Users\<User>\AppData\Roaming\Micx`. Because `exec` runs as
SYSTEM, inspect the interactive user path explicitly:

```bash
daytona exec "$SANDBOX_ID" -- cmd /c 'dir "C:\Users\Administrator\AppData\Roaming\com.differentai.micx\system-ca-bundle.pem"'
daytona exec "$SANDBOX_ID" -- cmd /c 'findstr /c:"Micx TLS Repro" "C:\Users\Administrator\AppData\Roaming\com.differentai.micx\system-ca-bundle.pem"'
```

Known gotcha: `system-ca-bundle.pem` is written once at first launch and then
memoized. If a CA is added **after** first launch, restart the app before
expecting it to appear. On real fleets the GPO CA is present at boot, so this
usually does not bite customers.

## Shell/quoting gotchas

- zsh strips backslashes in unquoted Windows paths. Quote the whole `cmd /c`
  payload:

```bash
daytona exec "$SANDBOX_ID" -- cmd /c 'dir "C:\Users\Administrator\AppData\Roaming\com.differentai.micx"'
```

- Pipes and `|` inside `daytona exec ... -- powershell -Command '...'` can be
  eaten by the intermediate `cmd` layer. Use `powershell -EncodedCommand` with a
  base64 UTF-16LE payload for anything with pipes or nested quotes:

```bash
ENCODED=$(python3 - <<'PY'
import base64
command = r'Get-ChildItem Cert:\LocalMachine\Root | Where-Object Subject -like "*Micx TLS Repro*"'
print(base64.b64encode(command.encode("utf-16le")).decode())
PY
)
daytona exec "$SANDBOX_ID" -- powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand "$ENCODED"
```

- `%ERRORLEVEL%` expands at parse time in `cmd` one-liners. Prefer PowerShell and
  `$LASTEXITCODE` when you need to propagate exit codes:

```bash
daytona exec "$SANDBOX_ID" -- powershell -NoProfile -ExecutionPolicy Bypass -Command 'curl.exe --version; exit $LASTEXITCODE'
```

- `cmd /c` plus `timeout` fails with "input redirection is not supported" under
  `daytona exec`. Use `ping -n` for sleeps:

```bash
daytona exec "$SANDBOX_ID" -- cmd /c 'ping -n 6 127.0.0.1 >NUL'
```

## Cleanup

Stop the scheduled repro, remove the certificates/hosts/bindings through the
checked-in setup script, delete the sandbox, and delete the temporary prerelease:

```bash
daytona exec "$SANDBOX_ID" -- cmd /c 'schtasks /end /tn MicxTlsRepro'
# Core repro cleanup shape: setup-micx-tls-repro.ps1 -Cleanup
daytona exec "$SANDBOX_ID" -- powershell -NoProfile -ExecutionPolicy Bypass -File 'C:\ow\micx\scripts\support\setup-micx-tls-repro.ps1' -Cleanup
daytona sandbox delete <ID>
gh release delete <tag> --yes
```
