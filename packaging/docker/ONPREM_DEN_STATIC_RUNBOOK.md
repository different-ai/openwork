# On-prem Den static worker production runbook

This runbook describes an operator-supported LAN/on-prem deployment where Den is the control plane and one or more pre-running OpenWork Host containers are the worker runtimes. Den does not create worker containers in `static` mode; it assigns each shared/cloud worker request to a healthy URL from `DEN_STATIC_WORKER_URLS`.

Semaphore is used below only as an example managed deployment tool. Equivalent MDM, configuration management, or release automation systems can apply the same inputs.

## Components and ports

- Den API/control plane: `http://<den-host>:8788`
- Den web UI: `http://<den-host>:3005`
- OpenWork worker: `http://<worker-host>:8787`

The production worker image is built from `packaging/docker/Dockerfile`. For source deployments, the Dockerfile builds the `openwork` orchestrator binary from the checked-out repository so approved server/runtime fixes are included in the worker image.

## Prerequisites

- Docker Engine with Compose v2 on each Den and worker host.
- CPU features compatible with the bundled sidecar runtime, including AVX-capable CPU flags exposed to the worker host.
- DNS, routing, and firewall rules that allow Den to reach each worker on port `8787` and browsers to reach Den web on port `3005`.
- A persistent workspace directory per worker, mounted at `/workspace` inside the worker container.
- A persistent data directory per worker, mounted at `/data` inside the worker container.
- Operator-managed worker bearer tokens. Production deployments should set `OPENWORK_TOKEN` and `OPENWORK_HOST_TOKEN` from a secret manager or equivalent secure configuration channel.
- A production email provider for sign-up, invitation, and verification email delivery. Configure `DEN_SMTP_*` or `DEN_RESEND_API_KEY` plus `DEN_EMAIL_FROM` before relying on user-facing email flows.

Generated worker tokens are a fallback for development or an operator-approved bootstrap only. When token generation is used, `/data/openwork-worker.env` contains sensitive bearer secrets and must be protected like any other secret file.

All commands below assume the repository root is available on the target host. Adjust paths to match your release checkout or deployment artifact location.

## 1. Plan worker identity and secrets

For each worker, record these operator-owned inputs before launch:

- Stable worker URL, for example `http://worker-01.company.local:8787`.
- Host port, usually `8787` per worker host.
- Workspace mount path.
- Data mount path.
- `OPENWORK_TOKEN` client bearer token from the secret manager.
- `OPENWORK_HOST_TOKEN` host/admin bearer token from the secret manager.

Use unique tokens per worker unless your security policy explicitly requires a different rotation model. Store the tokens outside source control and inject them at container launch time through the platform's secret mechanism.

## 2. Start one OpenWork worker

PowerShell:

```powershell
Set-Location D:\openwork\packaging\docker
$env:OPENWORK_HOST_PORT = "8787"
$env:OPENWORK_CONNECT_HOST = "worker-01.company.local"
$env:OPENWORK_WORKSPACE_DIR = "D:\openwork-data\worker-01\workspace"
$env:OPENWORK_DATA_DIR_HOST = "D:\openwork-data\worker-01\data"
$env:OPENWORK_TOKEN = "<secret-manager-client-token>"
$env:OPENWORK_HOST_TOKEN = "<secret-manager-host-token>"
docker compose -p openwork-worker-1 up --build -d
docker compose -p openwork-worker-1 ps
curl.exe http://worker-01.company.local:8787/health
```

Bash:

```bash
cd /path/to/openwork/packaging/docker
export OPENWORK_HOST_PORT=8787
export OPENWORK_CONNECT_HOST=worker-01.company.local
export OPENWORK_WORKSPACE_DIR=/srv/openwork/worker-01/workspace
export OPENWORK_DATA_DIR_HOST=/srv/openwork/worker-01/data
export OPENWORK_TOKEN='<secret-manager-client-token>'
export OPENWORK_HOST_TOKEN='<secret-manager-host-token>'
docker compose -p openwork-worker-1 up --build -d
docker compose -p openwork-worker-1 ps
curl http://worker-01.company.local:8787/health
```

