# Organization install links

Status: self-host operator guide

Owner: platform/self-host

Related: `ee/apps/den-api/src/routes/org/install-links.ts`, `apps/installer`, `packages/install-config`

## What users download

Organization install links let workspace members download the normal signed
OpenWork desktop application already configured for their organization. Den
does not compile a different OpenWork application for every organization.
Instead, it creates one ZIP from three independently verifiable inputs:

1. The generic signed **OpenWork Installer** for the selected platform.
2. The unchanged standard signed OpenWork DMG or EXE for the Den-supported app
   version.
3. `openwork-installer.json`, containing the deployment and branding settings.

The user explicitly launches the installer. It shows the organization name and
server URL before making changes, writes `desktop-bootstrap.json` to the
canonical per-user location, installs the adjacent standard app artifact, and
then launches OpenWork. The desktop app never searches Downloads or Desktop for
configuration files.

Possession of an install link or setup ZIP does not create a workspace session.
Users must still authenticate against the configured deployment.

## Self-host rollout

Install links are active by default when deployment gating is off. Hosted
installations can set `DEN_INSTALL_LINKS_GATING_ENABLED=true` to require
per-organization opt-in.

### Required public origins

- `BETTER_AUTH_URL`: externally reachable Den Web origin, for example
  `https://openwork.example.com`.
- `DEN_API_PUBLIC_URL`: externally reachable Den API origin. Path prefixes are
  preserved.
- `DEN_BETTER_AUTH_TRUSTED_ORIGINS`: put the Den Web origin first so invitation
  and authentication links never point to localhost.

### Helm

1. Keep `migrations.enabled=true` for the upgrade that creates the install-link
   table.
2. Configure the public origins above.
3. Choose connected, mirrored, or air-gapped artifact delivery below.
4. Restart the deployment. No raw database or feature-flag change is required
   for normal self-hosted installations.

## Artifact delivery

`OPENWORK_INSTALLER_RELEASE_TAG` pins both the standard app and generic
installer to one release. Den resolves each required artifact in this order:

1. `OPENWORK_INSTALLER_ARTIFACTS_DIR`.
2. `OPENWORK_INSTALLER_CACHE_DIR/<tag>/<file>`.
3. `https://github.com/<OPENWORK_INSTALLER_RELEASE_REPO>/releases/download/<tag>/<file>`.

For release `v0.18.0`, a complete Mac/Windows artifact set is:

```text
openwork-installer-mac-arm64.zip
openwork-installer-mac-x64.zip
openwork-installer-win-x64.exe
openwork-mac-arm64-0.18.0.dmg
openwork-mac-x64-0.18.0.dmg
openwork-win-x64-0.18.0.exe
```

The generic Mac ZIP contains the signed and notarized `OpenWork Installer.app`.
The generic Windows EXE is the release installer launcher and is signed when
Windows signing is enabled for that release. Den does not modify either
executable or the standard app artifact; it only combines them with the
organization JSON in the downloaded ZIP.

### Fully air-gapped / zero public egress

Mount all six matching files above into
`OPENWORK_INSTALLER_ARTIFACTS_DIR`. Den then builds organization downloads
entirely from the mounted volume. The end-user installer uses the standard DMG
or EXE already beside it, so neither Den nor the user device needs GitHub.

The user device still needs HTTPS access to services that are part of the
customer deployment:

- the configured Den Web origin;
- the configured Den API origin;
- the host serving `logoUrl` and `iconUrl` (normally Den itself);
- the organization's identity provider if interactive SSO is required;
- any MCP or SaaS endpoints the organization intentionally enables after
  installation.

Keep uploaded branding assets on the on-prem Den origin to avoid adding an
external image CDN to the client allowlist.

The macOS installer app and DMG are notarized and stapled by the release
workflows. Apple documents that a stapled notarization ticket lets Gatekeeper
verify a distribution without a network connection:
https://developer.apple.com/documentation/security/customizing-the-notarization-workflow.

### Connected deployment allowlist

When artifacts are not mounted or mirrored, **Den API**, not each desktop,
downloads them over outbound TCP 443. Allow:

```text
github.com
*.githubusercontent.com
```

The first host serves the stable release URL; GitHub may redirect the artifact
body to a `githubusercontent.com` release host. GitHub's firewall guidance uses
the same wildcard for action and release downloads:
https://docs.github.com/en/code-security/reference/supply-chain-security/automatic-dependency-submission#configure-network-access-for-self-hosted-runners.

If policy forbids wildcard external hosts, mount the release files through
`OPENWORK_INSTALLER_ARTIFACTS_DIR` or pre-populate
`OPENWORK_INSTALLER_CACHE_DIR/<tag>/`. `OPENWORK_INSTALLER_RELEASE_REPO`
selects a repository on `github.com`; it does not change the release host to an
arbitrary internal mirror. Mounted artifacts are preferable to depending on
changing CDN IP addresses.

