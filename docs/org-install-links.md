# Desktop Install Page

Status: self-host operator guide

Owner: platform/self-host
Related: `ee/apps/den-api/src/routes/org/install-links.ts`, `packaging/helm/openwork-ee/README.md`

## What users get

Every Den has one install page, `/install`. Download OpenWork and Copy install
link share that address; it carries no token and can be shared freely.

1. People open `/install` and sign in (or are sent through SSO and back).
2. Den offers the standard OpenWork installer approved for their organization.
3. After installing, they sign in to the desktop app with the same account.

This flow does not build a customer-specific installer or ZIP, and the page
never signs anyone in. The public `/desktop` and landing-page downloads keep
their existing behavior.

## Older install links

Earlier versions shared one-off `/install?token=…` links and a short-lived
**Open OpenWork** connection code. Den no longer creates either:

- `/install?token=…` opens the normal install page; the token is ignored and
  removed from the address.
- `GET /v1/install-config` stays public for desktop builds that resolve a
  pasted install link there. It ignores the token and returns only the
  deployment's public setup: server addresses and that sign-in is required. It
  names no organization; people see their organization after signing in.
- `GET /v1/install/:platform?token=…` redirects to the install page.
- Connection codes expired five minutes after they were issued, so none remain.

The `install_link` and `desktop_connect_grant` tables are no longer read or
written. A later migration drops them.

## Public origins

Set `DEN_BASE_URL` to the externally reachable Den web origin, for example
`https://openwork.example.com`. Den derives Better Auth, CORS/trusted origins,
web-app hosts, API defaults, and MCP resource defaults from that one value. Set
`DEN_API_PUBLIC_URL` only as a compatibility override when you publish a separate
Den API origin or an externally reachable proxy path, such as
`https://openwork.example.com/api/den`. If you publish a separate Den API origin,
browsers downloading from the install page and external MCP clients must be able to reach it.

Invitation acceptance links use the first non-wildcard trusted origin. In the
single-origin setup this is derived from `DEN_BASE_URL`; set
`DEN_BETTER_AUTH_TRUSTED_ORIGINS` only when you need extra web origins during a
migration.

## Installer delivery

Customer-facing planning guidance for this section is published at
[`packages/docs/start-here/installer-delivery.mdx`](../packages/docs/start-here/installer-delivery.mdx).
This repository page remains authoritative for implementation and security
details.

Den first checks the signed-in member's organization. It then chooses exactly
one of these paths:

| Deployment | Download behavior | Required client access |
|---|---|---|
| Internet-connected | Immediate `302` to the exact standard asset under `OPENWORK_INSTALLER_RELEASE_REPO` and `OPENWORK_INSTALLER_RELEASE_TAG`. | Den web/API, `github.com`, `release-assets.githubusercontent.com`, and `objects.githubusercontent.com` for legacy or rollback paths. |
| Semi-air-gapped | Stream the matching standard installer from `OPENWORK_INSTALLER_ARTIFACTS_DIR`. There is no ZIP or in-memory whole-file buffer. | Den web/API only. |
| Fully internal installer delivery | Same mounted-artifact path, with Den web/API and the installer artifact available entirely inside the isolated network. This describes installer bytes only, not full product isolation. | Internal Den web/API only. |

The filenames use the release tag without a leading `v` and a distribution prefix: `openwork-enterprise-` on a single-org (self-hosted) Den, `openwork-cloud-` on the multi-org hosted Den. The public `openwork-<platform>-<version>` names are never served by the install page.

- `openwork-enterprise-mac-arm64-<version>.dmg`
- `openwork-enterprise-mac-x64-<version>.dmg`
- `openwork-enterprise-win-x64-<version>.exe`
- `openwork-enterprise-linux-x86_64-<version>.AppImage`
- `openwork-enterprise-linux-arm64-<version>.AppImage`

The version is `max(allowedDesktopVersions)` when the organization policy is set, else `OPENWORK_INSTALLER_RELEASE_TAG` when set, else the Den's own release version on a single-org Den (latest published stable release on the multi-org hosted Den).

There is no first-request GitHub download inside Den, artifact lookup API call,
ZIP creation, per-pod cold cache, or different repeated-download path. Every
internet-connected request redirects immediately. Every mounted request streams
the same provisioned file. With more than one Den API replica, mount the same
read-only PVC on every replica.

## MDM alternative

Customer-facing guidance for this path is published at
[`packages/docs/start-here/enterprise-desktop-deployment.mdx`](../packages/docs/start-here/enterprise-desktop-deployment.mdx).

Managed deployments can skip the deep-link handoff by deploying a standard
binary — typically the enterprise distribution
(`openwork-enterprise-<os>-<arch>-<version>.<ext>`, published on the
`enterprise` release channel), or the public installer — and writing
`desktop-bootstrap.json` directly:

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

## Troubleshooting

| Symptom | Fix |
|---|---|
| Download redirects to GitHub | Expected for internet-connected deployments. Allow `github.com` and its release-asset redirect/CDN host on the user's network. |
| The install page asks to sign in | Expected. People sign in with their Den account; the page then offers their organization's installer. |
| Mounted download fails | Verify the filename exactly matches the configured release tag and every Den replica mounts the same readable PVC path. |
| Install page points at the wrong web host | Correct `BETTER_AUTH_URL` and `DEN_BETTER_AUTH_TRUSTED_ORIGINS`, then restart Den. |