Expected health result: HTTP 200 JSON from the OpenWork server. This URL is what Den should receive for the worker.

If an operator deliberately uses generated bootstrap tokens, retrieve them only through an approved secure access path and immediately store/rotate them according to site policy. Do not share `/data/openwork-worker.env`; it is sensitive because it contains bearer credentials.

## 3. Start multiple OpenWork workers

Run each worker with a unique Compose project, host port, workspace/data directory, token pair, and URL. Example for two workers on one host:

PowerShell:

```powershell
Set-Location D:\openwork\packaging\docker

$env:OPENWORK_HOST_PORT = "8787"
$env:OPENWORK_CONNECT_HOST = "worker-host.company.local"
$env:OPENWORK_WORKSPACE_DIR = "D:\openwork-data\worker-01\workspace"
$env:OPENWORK_DATA_DIR_HOST = "D:\openwork-data\worker-01\data"
$env:OPENWORK_TOKEN = "<worker-01-client-token>"
$env:OPENWORK_HOST_TOKEN = "<worker-01-host-token>"
docker compose -p openwork-worker-1 up --build -d

$env:OPENWORK_HOST_PORT = "8788"
$env:OPENWORK_CONNECT_HOST = "worker-host.company.local"
$env:OPENWORK_WORKSPACE_DIR = "D:\openwork-data\worker-02\workspace"
$env:OPENWORK_DATA_DIR_HOST = "D:\openwork-data\worker-02\data"
$env:OPENWORK_TOKEN = "<worker-02-client-token>"
$env:OPENWORK_HOST_TOKEN = "<worker-02-host-token>"
docker compose -p openwork-worker-2 up --build -d

curl.exe http://worker-host.company.local:8787/health
curl.exe http://worker-host.company.local:8788/health
```

Bash:

```bash
cd /path/to/openwork/packaging/docker

OPENWORK_HOST_PORT=8787 OPENWORK_CONNECT_HOST=worker-host.company.local \
OPENWORK_WORKSPACE_DIR=/srv/openwork/worker-01/workspace \
OPENWORK_DATA_DIR_HOST=/srv/openwork/worker-01/data \
OPENWORK_TOKEN='<worker-01-client-token>' \
OPENWORK_HOST_TOKEN='<worker-01-host-token>' \
  docker compose -p openwork-worker-1 up --build -d

OPENWORK_HOST_PORT=8788 OPENWORK_CONNECT_HOST=worker-host.company.local \
OPENWORK_WORKSPACE_DIR=/srv/openwork/worker-02/workspace \
OPENWORK_DATA_DIR_HOST=/srv/openwork/worker-02/data \
OPENWORK_TOKEN='<worker-02-client-token>' \
OPENWORK_HOST_TOKEN='<worker-02-host-token>' \
  docker compose -p openwork-worker-2 up --build -d

curl http://worker-host.company.local:8787/health
curl http://worker-host.company.local:8788/health
```

For separate hosts, keep the container port at `8787` on each host and use each host's DNS name in Den, for example `http://worker-01.company.local:8787,http://worker-02.company.local:8787`.

## 4. Start Den in static mode

PowerShell:

```powershell
Set-Location D:\openwork
$env:DEN_PROVISIONER_MODE = "static"
$env:DEN_STATIC_WORKER_URLS = "http://worker-01.company.local:8787,http://worker-02.company.local:8787"
$env:DEN_STATIC_WORKER_HEALTH_PATH = "/health"
$env:DEN_STATIC_WORKER_HEALTHCHECK_TIMEOUT_MS = "10000"
docker compose -p openwork-den-static -f packaging/docker/docker-compose.den-dev.yml up --build -d
docker compose -p openwork-den-static -f packaging/docker/docker-compose.den-dev.yml ps
curl.exe http://127.0.0.1:8788/health
curl.exe http://127.0.0.1:3005/api/den/health
```

