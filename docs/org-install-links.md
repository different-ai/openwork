# Organization Install Links

Status: self-host operator guide
Owner: platform/self-host
Related: `ee/apps/den-api/src/install-links.ts`, `ee/apps/den-api/src/routes/org/install-links.ts`, `ee/apps/den-api/src/utils/installer-artifacts.ts`, `packaging/helm/openwork-ee/README.md`

## What it is

Organization install links let workspace members mint shareable desktop install
links for their workspace. When the capability is enabled, invitation emails
automatically use the same organization-specific install page as the dashboard.
Den packages the normal signed OpenWork DMG or EXE with an organization-specific
`desktop-bootstrap.json`. The standard desktop app imports that file on first
launch. There is no second installer application to build, sign, publish, or
deploy. The installed app still requires sign-in against your deployment, so
possession of an install link does not grant workspace access.

For pairing an already-installed OpenWork Enterprise app with your deployment
via a signed `openwork://connect` link, see
[OpenWork Enterprise Installer and Signed Connect Links](./enterprise-connect-link.md).

## Upgrade checklist

> **Self-host default:** Install links are active by default when deployment
> gating is off. Hosted installations can set
> `DEN_INSTALL_LINKS_GATING_ENABLED=true` to keep per-organization opt-in.

### Helm

