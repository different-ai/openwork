# Installing OpenWork without administrator rights

## Short answer

**The official Windows x64 NSIS v0.18.59 package was empirically installed without administrator rights; this is not yet a confirmed end-to-end pilot path.** First launch failed on the test VM; launch after a same-user silent reinstall reached the normal composer (see [Validation results](#validation-results)). Not having local administrator rights is different from being allowed to run downloaded software or reliably starting the agent runtime.

| OS / package | Can a standard user install it? | Conditions |
| --- | --- | --- |
| Windows, current Electron NSIS `.exe` | **Yes for the tested public x64 v0.18.59 package.** | Normal and silent installation are tested separately below. Other versions/flavors/architectures and enterprise application-control policy need their own validation. |
| macOS, current Electron `.dmg` / `.zip` | **Expected into a user-writable folder; not empirically tested.** | Copy the `.app` to `~/Applications` (create that folder if needed). Copying to shared `/Applications` depends on its permissions and may require administrator authorization. |
| Windows, historical Tauri `.msi` | **No for an ordinary self-install of the machine-wide package.** | Treat it as IT-managed/elevation-requiring; do not apply the current NSIS answer to old MSI releases. |

**Confidence and scope:** the original source/configuration review is dated 2026-10-21 at commit `70d8203cfe7e38c3936b13d9a07040ca0a90e6e8`. The [validation below](#validation-results) adds a real standard-user Windows Server VM test of one official release artifact, not a managed customer PC or macOS test. Public, Cloud, and Enterprise flavors inherit the same installer base, but only the public x64 artifact was exercised; sharing configuration is not empirical validation of the other flavors. Auto-update elevation behavior remains a separate, unproven lifecycle step.

## Validation results

| Step (same non-admin account, UAC enabled) | Result | Observation |
| --- | --- | --- |
| Normal NSIS install | **PASS** | Exit `0`; per-user installation, ownership, HKCU registration and shortcuts confirmed; no administrator credentials or observed elevation prompt. |
| First launch after normal install | **FAIL for usable startup; shell/process start PASS** | `OpenWork.exe` and its renderer ran as `owstandard` in session 1, but UI showed **“OpenWork couldn't start”**, technical detail **“Managed OpenCode process did not exit after SIGKILL”**. |
| Uninstall after first launch | **PASS** | `/currentuser /S` exited `0`; installed executable removed. |
| Fresh silent NSIS reinstall | **PASS** | `/S` exited `0`; used the same user and default per-user destination. User profile/workspace were retained, not reset. |
| Launch after silent reinstall | **PASS for window/composer startup** | Main process PID `6612`, renderer/helpers and window title `OpenWork`, all under `owstandard` in session 1. CDP and screenshot showed the normal **“What do you need done?”** composer, without the startup-failure screen. This does not erase the first-run failure or prove a model request. |
| Final uninstall after silent reinstall | **PASS for app removal, with residue** | Same-user `/currentuser /S` exited `0`; install directory, uninstall/location registration and both shortcuts removed. User profile/workspace **and the HKCU `openwork` URL-protocol key remained**. |
| In-app update check | **PASS** | Real `updater.check()` returned current/latest `0.18.59`, `available=false`; no elevation prompt observed. |
| Auto-update download/apply/restart | **NOT TESTED** | No newer release was available; updater inspection shows an elevation fallback, so do not promise no-UAC updates. |

### Environment and artifact

- **Date:** 2026-10-21 America/Los_Angeles (VM command timestamps are 2026-10-22 UTC).
- **Provider/image:** a newly created private Daytona `windows-small` VM, 1 vCPU / 4 GiB RAM / 30 GiB disk. Guest: **Microsoft Windows Server 2025 Datacenter**, version **10.0.26100**, build **26100**, x64; PowerShell **5.1.26100.1591**. This is not a Windows 10/11 enterprise client image.
- **Account:** newly created local `DAYTONA-SANDBOX\owstandard`; console session 1. `net user owstandard` showed only `*Users` local-group membership. `whoami /groups` showed `BUILTIN\Users` and `Mandatory Label\Medium Mandatory Level`, with **no Administrators SID (`S-1-5-32-544`)**, not even deny-only membership. A `WindowsPrincipal.IsInRole(Administrator)` guard returned false before lifecycle tests.
- **UAC:** the base image had `EnableLUA=0`. Setup changed it to **1**, then rebooted into the standard-user desktop **before any installer execution**. `ConsentPromptBehaviorUser=3` remained in place (prompt for credentials; not automatic elevation denial). No administrator credentials were supplied to an installer, app, or uninstaller. Defender was not disabled.
- **Official release:** [`v0.18.59`](https://github.com/different-ai/openwork/releases/tag/v0.18.59), public distribution, [`openwork-win-x64-0.18.59.exe`](https://github.com/different-ai/openwork/releases/download/v0.18.59/openwork-win-x64-0.18.59.exe), **374,988,200 bytes**. The release inventory contained **no `.msi`**; no MSI was fabricated or substituted. ARM64, Cloud, Enterprise, and historical MSI artifacts were not tested.
- **SHA-256 computed inside the guest:** `02b9b788b7299295133c58e7fe1a409e9a9b7676ccc3c525d8bc3d90498feb2e`, matching the GitHub release-asset digest.
- **Authenticode:** `Get-AuthenticodeSignature` returned **Valid / Signature verified**; signer `CN=Different Ai Inc, O=Different Ai Inc, L=San Francisco, S=California, C=US, PostalCode=94108`; certificate thumbprint `43C62B205EF529C5B9ACDA810B82249DB8AB379F`.

### Procedure and observed output

The Daytona toolbox runs as SYSTEM. It was used **only for VM/account/UAC setup, staging the unmodified installer, scheduling least-privileged interactive tasks, and observation**; running `daytona exec ... installer.exe` directly would not be a non-admin test. An ephemeral generated password was used to sign the new account into the desktop after reboot; it was not used to elevate any tested operation and is not included here.

Provision/stage commands (PowerShell scripts sent through `powershell -NoProfile -NonInteractive -EncodedCommand <UTF-16LE-base64>` so the CLI preserves quoting):

```sh
daytona create --snapshot windows-small --name openwork-pr6335-nonadmin-20261021 \
  --ttl 120 --auto-stop 30 --auto-delete 0
```

```powershell
# Setup only, as SYSTEM. Never publish the generated password.
$password = 'Ow!' + [guid]::NewGuid().ToString('N')
New-LocalUser -Name owstandard -Password (ConvertTo-SecureString $password -AsPlainText -Force)
Add-LocalGroupMember -Group Users -Member owstandard
net user owstandard
Set-ItemProperty HKLM:\Software\Microsoft\Windows\CurrentVersion\Policies\System -Name EnableLUA -Type DWord -Value 1
$wl = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon'
Set-ItemProperty $wl AutoAdminLogon '1'
Set-ItemProperty $wl DefaultUserName 'owstandard'
Set-ItemProperty $wl DefaultDomainName $env:COMPUTERNAME
Set-ItemProperty $wl DefaultPassword $password
shutdown.exe /r /t 3
# After reboot, verify the standard-user console session and enabled UAC:
quser
Get-Process explorer -IncludeUserName
Get-ItemProperty HKLM:\Software\Microsoft\Windows\CurrentVersion\Policies\System |
  Select-Object EnableLUA,ConsentPromptBehaviorUser

# Staging directory is writable for user test scripts/logs, not a system install path.
New-Item -ItemType Directory C:\validation -Force
icacls C:\validation /grant '*S-1-5-32-545:(OI)(CI)M'
curl.exe -fLsS -o C:\validation\openwork-win-x64-0.18.59.exe https://github.com/different-ai/openwork/releases/download/v0.18.59/openwork-win-x64-0.18.59.exe
Get-FileHash C:\validation\openwork-win-x64-0.18.59.exe -Algorithm SHA256
Get-AuthenticodeSignature C:\validation\openwork-win-x64-0.18.59.exe
```

The setup identity registered each test script with the **actual logged-in user's limited interactive token**, not SYSTEM, Administrator, or a highest-privilege task:

```powershell
$p = New-ScheduledTaskPrincipal -UserId owstandard -LogonType Interactive -RunLevel Limited
$a = New-ScheduledTaskAction -Execute powershell.exe -Argument '-NoProfile -File C:\validation\interactive-install.ps1'
Register-ScheduledTask -TaskName OWNonAdminInstall -Principal $p -Action $a -Force
Start-ScheduledTask OWNonAdminInstall
# lifecycle.ps1 and final-uninstall.ps1 used the same principal, with -WindowStyle Hidden.
```

Inside those standard-user scripts, the substantive commands were:

```powershell
whoami
whoami /groups
net user owstandard
$id = [Security.Principal.WindowsIdentity]::GetCurrent()
$p = New-Object Security.Principal.WindowsPrincipal($id)
if ($id.Name -notmatch '\\owstandard$' -or $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Wrong test identity' }

# Normal install, with no /S or protected destination override.
$r = Start-Process C:\validation\openwork-win-x64-0.18.59.exe -PassThru -Wait
$r.ExitCode
$dir = "$env:LOCALAPPDATA\Programs\@openworkdesktop"
Start-Process "$dir\OpenWork.exe"  # No elevation verb or test-only launch flags.
Get-Process OpenWork | Select-Object Id,SessionId,Path,MainWindowTitle
(Get-Item "$dir\OpenWork.exe").VersionInfo
Get-Acl $dir

# Read product registration before/after installation and launch.
Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*'
Get-ItemProperty 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*'
Get-ItemProperty 'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
reg.exe query HKCU\Software /f OpenWork /s
reg.exe query HKLM\Software /f OpenWork /s
Get-ChildItem "$env:APPDATA\Microsoft\Windows\Start Menu\Programs","$env:USERPROFILE\Desktop" -Filter '*OpenWork*' -Recurse
Get-Content "$dir\resources\app-update.yml"

# Close the app as this same user, uninstall, then test a fresh silent install.
Get-Process OpenWork -ErrorAction SilentlyContinue | Stop-Process -Force
$r = Start-Process "$dir\Uninstall OpenWork.exe" -ArgumentList '/currentuser','/S' -Wait -PassThru
$r.ExitCode
Test-Path "$dir\OpenWork.exe"
$r = Start-Process C:\validation\openwork-win-x64-0.18.59.exe -ArgumentList '/S' -Wait -PassThru
$r.ExitCode
Start-Process "$dir\OpenWork.exe"
# Finally close the app and repeat the same /currentuser /S uninstall.
```

Install/lifecycle transcript excerpts (all under the standard-user token):

```text
Username: DAYTONA-SANDBOX\owstandard
RunAs User: DAYTONA-SANDBOX\owstandard
BUILTIN\Users                          S-1-5-32-545
Mandatory Label\Medium Mandatory Level S-1-16-8192
USERPROFILE=C:\Users\owstandard LOCALAPPDATA=C:\Users\owstandard\AppData\Local SESSION=1
EnableLUA                 : 1
ConsentPromptBehaviorUser : 3
INTERACTIVE_INSTALL_BEGIN 2026-10-22T00:17:38.6892212+00:00
INTERACTIVE_INSTALL_EXIT=0 2026-10-22T00:21:03.9915734+00:00
DisplayName    : OpenWork 0.18.59
DisplayVersion : 0.18.59
Owner          : DAYTONA-SANDBOX\owstandard
UNINSTALL_1_EXIT=0 EXE_EXISTS=False
SILENT_INSTALL_BEGIN 2026-10-22T00:24:33.4597217+00:00
SILENT_INSTALL_EXIT=0 2026-10-22T00:25:32.8448051+00:00
FINAL_UNINSTALL_BEGIN 2026-10-22T00:28:27.4435575+00:00
FINAL_UNINSTALL_EXIT=0 2026-10-22T00:28:49.1146771+00:00
EXE_EXISTS=False INSTALL_DIR_EXISTS=False
HKCU_UNINSTALL_EXISTS=False
HKCU_INSTALL_LOCATION_EXISTS=False
PROTOCOL_EXISTS=True
DESKTOP_LINK_EXISTS=False
START_MENU_LINK_EXISTS=False
PROFILE_REMAINS=True
WORKSPACE_REMAINS=True
```

The retained profile was `%APPDATA%\com.differentai.openwork`; the retained workspace was `%USERPROFILE%\OpenWork Chat`. Uninstall is therefore **not a full user-data purge**, and the app-created HKCU URL handler was left behind pointing at the removed executable. First-launch and post-reinstall screenshots are attached to the PR's validation comment, not committed as repository images.

For the silent install, both uninstalls, second launch and update check, an independent SYSTEM observer sampled `Get-Process consent` every 200 ms. Its log contained only start/stop markers, with **no consent-process detections**. This monitor began at `2026-10-22T00:21:37.6472219+00:00`, **after the normal install had completed**; the normal-install claim instead rests on the verified non-admin token, unassisted completion with exit `0`, and no supplied administrator credentials or observed prompt. This is not continuous video proof that no transient OS dialog existed.

Observed product registrations were in **HKCU**:

- `Software\29165f8a-586b-5470-a1cc-cfff30a85ed3`: `InstallLocation=C:\Users\owstandard\AppData\Local\Programs\@openworkdesktop`, `ShortcutName=OpenWork`.
- `Software\Microsoft\Windows\CurrentVersion\Uninstall\29165f8a-586b-5470-a1cc-cfff30a85ed3`: version `0.18.59`; uninstall command `"C:\Users\owstandard\AppData\Local\Programs\@openworkdesktop\Uninstall OpenWork.exe" /currentuser`; quiet command adds `/S`.
- `Software\Classes\openwork\shell\open\command` appeared **after launch**, pointing to the user-owned `OpenWork.exe` with `"%1"`; it was absent immediately after the installer. User shell shortcut/MuiCache entries were also observed.

Neither HKLM uninstall view gained an OpenWork entry; the post-launch `reg query HKLM\Software /f OpenWork /s` reported **0 matches**. This is a targeted product-registration check, **not** a comprehensive registry-write trace/Procmon audit. Desktop and Start Menu shortcuts were `C:\Users\owstandard\Desktop\OpenWork.lnk` and `C:\Users\owstandard\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\OpenWork.lnk`. The installed directory was owned by `owstandard`, with that user having FullControl.

**Cleanup:** all three standard-user scheduled test tasks finished with `LastTaskResult=0`; the final account check still listed only `Users`, UAC remained enabled, and no OpenWork/OpenCode processes remained. Test transcripts were copied out, temporary autologon credentials removed, and `daytona delete openwork-pr6335-nonadmin-20261021` completed. A subsequent `daytona info fafcff05-8d02-4f92-a2ce-a152dddf126e` returned **Not Found**. No VM was left running.

### Update check and remaining scope

**The real in-app update check passed as the standard user.** After the successful second launch, CDP invoked the exposed renderer bridge `window.__OPENWORK_ELECTRON__.updater.check()` in the running user-owned app. It returned:

```json
{"available":false,"currentVersion":"0.18.59","latestVersion":"0.18.59","releaseDate":"2026-10-20T21:45:50.260Z","totalBytes":374988200,"channel":"stable","feedUrl":"https://github.com/different-ai/openwork/releases/latest/download"}
```

No newer update was available. A real auto-update **download/apply/restart cycle was not performed** and must not be reported as a pass. The installed `resources\app-update.yml` identified `different-ai/openwork`, GitHub release updates, and the per-user `@openworkdesktop-updater` cache name. The actual v0.18.59 [`latest.yml`](https://github.com/different-ai/openwork/releases/download/v0.18.59/latest.yml) did not set `isAdminRightsRequired`. Release-tag updater code and its pinned electron-updater 6.8.3 were checked: ordinary NSIS updates spawn the installer directly, **but `elevate.exe` is present and can be used for `isAdminRightsRequired`, `UNKNOWN`, or `EACCES` failures**. No unconditional no-UAC update guarantee is justified. Reinstalling the same version is not an update test.

Still untested: a managed Windows 10/11 client, enterprise EDR/AppLocker/WDAC/ASR/GPO restrictions, corporate proxy/TLS inspection, browser-downloaded Mark-of-the-Web/SmartScreen behavior (the artifact was staged with `curl.exe`), sign-in, a successful model request/file workflow, real auto-update and recovery/migration from machine-wide MSI, macOS, ARM64, and Cloud/Enterprise distributions. The observed startup failure is not evidence that elevation is required; its root cause was not established, and an elevated launch was not used as a workaround. **Do not turn this clean-VM installer result into a promise that the app works on locked-down customer PCs.**

## Windows evidence

### Current installer is per-user already

- [`apps/desktop/package.json`](../apps/desktop/package.json), `main` and `package:electron*`: the active desktop shell and packaging scripts are Electron, not Tauri.
- [`apps/desktop/electron-builder.base.yml`](../apps/desktop/electron-builder.base.yml), `win.target` and `nsis`: selects NSIS and `build/installer.nsh`. It does **not** override `oneClick`, `perMachine`, or `win.requestedExecutionLevel`.
- [`electron-builder.yml`](../apps/desktop/electron-builder.yml), [`electron-builder.cloud.yml`](../apps/desktop/electron-builder.cloud.yml), and [`electron-builder.enterprise.yml`](../apps/desktop/electron-builder.enterprise.yml) all extend that base without changing install scope.
- [`pnpm-lock.yaml`](../pnpm-lock.yaml), desktop importer and resolved dependencies: pins electron-builder/app-builder-lib **26.15.3** and electron-updater **6.8.3**. Their installed implementation was inspected, not just assumed from generic NSIS behavior.

The versioned dependency evidence is available in the published [app-builder-lib 26.15.3 package](https://unpkg.com/browse/app-builder-lib@26.15.3/):

| Dependency file / symbol | What it establishes |
| --- | --- |
| `out/targets/nsis/nsisOptions.d.ts`, `NsisOptions` | Defaults: `oneClick: true`, `perMachine: false`. `allowElevation` applies to assisted installers, not this default one-click mode. |
| `out/targets/nsis/NsisTarget.js`, `buildInstaller` / `configureDefines` | Sets one-click and machine-wide defines from those options. |
| `templates/nsis/installer.nsi`, `RequestExecutionLevel` | Requests `user` for this scope; requests `admin` for a machine-wide installer. |
| `templates/nsis/oneClick.nsh`, install-mode selection | Selects per-user installation for the current configuration. |
| `templates/nsis/multiUser.nsh`, `setInstallModePerUser` | Uses current-user shell context and HKCU installation registration. Resolves the user's Programs known folder, falling back to `$LocalAppData\Programs`, then appends the application folder. A previous HKCU location or `/D=` can override it. |
| `out/options/winOptions.d.ts`, `requestedExecutionLevel` | Application executable defaults to `asInvoker`; the repository does not override it to `requireAdministrator`. |

The normal destination is therefore the **user's** Programs folder, not machine-wide `Program Files`. Do not select a protected `/D=` location or run the installer as administrator for this proof of concept.

[`apps/desktop/build/installer.nsh`](../apps/desktop/build/installer.nsh) contains only an uninstall hook that removes a user branding shortcut/marker. There is no custom install-time service, driver, prerequisite, firewall-rule, or elevation action. The `afterPack`/`afterSign` hooks are **build-time** hooks, not customer post-install scripts. Native code, Electron, and OpenCode sidecars are packaged with the app; no Node/Bun/Rust development installation or WebView2 bootstrap is part of the current installer path.

### Updates are not an unconditional no-UAC guarantee

[`apps/desktop/electron/updater.mjs`](../apps/desktop/electron/updater.mjs), `registerUpdaterIpc`, uses electron-updater, stages downloads, and can install on quit or explicit restart. A normally writable per-user installation should update as that user.

The published [electron-updater 6.8.3 package](https://unpkg.com/browse/electron-updater@6.8.3/), `out/NsisUpdater.js`, `doInstall`, normally launches the installer directly. It can invoke `elevate.exe` when update metadata requires administrator rights or after `UNKNOWN` / `EACCES` launch errors. The builder packages the elevation helper by default even for per-user installs. Its presence does **not** mean first installation requires elevation, but it prevents promising that every update path will never show UAC. Protected previous locations, a legacy machine-wide installation, or endpoint blocks need separate handling by IT—not a suggestion to bypass policy.

### Historical Tauri packages differ

The historical [`v0.13.3` Tauri config](https://github.com/different-ai/openwork/blob/v0.13.3/apps/desktop/src-tauri/tauri.conf.json) did not select a Windows per-user mode. Its [release workflow](https://github.com/different-ai/openwork/blob/v0.13.3/.github/workflows/release-macos-aarch64.yml) explicitly passed `--bundles msi` on Windows.

The [Tauri 2.10.3 WiX template](https://github.com/tauri-apps/tauri/blob/tauri-v2.10.3/crates/tauri-bundler/src/bundle/windows/msi/main.wxs) declares `InstallScope="perMachine"` and conditionally installs WebView2. Tauri NSIS's separate `currentUser` default does not establish that an MSI is per-user. Confirm the actual artifact; migration/uninstallation of an old machine-wide build may need IT even when a fresh Electron installation does not.

## macOS evidence

- [`apps/desktop/electron-builder.base.yml`](../apps/desktop/electron-builder.base.yml), `mac.target`: builds **DMG and ZIP**, not a PKG. These deliver an app bundle to copy, rather than a privileged package with post-install scripts.
- The base config sets hardened runtime and entitlements. `notarize: false` there disables the builder's built-in notarizer; it does **not** mean releases are deliberately unnotarized. [`electron-after-sign.cjs`](../apps/desktop/scripts/electron-after-sign.cjs), `afterSign`, submits with `notarytool`, staples, and verifies the app when `MACOS_NOTARIZE=true`. The [release workflow](../.github/workflows/release-macos-aarch64.yml), “Reject unnotarized macOS Electron release” and “Package Electron (macOS, signed + notarized),” requires this path.
- [`apps/desktop/electron/main.mjs`](../apps/desktop/electron/main.mjs) contains no `moveToApplicationsFolder` / forced relocation flow. Its application discovery includes `~/Applications`. Normal startup does not require installation into `/Applications`.
- [`build/entitlements.mac.plist`](../apps/desktop/build/entitlements.mac.plist) declares runtime/audio/AppleEvents entitlements; it does not install a privileged helper, system extension, or driver. The Computer Use helper is bundled inside the app (`mac.extraResources`), not installed as a root service.

**User procedure:** obtain the approved signed/notarized release; mount the DMG or extract the ZIP; copy the complete `.app` into `~/Applications`; launch that copy and eject the DMG. Do not assume the DMG's shared Applications shortcut is the non-admin destination. Do not run from the read-only DMG as the permanent installation, disable Gatekeeper, or remove quarantine to work around organizational controls.

Gatekeeper/download confirmation is distinct from administrator elevation. MDM may still prohibit apps outside shared `/Applications` or require IT approval even for a valid Developer ID signature. Verify the exact downloaded artifact rather than inferring signature/notarization status solely from build configuration.

**Updates:** [`updater.mjs`](../apps/desktop/electron/updater.mjs), `enableSquirrelDirectContentsWrite` and `staleUpdaterStatePaths`, configures Squirrel.Mac to write application contents in place, with cache under the user's `~/Library/Caches`. A user-owned app should be writable; an IT-owned/protected app may need authorization or fail to update. Test first install and update separately.

## Runtime: ordinary user rights, with feature/policy caveats

### Writable state and workspace locations

These are the default paths without environment overrides (macOS also honors relevant XDG overrides):

| State | Windows | macOS | Repository evidence |
| --- | --- | --- | --- |
| Electron profile, logs, server tokens/state | `%APPDATA%\com.differentai.openwork` | `~/Library/Application Support/com.differentai.openwork` | [`main.mjs`](../apps/desktop/electron/main.mjs), profile setup; [`dev-profile.mjs`](../apps/desktop/electron/dev-profile.mjs), `resolveUserDataPath`; [`runtime.mjs`](../apps/desktop/electron/runtime.mjs), server state/log paths |
| Server config / default runtime DB | `%APPDATA%\openwork` | `~/.config/openwork` | [`packages/paths/index.mjs`](../packages/paths/index.mjs), `openworkServerConfigPath`; [`runtime-db.ts`](../apps/server/src/runtime-db.ts), DB path resolution |
| Desktop bootstrap | `%LOCALAPPDATA%\openwork\desktop-bootstrap.json` | `~/.config/openwork/desktop-bootstrap.json` | [`packages/paths/index.mjs`](../packages/paths/index.mjs), bootstrap resolution |
| Global OpenCode config | `~/.config/opencode` in the user's home | `~/.config/opencode` | [`packages/paths/index.mjs`](../packages/paths/index.mjs), OpenCode config resolution |
| Default new local workspace | `OpenWork Chat` under the user's home | `~/OpenWork Chat` | [`workspace-store.mjs`](../apps/desktop/electron/workspace-store.mjs), `bootstrapFirstLaunchWorkspace` and workspace creation |

Selected workspace folders also receive `.opencode` configuration and agent-created files. The user must be allowed to create/write/rename files there and in profile/config/cache/temp directories. Controlled Folder Access, redirected/read-only profiles, or restricted Documents/home folders can block this independently of admin rights. Overrides pointing to system locations can introduce permission requirements; `OPENWORK_ELECTRON_USERDATA` alone does not redirect all OpenWork/OpenCode state.

[`runtime.mjs`](../apps/desktop/electron/runtime.mjs) discovers packaged engines and launches the embedded OpenWork server. [`managed-opencode.ts`](../apps/server/src/managed-opencode.ts) and [`managed-opencode-v2.ts`](../apps/server/src/managed-opencode-v2.ts) launch ordinary engine child processes. No mandatory Windows Service, launch daemon, kernel driver, or privileged scheduler installation was found in this desktop path. Local automation runs in the desktop process ([`automation-runner.mjs`](../apps/desktop/electron/automation-runner.mjs)); it is not an always-on system service.

Optional/fallback engine installation in [`opencode-v2-binary.ts`](../apps/server/src/opencode-v2-binary.ts) downloads a pinned, integrity-checked binary into runtime storage and extracts it with `tar`. [`opencode-v2-artifacts.json`](../apps/server/src/opencode-v2-artifacts.json) currently points to `registry.npmjs.org`. This still needs permission to download and execute profile-resident binaries; it is not a request for administrator rights. Optional tools/integrations can have their own external prerequisites, not guaranteed by the desktop installer.

### Network, credentials, and privacy

| Area | Finding / what IT must allow |
| --- | --- |
| Local listeners | Desktop [`runtime.mjs`](../apps/desktop/electron/runtime.mjs) binds the embedded server to `127.0.0.1`, selecting an available port; managed engines and [`ui-control-server.mjs`](../apps/desktop/electron/ui-control-server.mjs) also use loopback/dynamic ports. No privileged fixed port or firewall-rule installation is required by this path. Loopback is not a guarantee against EDR/firewall blocks or prompts. A separate LAN/self-hosted server configuration needs its own review. |
| Outbound traffic | Allow the chosen control plane/authentication/inference and MCP destinations, plus release/update assets and any enabled runtime downloads over HTTPS. The exact list depends on distribution, organization URLs, model provider and integrations; do not use a blanket “allow all” rule. Proxy and TLS inspection must work for the app **and** engine subprocesses. |
| Corporate certificates | [`system-ca.mjs`](../apps/desktop/electron/system-ca.mjs) reads Windows CurrentUser/LocalMachine Root/CA stores or macOS system keychains; [`runtime.mjs`](../apps/desktop/electron/runtime.mjs) exports a PEM into userData. It does not install system trust roots. IT must provision necessary roots separately; certificate-store enumeration can itself be policy-blocked. |
| Credential protection | [`secure-vault-key.mjs`](../apps/desktop/electron/secure-vault-key.mjs) uses Electron `safeStorage` lazily for managed OAuth vault keys. Usable OS credential storage is needed; macOS keychain access may prompt the user, not require a system-keychain installation. This is not a claim that all app settings/tokens are encrypted by this vault. |
| Basic chat / file work | Does not require macOS Accessibility or Screen Recording simply to install/use the basic flow. File access is still limited by the user's rights, macOS privacy controls, and endpoint policy. |
| Local Computer Use | [`computer-local.mjs`](../apps/desktop/electron/computer-local.mjs) requires macOS 14+, Accessibility and Screen Recording consent. Granting these can require authentication/IT approval or be restricted by MDM. They are **not** bypassed by a non-admin install. This native local-control path is not supported on Windows. |
| App scripting / microphone | [`computer-scripting.mjs`](../apps/desktop/electron/computer-scripting.mjs) uses macOS `osascript`, with per-target Automation consent. Audio/dictation requires OS microphone/voice-typing permission. These are optional feature permissions, not install prerequisites. |
| Windows child processes | Terminal, shortcut repair, CA export, and dictation paths use native executables, PowerShell/COM or PTYs (see [`main.mjs`](../apps/desktop/electron/main.mjs), [`windows-shortcut.mjs`](../apps/desktop/electron/windows-shortcut.mjs), [`system-ca.mjs`](../apps/desktop/electron/system-ca.mjs), [`native-dictation.mjs`](../apps/desktop/electron/native-dictation.mjs)). AppLocker/WDAC/Defender and PowerShell restrictions may block features. Scope approvals to the pilot; do not disable protections or run the whole app elevated as a workaround. |

## Recommendations and acceptance checklist

1. **Start with fresh, current Electron per-user installs.** Windows: normal NSIS `.exe` launch as the standard user. macOS: user-owned `~/Applications` copy. Ask IT to approve the exact signed package/publisher, app/helper/engine binaries and native modules, profile execution locations, writable state/workspace paths, loopback communication, and required HTTPS destinations. A per-user install does not make the software trusted under enterprise policy.
2. **No installer config change is necessary to enable this path.** Current defaults already select per-user Windows installation, and macOS already ships copyable app bundles. For future hardening, explicitly pinning `nsis.oneClick: true` and `nsis.perMachine: false` would document the existing intent; it is not an enablement fix. `allowElevation: false` alone would not remove electron-updater's separate fallback. This PR deliberately changes documentation only, not packaging/update behavior.
3. **Keep the first pilot narrow:** basic sign-in, chat, and work on an approved writable folder. Add local Computer Use, scripting, dictation, extra tools and integrations only after their policy/privacy requirements are approved. If user-profile execution is forbidden, use an IT-managed deployment rather than trying to evade it. Machine-wide/bootstrap ACL enforcement and certificate distribution are separate IT-managed steps; see [desktop policies](desktop-app-policies.md) for app policy scope.
4. **Validate on real standard-user accounts before promising support.** Existing [`evals/packages/hosts/src/windows-release.ts`](../evals/packages/hosts/src/windows-release.ts), install/launch stages, explicitly uses the signed-in **Administrator** account; it is not non-admin evidence. A browser-only UI test cannot prove installer elevation behavior either.

For each approved Windows architecture/distribution and macOS architecture/distribution, record:

- [ ] OS/version, actual non-admin account status, package version/checksum and signature/notarization verdict.
- [ ] Clean install without administrator credentials/UAC elevation; destination, owner/ACLs and user registration/shortcuts. On Mac, verify the running bundle is the `~/Applications` copy, not the DMG copy.
- [ ] First launch, sign-in/browser callback, workspace creation, file write/read, engine startup and one model request with corporate proxy/security controls active.
- [ ] Credential storage access, restart and persisted state, without writes to protected system locations.
- [ ] Download/stage/apply a real update (explicit restart and install-on-quit paths), then verify the new on-disk version without elevation.
- [ ] Uninstall/app removal as the same user; document which user data remains. Test legacy MSI migration separately with IT.
- [ ] Optional features only if included in the pilot; record any privacy prompts, denied operations, application-control or firewall events and the exact IT approval needed.

**Suggested external wording:** “We verified normal and silent installation and uninstallation of the official Windows x64 v0.18.59 installer using a real non-administrator account with UAC enabled on a clean Windows Server VM. The first launch showed a runtime startup error; after a same-user reinstall, the app reached its normal composer and checked for updates successfully. Applying an update and your managed Windows image are not yet validated. Your endpoint policies still need to permit the app and its runtime. We recommend a standard-user first-run and update-application check on your managed image before confirming the pilot. macOS remains source-reviewed, not empirically tested.”
