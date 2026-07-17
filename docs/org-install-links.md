# Organization Install Links

Status: self-host operator guide

Owner: platform/self-host
Related: `ee/apps/den-api/src/install-links.ts`, `ee/apps/den-api/src/routes/org/install-links.ts`, `ee/apps/den-api/src/desktop-connect-grants.ts`, `packaging/helm/openwork-ee/README.md`

## What users get

An organization install link opens a three-step Den page:

1. Download and run the standard OpenWork installer.
2. Return to Den and click **Open OpenWork**.
3. Confirm the exact organization and server in the app, then complete normal
   organization sign-in.

This flow does not build a customer-specific installer or ZIP. Branding and
server configuration are applied only after the user confirms the deep link.
Possession of the install link never signs a user in or grants workspace
access.

The guided flow is scoped to Den organization install links. The public
`/desktop` and landing-page downloads keep their existing behavior.

## Upgrade checklist

> **Default:** Install links are active for every organization on every
> deployment. `DEN_INSTALL_LINKS_GATING_ENABLED` is deprecated and inert;
> platform admins can turn an org dark from `/admin` as a kill switch.

### Helm

1. Keep `migrations.enabled=true` for the upgrade. The migration Job creates
   both `install_link` and `desktop_connect_grant`.
2. Keep `config.public.connectLinkMode: exchange` (the default). No key is
   required.
3. Restart or roll the deployment. No install-link capability toggle is
   required for a normal self-hosted installation.
4. No hosted-style rollout flag is required: install links are on by default.
   `DEN_INSTALL_LINKS_GATING_ENABLED` is deprecated and inert; configure
   `config.public.bootstrapAdminEmails` only if platform admins need `/admin`
   access to turn an org dark as a kill switch.

### Docker Compose

Run the migration once, then restart Den:

```bash
docker compose -f packaging/docker/docker-compose.den-dev.yml exec den sh -lc \
  "node /app/ee/packages/den-db/dist/scripts/bootstrap.js"
```

If the stack has a custom Compose project name, include the same `-p <project>`
flag.

## Public origins

Set `BETTER_AUTH_URL` to the externally reachable Den web origin, for example
`https://openwork.example.com`. Set `DEN_API_PUBLIC_URL` to the externally
reachable Den API origin. The desktop must be able to reach both origins.

Invitation acceptance links use the first non-wildcard entry of
`DEN_BETTER_AUTH_TRUSTED_ORIGINS`, falling back to `BETTER_AUTH_URL`. In a
single-origin setup, use the Den web origin for both.

## Installer delivery

Den first validates the organization install token. It then chooses exactly
one of these paths:

| Deployment | Download behavior | Required client access |
|---|---|---|
| Internet-connected | Immediate `302` to the exact standard asset under `OPENWORK_INSTALLER_RELEASE_REPO` and `OPENWORK_INSTALLER_RELEASE_TAG`. The organization token is not forwarded. | Den web/API, `github.com`, and the GitHub release-asset redirect/CDN host. |
| Semi-air-gapped | Stream the matching standard installer from `OPENWORK_INSTALLER_ARTIFACTS_DIR`. There is no ZIP or in-memory whole-file buffer. | Den web/API only. |
| Fully air-gapped | Same mounted-artifact path, with Den web/API and the installer artifact available entirely inside the isolated network. | Internal Den web/API only. |

The standard filenames use the release tag without a leading `v`:

- `openwork-mac-arm64-<version>.dmg`
- `openwork-mac-x64-<version>.dmg`
- `openwork-win-x64-<version>.exe`
- `openwork-linux-x86_64-<version>.AppImage`
- `openwork-linux-arm64-<version>.AppImage`

There is no first-request GitHub download inside Den, artifact lookup API call,
ZIP creation, per-pod cold cache, or different repeated-download path. Every
internet-connected request redirects immediately. Every mounted request streams
the same provisioned file. With more than one Den API replica, mount the same
read-only PVC on every replica.

## Default connection handoff (no key)

`DEN_CONNECT_LINK_MODE=exchange` is the default. When the user clicks **Open
OpenWork**, Den mints a fresh five-minute bearer code and stores only its
SHA-256 hash. The app:

1. posts the code back to the exact HTTPS API origin carried in the deep link
   to preview the organization and server;
2. shows an explicit confirmation without changing local configuration; and
3. posts the code to the exchange endpoint after confirmation, consuming it
   exactly once before writing `desktop-bootstrap.json`.

The grant is stored in MySQL, not pod memory, so preview and consumption can
land on different Kubernetes replicas. A conditional database update makes
concurrent exchange attempts single-use. Expired rows are removed while new
grants are minted.

The web page fetches a new code at the moment the user clicks **Open**, rather
than relying on the code loaded before a potentially long installer run. If a
code expires or was already used, the user can return to the same Den page and
click **Open** again.

## Optional signed handoff

Signed handoffs remain an explicit upgrade path. They are disabled unless all
of the following are true:

- `DEN_CONNECT_LINK_MODE=signed`;
- `DEN_CONNECT_LINK_KEY_ID` is configured;
- `DEN_CONNECT_LINK_PRIVATE_KEY` contains the dedicated Ed25519 private key;
- the matching public key is already embedded in the desktop build.

For Helm:

```yaml
config:
  public:
    connectLinkMode: signed
    connectLinkKeyId: "owc-2026-07"

secret:
  values:
    connectLinkPrivateKey: |-
      -----BEGIN PRIVATE KEY-----
      ...
      -----END PRIVATE KEY-----
```

Generate a pair with `scripts/generate-connect-link-keypair.mjs`. Do not enable
signed mode until the production release embeds the corresponding public key.
This optional mode changes only the configuration handoff; it still downloads
the same standard installer through the same direct or mounted route.

## MDM alternative

Managed deployments can skip the deep-link handoff by deploying the public
installer and writing `desktop-bootstrap.json` directly:

| OS | Canonical path |
|---|---|
| Windows | `%LOCALAPPDATA%\openwork\desktop-bootstrap.json` (`%XDG_CONFIG_HOME%\openwork\desktop-bootstrap.json` wins if set) |
| macOS/Linux | `$XDG_CONFIG_HOME/openwork/desktop-bootstrap.json`, falling back to `~/.config/openwork/desktop-bootstrap.json` |

```json
{
  "baseUrl": "https://openwork.example.com",
  "apiBaseUrl": "https://api.openwork.example.com",
  "requireSignin": true,
  "writtenAt": "2026-07-14T12:00:00.000Z"
}
```

Current builds still read the older `~/.config/openwork` path for
compatibility. When both files exist, the valid configuration with the newest
`writtenAt` wins.

## Security properties

- Install-link tokens and exchange codes are stored only as SHA-256 hashes.
- Connection codes expire after five minutes and are consumed exactly once in
  MySQL across all Den API replicas.
- The desktop requires HTTPS outside explicit development loopback mode and
  refuses redirects during preview and exchange.
- Returned claims must identify the same API origin carried by the deep link.
- The app displays the exact organization and server before changing local
  configuration; cancel and every validation failure leave it untouched.
- Branding URLs from the keyless exchange are not loaded before confirmation.
- The standard release installer bytes are never modified, preserving normal
  macOS and Windows signature verification.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Download redirects to GitHub | Expected for internet-connected deployments. Allow `github.com` and its release-asset redirect/CDN host on the user's network. |
| Download returns `404` | The install token is invalid, expired, or revoked. Ask an org member for the current install page link. |
| Mounted download fails | Verify the filename exactly matches the configured release tag and every Den replica mounts the same readable PVC path. |
| **Open OpenWork** cannot prepare a connection | Verify the browser can reach Den API and `DEN_API_PUBLIC_URL` is the correct public HTTPS origin. |
| The app refuses an expired or used link | Return to the same Den install page and click **Open OpenWork** again to mint a fresh code. |
| Signed mode reports an unknown key | Return to `exchange` mode, or ship a desktop build containing the matching public key before re-enabling `signed`. |
| Install links point at the wrong web host | Correct `BETTER_AUTH_URL` and `DEN_BETTER_AUTH_TRUSTED_ORIGINS`, then restart Den. |