For Microsoft Entra sign-in, the normal global-cloud browser authentication
endpoint is `login.microsoftonline.com`; sovereign clouds use different hosts.
Conditional Access, device registration, federation, and other providers may
require additional customer-specific endpoints. Follow the identity provider's
official network requirements rather than treating this installer list as a
complete SSO allowlist.

For an external MCP or SaaS connection, allow the exact customer endpoint from
the component that executes that connection. For example, a ServiceNow MCP
connection normally needs outbound TCP 443 from OpenWork Connect / Den to the
customer instance such as `https://example.service-now.com`; its OAuth browser
also needs that instance and the configured Den callback origin. Private DNS,
private endpoints, proxies, or customer-managed certificate authorities add
deployment-specific requirements and should not be replaced with a blanket
public wildcard.

## Bundle contents and explicit selection

Mac:

```text
OpenWork Installer.app/
openwork-installer.json
openwork-mac-arm64-0.18.0.dmg
```

Windows:

```text
OpenWork Installer.exe
openwork-installer.json
openwork-win-x64-0.18.0.exe
```

The installer reads only the JSON beside the installer the user launched. Two
old or testing bundles can coexist in Downloads without affecting the installed
app. Switching deployments requires launching the other installer and
confirming the new organization and server address.

macOS App Translocation is supported: if Gatekeeper relocates the running
installer, it resolves the original app path from the nullfs mount and reads the
JSON and DMG from that exact extracted bundle.

## Installer JSON

Example:

```json
{
  "schemaVersion": 1,
  "appName": "Example Work",
  "appVersion": "0.18.0",
  "clientName": "Example Corporation",
  "webUrl": "https://openwork.example.com",
  "apiUrl": "https://openwork-api.example.com",
  "requireSignin": true,
  "logoUrl": "https://openwork.example.com/v1/brand-assets/wordmark.png",
  "iconUrl": "https://openwork.example.com/v1/brand-assets/icon.png"
}
```

- `logoUrl` is the wordmark used inside OpenWork and on sign-in surfaces.
- `iconUrl` is the square image used for the macOS Dock and Windows native
  shortcut/taskbar surfaces.
- `appVersion` identifies the adjacent standard signed app artifact, removing
  the need to contact release hosting or query version metadata during an
  air-gapped install.
- The JSON contains no install token, auth session, or long-lived secret.

The installer writes the normalized result here:

| OS | Canonical path |
|---|---|
| Windows | `%LOCALAPPDATA%\openwork\desktop-bootstrap.json` |
| macOS/Linux | `$XDG_CONFIG_HOME/openwork/desktop-bootstrap.json`, otherwise `~/.config/openwork/desktop-bootstrap.json` |

Existing Tauri/Electron compatibility rules still read the legacy
`~/.config/openwork/desktop-bootstrap.json` path and migrate the newest valid
state. Standard desktop updates do not invoke the organization installer, so
upgrading the app preserves the canonical deployment configuration.

## MDM deployment

MDM can continue to deploy the standard public OpenWork installer and write
`desktop-bootstrap.json` directly to the canonical path. This bypasses the
interactive generic installer and is appropriate when endpoint management
already provides deterministic per-user file placement.

## Security properties

- Install-link tokens are stored as SHA-256 hashes.
- Downloaded JSON contains deployment/branding data but no authentication
  session.
- The installer requires explicit confirmation before applying a deployment.
- The standard app and generic installer signatures remain byte-identical to
  their release assets.
- The native app validates and bounds downloaded icon images before caching
  them.
- Admins can rotate install links to revoke older links; existing downloaded
  ZIPs remain configuration media but still grant no workspace access.

## Troubleshooting

| Symptom | Resolution |
|---|---|
| Download redirects to the normal public app instead of returning an organization ZIP | Den could not resolve either the generic installer or standard app artifact. Mount the complete matching artifact set or repair GitHub/mirror access. |
| Installer asks for an install link | `openwork-installer.json` is missing or was separated from the launched installer. Re-extract the organization ZIP and keep its files together. |
| Installer tries to reach GitHub | The adjacent standard artifact filename does not match `appVersion`/platform, or it is missing. Mount/package the matching release artifact. |
| Wrong organization is shown | Exit without confirming, then launch the installer from the intended extracted bundle. Files elsewhere are ignored. |
| Branding text appears but the native icon does not | Verify `iconUrl` is the square managed icon URL and that the desktop can reach its host over HTTPS. |
| Install links point at localhost or the wrong host | Correct `BETTER_AUTH_URL`, `DEN_API_PUBLIC_URL`, and `DEN_BETTER_AUTH_TRUSTED_ORIGINS`, then restart Den API. |