1. Keep `migrations.enabled=true` for the upgrade. The migration Job creates
   the `install_link` table automatically; see the
   [Helm migration Job docs](../packaging/helm/openwork-ee/README.md#migrations).
2. Restart/roll the deployment with the new values. No install-link capability
   toggle is required for normal self-hosted installations.
3. If you intentionally want hosted-style rollout, set
   `DEN_INSTALL_LINKS_GATING_ENABLED=true`, configure
   `config.public.bootstrapAdminEmails`, then enable `Install links` per org in
   `/admin`.

### Docker Compose

1. Run the migration once from the repo root:

   ```bash
   docker compose -f packaging/docker/docker-compose.den-dev.yml exec den sh -lc "pnpm --dir /app/ee/packages/den-db run db:bootstrap"
   ```

   If your stack was launched with a custom Compose project name, include the
   same `-p <project>` flag.
2. Restart Den. Install links are active by default.
3. For hosted-style rollout only, set
   `DEN_INSTALL_LINKS_GATING_ENABLED=true` and `DEN_BOOTSTRAP_ADMIN_EMAILS`,
   then enable `Install links` per org in `/admin`.

## Public origins requirement

> **Hard requirement:** Set `BETTER_AUTH_URL` to the externally reachable
> den-web origin (for example, `https://openwork.example.com`). Dashboard and
> invitation-email install links are built from this value. Set
> `DEN_API_PUBLIC_URL` to the Den API origin that invitees' computers can reach.

Invitation acceptance links use the first non-wildcard entry of
`DEN_BETTER_AUTH_TRUSTED_ORIGINS`, falling back to `BETTER_AUTH_URL`. In the
normal single-origin setup, put the same den-web origin in both settings.

## Installer artifacts

Den resolves the standard signed Mac and Windows desktop artifacts in this order:

1. `OPENWORK_INSTALLER_ARTIFACTS_DIR`, when set and the file exists.
2. `OPENWORK_INSTALLER_CACHE_DIR/<tag>/<file>`, defaulting to the OS temp dir.
3. The GitHub release asset for `OPENWORK_INSTALLER_RELEASE_REPO` and
   `OPENWORK_INSTALLER_RELEASE_TAG`.
4. If the artifact is unavailable, a verified direct normal desktop download.
   If that is also unavailable, the stable OpenWork download page.

| Mode | Configure | Behavior |
|---|---|---|
| Internet-connected | Default. `OPENWORK_INSTALLER_RELEASE_TAG` resolves to `v<pinned app version>`; override it when needed. | Den downloads the normal public DMG/EXE on the first organization download, caches it, and creates the ZIP at request time. If Den cannot fetch it, the browser is redirected to the verified normal DMG/EXE without including the organization token. |
| Fork/mirror | Set `OPENWORK_INSTALLER_RELEASE_REPO`, for example `your-org/openwork`. | Den downloads assets from your fork or mirror release instead of `different-ai/openwork`. |
| Air-gapped | Mount a volume at `OPENWORK_INSTALLER_ARTIFACTS_DIR` containing the normal versioned assets, for example `openwork-mac-arm64-0.18.0.dmg`, `openwork-mac-x64-0.18.0.dmg`, and `openwork-win-x64-0.18.0.exe`, matching `OPENWORK_INSTALLER_RELEASE_TAG=v0.18.0`. | The mounted artifact directory takes precedence. Den adds `desktop-bootstrap.json` without modifying the signed installer bytes and requires zero egress. |

## Egress

`den-api` makes outbound HTTPS requests to `github.com` only when serving a Mac
or Windows organization download and the standard artifact is not already
cached, or when it verifies a normal release fallback. The Linux setup script
and every other install-link feature need no egress.

## ZIP and first-launch behavior

The Mac and Windows download contains exactly two top-level files:

1. The normal versioned OpenWork DMG or EXE published with the release.
2. `desktop-bootstrap.json`, containing the web/API origins, sign-in policy,
   display name, logo URL, and a `writtenAt` timestamp.

Extract the ZIP and keep both files in the same folder while running the normal
installer. On first launch, OpenWork searches the Downloads and Desktop folders
(and one extracted folder level below them) for `desktop-bootstrap.json` beside
a normally named OpenWork release artifact. A valid bundle is copied to the
canonical per-user path before the runtime boots. A bundle never replaces a
canonical or legacy config with a newer `writtenAt` value.

`OPENWORK_BOOTSTRAP_BUNDLE_DIR` can point the desktop at one specific extracted
bundle directory for managed rollouts and deterministic validation.

## Distribute configuration with MDM (no custom installer)

You can deploy the standard public OpenWork desktop installer and point it at
your self-hosted control plane by managing one JSON file. No custom installer is
required.

OpenWork reads `desktop-bootstrap.json` from the same canonical path used by the
installer and bootstrap CLI:

| OS | Canonical path |
|---|---|
| Windows | `%LOCALAPPDATA%\openwork\desktop-bootstrap.json` (`%XDG_CONFIG_HOME%\openwork\desktop-bootstrap.json` wins first if your environment sets it) |
| macOS/Linux | `$XDG_CONFIG_HOME/openwork/desktop-bootstrap.json`, falling back to `~/.config/openwork/desktop-bootstrap.json` |

Older desktop builds also wrote `~/.config/openwork/desktop-bootstrap.json` on
every OS. Current builds still read that legacy file for compatibility; when
both files exist and parse, the config with the newest `writtenAt` timestamp
wins. If `writtenAt` is missing or invalid, OpenWork falls back to the file
mtime for that file. When the legacy file wins, OpenWork migrates it to the
canonical path. The installer also cleans up a stale legacy twin after writing
the canonical file.

Schema:

```json
{
  "baseUrl": "https://openwork.example.com",
  "apiBaseUrl": "https://api.openwork.example.com",
  "requireSignin": true,
  "writtenAt": "2026-07-07T12:00:00.000Z"
}
```

- `baseUrl` is required and should be your den-web origin.
- `apiBaseUrl` is optional when your web origin proxies Den API traffic, but is
  recommended for split web/API deployments.
- `requireSignin` should be `true` for organization-managed installs.
- `writtenAt` should be an ISO timestamp; use a fresh value whenever MDM rolls
  out a replacement config so the newest file wins deterministically.

For MDM tools such as ManageEngine, deploy the public installer, then write this
file to the canonical path for each user profile. The public installer plus this
managed file is enough for a fully self-hosted desktop rollout.

## Security notes

- Install-link tokens are stored SHA-256 hashed.
- Minting a new link does not revoke older links, so previously distributed
  invitation emails and dashboard links keep working. An owner or admin can
  explicitly rotate links to revoke every older active link for the workspace.
- A leaked link reveals the org name and server URLs only; users still must
  sign in to access the workspace.
- Public install-link endpoints are rate-limited.
- The signed DMG/EXE bytes are copied into the ZIP unchanged, so Gatekeeper and
  Windows signature verification still apply to the standard release artifact.
- The desktop only imports a downloaded bootstrap when it is beside a standard
  versioned OpenWork installer filename, and only when it is newer than the
  current canonical or legacy configuration.

## Troubleshooting

| Symptom | Fix |
|---|---|
| A download goes directly to the normal OpenWork installer instead of returning a ZIP | Den could not obtain the standard versioned asset. Internet-connected deployments should verify the release tag/repository; air-gapped deployments should mount the matching DMG/EXE files through `OPENWORK_INSTALLER_ARTIFACTS_DIR`. The direct download is an intentional fallback and contains no organization token. |
| OpenWork does not import the setup file | Extract the ZIP so `desktop-bootstrap.json` remains beside the versioned DMG/EXE, then launch the installed app. Check whether a newer canonical bootstrap already exists. Managed deployments can set `OPENWORK_BOOTSTRAP_BUNDLE_DIR` explicitly. |
| Install links point at the wrong host | Set `BETTER_AUTH_URL` to the externally reachable den-web origin, then restart `den-api`. For invitation acceptance links, also put that origin first in `DEN_BETTER_AUTH_TRUSTED_ORIGINS`. |
| Re-uploaded assets under the same tag keep serving old bytes | Clear the installer cache directory or bump the tag. The cache key is `<cacheDir>/<tag>/<file>`. |