Bash:

```bash
cd /path/to/openwork
export DEN_PROVISIONER_MODE=static
export DEN_STATIC_WORKER_URLS=http://worker-01.company.local:8787,http://worker-02.company.local:8787
export DEN_STATIC_WORKER_HEALTH_PATH=/health
export DEN_STATIC_WORKER_HEALTHCHECK_TIMEOUT_MS=10000
docker compose -p openwork-den-static -f packaging/docker/docker-compose.den-dev.yml up --build -d
docker compose -p openwork-den-static -f packaging/docker/docker-compose.den-dev.yml ps
curl http://127.0.0.1:8788/health
curl http://127.0.0.1:3005/api/den/health
```

`DEN_STATIC_WORKER_URLS` is comma-separated. Den trims trailing slashes, probes each URL's configured health path, and assigns one not-already-active static URL per worker request.

The default Compose stack does not start a local SMTP inbox. For production, configure `DEN_SMTP_HOST`, `DEN_SMTP_PORT`, `DEN_SMTP_USER`, `DEN_SMTP_PASS`, `DEN_SMTP_SECURE`, and `DEN_EMAIL_FROM`, or configure `DEN_RESEND_API_KEY` plus `DEN_EMAIL_FROM`.

## 5. Managed desktop deployment

The desktop installer is generic. Do not rebuild the desktop for each Den, network, customer, or site. A managed deployment tool should install the same desktop build and provide the Den endpoint as managed configuration during deployment.

Recommended Windows managed config file:

```text
%ProgramData%\OpenWork\desktop-bootstrap.json
```

Desktop bootstrap precedence is deterministic: `OPENWORK_DESKTOP_BOOTSTRAP_PATH` when explicitly set by an operator, then the machine-wide managed config above, then user/developer config, then build defaults. Managed enterprise deployments should use the machine-wide ProgramData file rather than per-user files.

Example contents:

```json
{
  "baseUrl": "http://den.company.local:3005",
  "apiBaseUrl": "http://den.company.local:3005/api/den",
  "requireSignin": true
}
```

The Den URL can be a DNS name or LAN IP that is valid for that site. Prefer DNS, for example `http://den.company.local:3005`, so workers and clients can move without changing every desktop profile.

Example Semaphore deployment steps for a Windows client machine:

```powershell
$installer = "C:\Deploy\openwork-win-x64-0.13.11.exe"
$configDir = "$env:ProgramData\OpenWork"
$denHost = "http://den.company.local:3005"

New-Item -ItemType Directory -Force -Path $configDir | Out-Null
@{
  baseUrl = $denHost
  apiBaseUrl = "$denHost/api/den"
  requireSignin = $true
} | ConvertTo-Json | Set-Content -Encoding UTF8 "$configDir\desktop-bootstrap.json"

Start-Process -FilePath $installer -ArgumentList "/S" -Wait
```

After installation, the user opens OpenWork and signs in to the configured Den. Worker credentials remain operator-managed secrets; end users should not handle worker bearer tokens or select infrastructure endpoints during normal sign-in.

## 6. Configure Microsoft Entra ID SSO for on-prem Den

Email/password sign-in stays enabled for break-glass administrator access. Microsoft Entra ID SSO is enabled only when all provider variables below are present.

This batch does not implement a first-admin/org bootstrap flow. Before enabling Entra auto-join in production, ensure a first Den administrator and target organization already exist through a supported setup path for your deployment. A dedicated first-admin/org bootstrap capability remains a future setup prerequisite. Entra auto-join only adds Microsoft users to an existing organization; it never creates the initial organization and never assigns `owner`.

