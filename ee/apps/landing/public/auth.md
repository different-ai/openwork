# auth.md

You are an agent. OpenWork supports **agentic registration**. The steps are discover → pick a method → register → claim (when a person wants ownership) → exchange for an access_token → call the MCP gateway → handle revocation. Follow the steps in order.

Hosts used below:

- Resource server (API and MCP gateway): `https://api.openworklabs.com`
- Authorization server (OAuth, sign-in, claim pages): `https://app.openworklabs.com`, issuer `https://app.openworklabs.com/api/auth`

Self-hosted OpenWork uses its own two hosts. Read them from the metadata in Step 1. If this file ever disagrees with that metadata, the metadata wins.

## Step 1: Discover

A request to the MCP gateway without a token returns 401 with the metadata URL:

```http
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer resource_metadata="https://api.openworklabs.com/.well-known/oauth-protected-resource/mcp/agent", scope="mcp:read mcp:write offline_access"
```

### 1a. Protected Resource Metadata

```http
GET https://api.openworklabs.com/.well-known/oauth-protected-resource/mcp/agent
```

```json
{
  "resource": "https://api.openworklabs.com/mcp/agent",
  "authorization_servers": ["https://app.openworklabs.com/api/auth"],
  "scopes_supported": ["mcp:read", "mcp:write", "offline_access"],
  "bearer_methods_supported": ["header"]
}
```

### 1b. Authorization Server metadata

```http
GET https://api.openworklabs.com/.well-known/oauth-authorization-server
```

These are the fields that matter for agents (the response has more):

```json
{
  "issuer": "https://app.openworklabs.com/api/auth",
  "authorization_endpoint": "https://app.openworklabs.com/api/auth/oauth2/authorize",
  "token_endpoint": "https://app.openworklabs.com/api/auth/oauth2/token",
  "registration_endpoint": "https://app.openworklabs.com/api/auth/oauth2/register",
  "revocation_endpoint": "https://app.openworklabs.com/api/auth/oauth2/revoke",
  "client_id_metadata_document_supported": true,
  "grant_types_supported": [
    "authorization_code",
    "client_credentials",
    "refresh_token",
    "urn:ietf:params:oauth:grant-type:jwt-bearer"
  ],
  "agent_auth": {
    "skill": "https://openworklabs.com/auth.md",
    "identity_endpoint": "https://api.openworklabs.com/v1/bootstrap/workspace",
    "claim_endpoint": "https://api.openworklabs.com/v1/bootstrap/workspace/{bootstrap_id}/claim",
    "identity_types_supported": ["anonymous"]
  }
}
```

- `agent_auth.identity_types_supported` is `["anonymous"]`. OpenWork does not accept `identity_assertion` (ID-JAG) or `service_auth` registrations yet, and it has no `events_endpoint`.
- `urn:ietf:params:oauth:grant-type:jwt-bearer` exchanges an anonymous identity assertion for an access_token (Step 5).

## Step 2: Pick a method

