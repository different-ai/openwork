# Enterprise Mock Lab

The Enterprise Mock Lab is a loopback-only development control plane for reusable enterprise simulation packages. Its first module is `@openwork/enterprise-mcp-mock-server`.

It intentionally keeps two trust boundaries separate:

```text
developer browser -> protected control-plane listener
Den/test client   -> synthetic provider data-plane listener(s)
```

The provider-facing MCP listener never mounts the admin UI or control APIs.

## Start locally

Create a development-only admin secret and start the app:

```bash
export ENTERPRISE_MOCK_LAB_ADMIN_SECRET="$(openssl rand -base64 32)"
pnpm --filter @openwork-ee/enterprise-mock-lab dev
```

Open `http://127.0.0.1:8794`. The control plane rejects non-loopback bind addresses and secrets shorter than 32 characters.

Optional environment variables:

| Variable | Default | Constraint |
| --- | --- | --- |
| `ENTERPRISE_MOCK_LAB_HOST` | `127.0.0.1` | `127.0.0.1` or `::1` only |
| `ENTERPRISE_MOCK_LAB_PORT` | `8794` | Valid TCP port |
| `ENTERPRISE_MOCK_LAB_SESSION_TTL_SECONDS` | `3600` | 5 minutes to 24 hours |

## Development workflow

1. Sign in with the local lab admin secret.
2. Review the dated fidelity and known limitations of a provider profile.
3. Create a stopped instance with a unique data-plane port. Supply a write-only synthetic OAuth secret only when the selected profile uses a confidential client.
4. Start the instance and copy its MCP endpoint into the client under development.
5. Select one declarative fault and apply a new scenario revision.
6. Run the built-in fixture-conformance probe to compare expected and observed behavior. It verifies the exact pinned tool-name set and schema validity; it does not execute provider tools.
7. Inspect the bounded safe-event timeline, then reset or stop the instance.

Only one fault is active at a time. That keeps the first failing phase attributable. A scenario update uses optimistic revision checks, so stale browser tabs cannot silently overwrite a newer configuration.

## Security properties

- Control and data planes use different listeners.
- Both bind to literal loopback addresses.
- Login performs a constant-time digest comparison and rate-limits failures.
- Sessions are short-lived, `HttpOnly`, `SameSite=Strict` cookies.
- Every mutation requires an exact Origin match and a per-session CSRF token.
- Origin and session checks run before request-body consumption; accepted JSON/form bodies are streamed through a 64 KiB limit.
- CSP disables scripts, external assets, framing, and cross-origin connections.
- Provider secrets are accepted through password fields and are never returned by HTML or JSON responses.
- Request bodies, OAuth codes, tokens, secrets, and tool arguments are excluded from the safe event model.

This is a deterministic development and conformance tool. It does not claim to be a live ServiceNow or Microsoft tenant and it makes no provider calls.

## API

Authenticated endpoints are versioned under `/api/v1`:

- `GET /api/v1/catalog`
- `GET /api/v1/instances`
- `POST /api/v1/instances`
- `GET /api/v1/instances/:id`
- `POST /api/v1/instances/:id/scenario`
- `POST /api/v1/instances/:id/actions/{start|stop|reset|probe|delete}`

Browser forms send the CSRF token in the request body. JSON clients send it in `X-CSRF-Token`. Both must send the exact configured control-plane `Origin`.