For disposable E2E and operator smoke-test deployments, create a demo owner and organization with the Den seed tool instead of editing database rows manually. Run this from the Compose host after the `den` service is healthy, using a temporary password kept out of shell history where possible:

```bash
read -rs -p "Demo owner password: " DEN_DEMO_OWNER_PASSWORD; echo
export DEN_DEMO_OWNER_PASSWORD
docker compose -p openwork-den-static -f packaging/docker/docker-compose.den-dev.yml exec \
  -e DEN_DEMO_OWNER_EMAIL=admin@acme.test \
  -e DEN_DEMO_OWNER_PASSWORD \
  -e DEN_DEMO_SEED_FETCH_GITHUB=0 \
  den pnpm --dir /app/ee/apps/den-api run seed:demo-org
```

The seed command prints the demo owner email, organization summary, and object counts, but does not print the supplied password. Use `-- --reset` at the end only for disposable environments when you intentionally want to recreate the demo organization.

### Entra app registration

1. In Microsoft Entra admin center, create or open an App registration for Den.
2. Add a Web redirect URI using the Den browser-facing auth origin and Better Auth callback path:
   - `http://den.company.local:3005/api/auth/callback/microsoft`
   - For this Compose runbook's local defaults, use `http://localhost:3005/api/auth/callback/microsoft`.
3. Create a client secret and keep it outside source control.
4. Configure ID token optional claims so Den receives `email` where available and `groups` for group object IDs. Den only reads the token `groups` claim; Microsoft Graph overage lookup is intentionally out of scope.
5. Record the fixed tenant GUID. Do not use `common`, `organizations`, or `consumers` for on-prem Den SSO.

### Den environment variables

Set these before starting Den:

```bash
export DEN_BETTER_AUTH_URL=http://den.company.local:3005
export DEN_ENTRA_TENANT_ID=00000000-0000-0000-0000-000000000000
export DEN_ENTRA_CLIENT_ID=11111111-1111-1111-1111-111111111111
export DEN_ENTRA_CLIENT_SECRET=replace-with-client-secret
```

Use HTTPS for production Den auth origins where available, for example `https://den.company.local`. When the browser-facing Den web/auth origin is an HTTP LAN address such as `http://den.company.local:3005`, use that exact origin consistently for `DEN_BETTER_AUTH_URL`, trusted origins, desktop bootstrap, and the Entra redirect URI. Plain HTTP is accepted only for localhost, loopback, private LAN IPs, or `.local` hostnames used in LAN/on-prem testing. Do not configure wildcard Better Auth trusted origins (`*`) while Entra SSO is enabled; set explicit browser-facing origins such as `DEN_BETTER_AUTH_TRUSTED_ORIGINS=http://den.company.local:3005`.

Optional organization auto-join maps all Microsoft SSO sign-ins into one Den organization. Prefer the canonical organization ID; `DEN_ENTRA_AUTO_JOIN_ORG_SLUG` is available only as an operator convenience and must resolve to exactly one org.

```bash
export DEN_ENTRA_AUTO_JOIN_ENABLED=true
export DEN_ENTRA_AUTO_JOIN_ORG_ID=organization_replace_me
# Optional alternative, only if no org ID is set and the slug is unambiguous:
# export DEN_ENTRA_AUTO_JOIN_ORG_SLUG=platform-team
```

Set exactly one selector when auto-join is enabled: either `DEN_ENTRA_AUTO_JOIN_ORG_ID` or `DEN_ENTRA_AUTO_JOIN_ORG_SLUG`, never both and never neither.

Optional Entra group-to-role mapping uses comma-separated Entra group object IDs from the token `groups` claim:

```bash
export DEN_ENTRA_ADMIN_GROUP_IDS=aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa
export DEN_ENTRA_MEMBER_GROUP_IDS=bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb,cccccccc-cccc-cccc-cccc-cccccccccccc
```

Role behavior:

- Default SSO auto-join role is `member` when no group mapping matches.
- If both admin and member groups match, `admin` wins.
- SSO never assigns `owner`; existing owner memberships are preserved.
- Token `roles` claims are ignored; only the Entra `groups` claim participates in Den role mapping.
- If Entra omits `email`, Den falls back to `preferred_username`/UPN where Better Auth's Microsoft provider profile mapping allows it.

### Validate SSO

1. Restart Den after setting the environment variables.
2. Confirm the Microsoft sign-in option appears on the auth screen.
3. Sign in with a tenant user and verify the callback URL is accepted by Entra.
4. Confirm the user is a member of the configured Den organization with the expected `admin` or `member` role.
5. Confirm an existing admin can still sign in with email/password.

Troubleshooting:

- Missing Microsoft sign-in option: confirm `DEN_ENTRA_TENANT_ID`, `DEN_ENTRA_CLIENT_ID`, and `DEN_ENTRA_CLIENT_SECRET` are all set and that tenant ID is not `common`.
- Entra callback error: confirm the redirect URI exactly matches `http://den.company.local:3005/api/auth/callback/microsoft` for the configured Den auth origin.
- User joined as `member`: confirm Entra emitted a `groups` claim and the configured group object ID matches `DEN_ENTRA_ADMIN_GROUP_IDS`.
- User not auto-joined: confirm `DEN_ENTRA_AUTO_JOIN_ENABLED=true` and `DEN_ENTRA_AUTO_JOIN_ORG_ID` points to an existing Den organization.

## 7. Validate Den UI behavior and add a shared workspace

1. Open `http://<den-host>:3005`.
2. Sign in with an administrator account or an SSO user that has the expected organization membership.
3. Create or open the target organization/team workspace area.
4. Add a shared/cloud worker from the Den UI.
5. Expected behavior:
   - The worker briefly appears as `provisioning`/`Starting`.
   - Den calls `/health` on the first unassigned URL from `DEN_STATIC_WORKER_URLS`.
   - The worker becomes `healthy` and its instance/provider metadata shows `static`.
   - Adding another shared worker consumes the next URL in `DEN_STATIC_WORKER_URLS`.
   - If every static URL is already assigned to an active worker, the new request fails with a clear "No available static worker URL remains" error.

Use the supported Den UI/API flows for worker lifecycle actions. Do not edit database rows, token files, or browser/session state as part of normal operations.

## 8. Compose validation before launch

PowerShell:

```powershell
Set-Location D:\openwork
docker compose -p openwork-den-default -f packaging/docker/docker-compose.den-dev.yml config

$env:DEN_PROVISIONER_MODE = "static"
$env:DEN_STATIC_WORKER_URLS = "http://worker-01.company.local:8787,http://worker-02.company.local:8787"
docker compose -p openwork-den-static -f packaging/docker/docker-compose.den-dev.yml config

Set-Location D:\openwork\packaging\docker
$env:OPENWORK_HOST_PORT = "8787"
docker compose -p openwork-worker-1 config
```

Bash:

```bash
cd /path/to/openwork
docker compose -p openwork-den-default -f packaging/docker/docker-compose.den-dev.yml config

DEN_PROVISIONER_MODE=static \
DEN_STATIC_WORKER_URLS=http://worker-01.company.local:8787,http://worker-02.company.local:8787 \
docker compose -p openwork-den-static -f packaging/docker/docker-compose.den-dev.yml config

cd packaging/docker
OPENWORK_HOST_PORT=8787 \
docker compose -p openwork-worker-1 config
```

In rendered output, confirm Den has `PROVISIONER_MODE: static` and `STATIC_WORKER_URLS` set to the real worker URLs, and the worker service is built from `packaging/docker/Dockerfile`.

## 9. Restart, stop, cleanup, and decommission

Restart Den after configuration changes:

```bash
docker compose -p openwork-den-static -f packaging/docker/docker-compose.den-dev.yml restart den web
```