1. **You are an interactive MCP client and a person is at the keyboard.** Use standard MCP OAuth: authorization code + PKCE (S256), `resource=https://api.openworklabs.com/mcp/agent`. Register with a Client ID Metadata Document (preferred) or dynamic client registration at `registration_endpoint`. The person signs in or signs up on the page OpenWork shows, picks a workspace, and approves. Skip to Step 6 with the access_token.
2. **You run a CLI or headless tool for a person who has, or will create, an account.** Use device login (below).
3. **Nobody has an account yet and you need to start building now.** Use [anonymous](#anonymous). A person claims the workspace later (Step 4).

### Device login (RFC 8628)

```http
POST https://api.openworklabs.com/api/auth/device/code
Content-Type: application/json

{ "client_id": "openwork-cli" }
```

```json
{
  "device_code": "…",
  "user_code": "ABCD2345",
  "verification_uri": "https://app.openworklabs.com/device",
  "verification_uri_complete": "https://app.openworklabs.com/device?user_code=ABCD2345",
  "expires_in": 900,
  "interval": 5
}
```

Show the person `verification_uri_complete` and the code (display it as `ABCD-2345`). They sign in or sign up, check that the code matches, choose the organization, and approve. Poll every `interval` seconds:

```http
POST https://api.openworklabs.com/api/auth/device/token
Content-Type: application/json

{
  "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
  "device_code": "…",
  "client_id": "openwork-cli"
}
```

While you wait, the response is `400` with `authorization_pending`. `slow_down` means add 5 seconds to your interval. `access_denied` means the person refused. `expired_token` means you should start again. On success:

```json
{ "access_token": "…", "token_type": "Bearer", "expires_in": 604800, "scope": "" }
```

This access_token is an OpenWork session for the REST API (`GET https://api.openworklabs.com/v1/me`). `openwork-bootstrap login` implements this flow and saves the token to `~/.openwork/credentials.json` (mode 0600). `OPENWORK_API_TOKEN` takes precedence over the saved file.

## Step 3: Register

### anonymous

```http
POST https://api.openworklabs.com/v1/bootstrap/workspace
Content-Type: application/json

{ "workspaceName": "Ada's studio", "claimRoles": ["owner"] }
```

Response (200, `Cache-Control: no-store`):

```json
{
  "ok": true,
  "organization": { "id": "org_…", "name": "Ada's studio", "slug": "org_…", "status": "provisional" },
  "setup": { "id": "wbt_…", "expiresAt": "2026-09-27T12:00:00.000Z" },
  "skill": { "id": "cob_…", "title": "First OpenWork Skill", "output": "OPENWORK_BOOTSTRAP_SKILL_TRIGGERED" },
  "claimLinks": [{ "id": "wcl_…", "role": "owner", "token": "…", "url": "https://app.openworklabs.com/workspace-claim?token=…", "expiresAt": "…" }],
  "identity": {
    "type": "anonymous",
    "assertion": "<service-signed JWT>",
    "assertionType": "urn:ietf:params:oauth:grant-type:jwt-bearer",
    "tokenEndpoint": "https://app.openworklabs.com/api/auth/oauth2/token",
    "scope": "mcp:read mcp:write",
    "expiresAt": "2026-09-27T12:00:00.000Z",
    "claimEndpoint": "https://api.openworklabs.com/v1/bootstrap/workspace/wbt_…/claim"
  }
}
```

- The workspace, the assertion, and the claim links all last 24 hours. The limit is 5 registrations per IP address per hour; a 429 response carries `Retry-After`.
- `identity.assertion` is a secret. Keep it in memory or an owner-only file. Never print or log it.
- `setup.id` is the `bootstrap_id` in `claim_endpoint`.

## Step 4: Claim ceremony

Do this when the person is ready to own the workspace. OpenWork never emails the code. You hand it to the person.

### 4a. Get a claim code

Send the assertion as the Bearer token:

```http
POST https://api.openworklabs.com/v1/bootstrap/workspace/{bootstrap_id}/claim
Authorization: Bearer <identity.assertion>
```

```json
{
  "user_code": "WDJB-MJHT",
  "verification_uri": "https://app.openworklabs.com/claim",
  "verification_uri_complete": "https://app.openworklabs.com/claim?user_code=WDJB-MJHT",
  "expires_in": 900,
  "interval": 5
}
```

Each POST cancels the previous unused code. Request a new one when a code expires.

### 4b. Hand off to the person

> Open this link, sign in or create an account, and confirm the code **WDJB-MJHT**:
> https://app.openworklabs.com/claim?user_code=WDJB-MJHT

The person keeps the workspace as a new organization and becomes its owner.

### 4c. Poll for completion

```http
GET https://api.openworklabs.com/v1/bootstrap/workspace/{bootstrap_id}/claim
Authorization: Bearer <identity.assertion>
```

```json
{ "state": "pending", "reconciled": false }
```

`state` is one of `none`, `pending`, `expired`, `accepted`, or `reconciled`. Poll every `interval` seconds until it reads `reconciled`. At that point the assertion and every access_token minted from it are revoked. The person now owns the workspace. To keep acting for them, use MCP OAuth or device login (Step 2) as that person.

The claim links in `claimLinks` still work as an alternative. Claiming through a link revokes the agent's credentials the same way.

## Step 5: Exchange the assertion

```http
POST https://app.openworklabs.com/api/auth/oauth2/token
Content-Type: application/x-www-form-urlencoded

grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=<identity.assertion>
```

```json
{ "access_token": "<JWT>", "token_type": "Bearer", "expires_in": 900, "scope": "mcp:read mcp:write" }
```

No refresh_token is issued. When the access_token expires, exchange the same assertion again. `invalid_grant` means the assertion is expired, revoked (the workspace was claimed), or invalid. Stop and use Step 2.

## Step 6: Use the access_token

```http
POST https://api.openworklabs.com/mcp/agent
Authorization: Bearer <access_token>
Content-Type: application/json
Accept: application/json, text/event-stream

{ "jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {} }
```

Start with `search_capabilities`, then call `execute_capability`.

Before a claim (anonymous tokens), you can read, create or update skills, plugins, and marketplaces, create install links, and add member-level MCP connections that need no sign-in. Everything that needs a person answers with the error envelope below and `code: "requires_claim"`. That includes billing, invitations, members and roles, shared organization credentials, AI providers, SSO, SCIM, and API keys.

## Errors

Den API operations that need a different person answer with one envelope. The older `error` field stays for existing clients:

```json
{
  "error": "forbidden",
  "code": "requires_admin",
  "message": "Only workspace owners and admins can invite members.",
  "retryable": false,
  "action_url": "https://app.openworklabs.com/dashboard/members"
}
```

These 403 responses also carry `WWW-Authenticate: Bearer error="insufficient_scope"`.

| Code | Where | What to do |
| --- | --- | --- |
| `requires_claim` | any `/v1` write with an anonymous token | Ask the person to claim (Step 4). `claim_url` and `action_url` point at the claim page. |
| `requires_admin` | owner/admin-only operations | Tell the person that an owner or admin must do it, and give them `action_url`. |
| `invalid_grant` | `token_endpoint` | Assertion expired, revoked, or invalid. Do not retry. |
| `invalid_token` | `claim_endpoint` | Wrong or revoked assertion for this workspace. |
| `authorization_pending` / `slow_down` / `access_denied` / `expired_token` | `/api/auth/device/token` | See device login. |
| `rate_limited` (429) | `identity_endpoint` | Wait for `Retry-After`. |

Retry policy: on a 5xx, back off and retry. On a 4xx, do not resend the same request; act on the code.

## Revocation

- Claiming (Step 4) revokes the assertion and every access_token minted from it. Tokens also stop working when the workspace expires after 24 hours.
- MCP OAuth tokens can be revoked at `revocation_endpoint` (RFC 7009).
- A device-login session ends with `POST https://api.openworklabs.com/api/auth/sign-out` using `Authorization: Bearer <access_token>` (`openwork-bootstrap logout`).
