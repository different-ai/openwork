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
3. In Den, begin a manual/pre-registered OAuth connection for the planned lab endpoint and copy the callback URI Den shows. Do not click **Connect** yet.
4. Create a stopped lab instance with a unique data-plane port and paste that exact callback into **Exact OAuth redirect URIs**. Supply a write-only synthetic OAuth secret only when the selected profile uses a confidential client.
5. Start the instance, confirm its registered redirect URI list, and then click **Connect** in Den.
6. Select one declarative fault and apply a new scenario revision.
7. Run the built-in fixture-conformance probe to compare expected and observed behavior. It verifies the exact pinned tool-name set and schema validity; it does not execute provider tools.
8. Inspect the bounded safe-event timeline, then reset or stop the instance.

Only one fault is active at a time. That keeps the first failing phase attributable. A scenario update uses optimistic revision checks, so stale browser tabs cannot silently overwrite a newer configuration.

The scenario form explicitly defaults to **Preserve compatible OAuth credential; start a new MCP session**. This mode is limited to revisions whose provider fixture, endpoint/resource, client registration, exact redirects, and scopes are unchanged. It retains only unexpired OAuth client/access/refresh authority; authorization codes, MCP sessions, operation records, fault counters, and earlier events are cleared. Select **Reset all OAuth and MCP connection state** for a fully isolated run. OAuth discovery, registration, consent, token, audience, and scope faults require reset mode and a new **Connect**, because an already-issued credential has legitimately passed those phases.

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

`POST /api/v1/instances` accepts `redirectUris` as a JSON array or, from the browser form, one URI per line. The list is validated by the package redirect-safety contract and bounded to 1–10 exact URIs. Omitting the JSON property uses the scenario's local callback default; sending an empty list is invalid.

`POST /api/v1/instances/:id/scenario` accepts `credentialContinuity` as `reset` or `preserve-compatible-oauth`. API callers that omit it retain the backward-compatible `reset` behavior; the manager-facing HTML form sends the preserve-compatible mode explicitly.