Restart a worker after token rotation or host configuration changes:

```bash
cd packaging/docker
docker compose -p openwork-worker-1 restart openwork-host
```

Follow logs:

```bash
docker compose -p openwork-den-static -f packaging/docker/docker-compose.den-dev.yml logs -f den web
cd packaging/docker && docker compose -p openwork-worker-1 logs -f openwork-host
```

Stop without deleting persistent volumes:

```bash
docker compose -p openwork-den-static -f packaging/docker/docker-compose.den-dev.yml down
cd packaging/docker && docker compose -p openwork-worker-1 down
```

Use destructive volume removal only for disposable/test stacks where data loss is intentional:

```bash
docker compose -p openwork-den-static -f packaging/docker/docker-compose.den-dev.yml down -v
cd packaging/docker && docker compose -p openwork-worker-1 down -v
```

Worker decommission checklist:

1. Remove or disable the worker through supported Den UI/API administration flows.
2. Remove the worker URL from `DEN_STATIC_WORKER_URLS` and restart Den.
3. Stop the worker container.
4. Revoke or rotate the worker's `OPENWORK_TOKEN` and `OPENWORK_HOST_TOKEN` in the secret manager.
5. Archive or delete workspace/data directories according to retention policy.

Test data cleanup should use supported application flows: delete test workers, organizations, users, invites, and sessions through Den UI/API/admin tooling available for the deployment. Avoid direct database edits or manual token-file changes during normal operations; reserve destructive container/volume reset for disposable environments.

## 10. Troubleshooting

- Worker remains `Starting`: from the Den host, run `curl http://<worker-host>:8787/health`. Fix DNS, routing, firewall, or the worker container before retrying.
- Worker becomes `failed`: inspect Den logs with `docker compose -p openwork-den-static -f packaging/docker/docker-compose.den-dev.yml logs den` and confirm `DEN_STATIC_WORKER_URLS` is non-empty and points to OpenWork workers.
- No static worker available: add another URL to `DEN_STATIC_WORKER_URLS`, decommission stale workers through supported admin flows, or stop requesting additional shared workers.
- Auth/CORS problems: set `DEN_PUBLIC_HOST`, `DEN_BETTER_AUTH_URL`, `DEN_BETTER_AUTH_TRUSTED_ORIGINS`, and `DEN_CORS_ORIGINS` to the Den web/API origins before starting Den.
- Wrong connect host in printed worker URLs: set `OPENWORK_CONNECT_HOST` to the worker DNS name and recreate the worker container.
- Desktop opens the wrong Den: confirm the managed deployment created `%ProgramData%\OpenWork\desktop-bootstrap.json` with the expected Den URL, then redeploy or repair through the same management channel.
- Version mismatch: rebuild and redeploy the worker image from the approved source checkout or release artifact you intend to support.

## Appendix A. Non-production static worker smoke simulation

Use `static-worker-smoke` only to validate Den static provisioning mechanics without a real OpenWork runtime. It is a tiny `/health` HTTP service, not an OpenWork worker, and it cannot run workspaces or sessions.

PowerShell:

```powershell
Set-Location D:\openwork
$env:DEN_PROVISIONER_MODE = "static"
$env:DEN_STATIC_WORKER_URLS = "http://static-worker-smoke:8787"
docker compose --profile static-worker-smoke -p openwork-den-static -f packaging/docker/docker-compose.den-dev.yml up --build -d
curl.exe http://127.0.0.1:8787/health
```

Bash:

```bash
cd /path/to/openwork
DEN_PROVISIONER_MODE=static DEN_STATIC_WORKER_URLS=http://static-worker-smoke:8787 \
  docker compose --profile static-worker-smoke -p openwork-den-static \
  -f packaging/docker/docker-compose.den-dev.yml up --build -d
curl http://127.0.0.1:8787/health
```

Do not use `static-worker-smoke` for production or workspace/session validation.
