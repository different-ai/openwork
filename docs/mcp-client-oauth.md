# Connect a third-party MCP client with OAuth

Configure the client with your deployment's `/mcp/agent` endpoint. Public OAuth
access tokens are intended for this endpoint. Use the deployed URL, including
any reverse-proxy prefix; do not substitute the web dashboard URL.

## Discovery and setup

1. Send an unauthenticated request to the MCP endpoint. On `401`, follow the
   `resource_metadata` URL in `WWW-Authenticate`. For a synthetic endpoint
   `https://api.example.com/mcp/agent`, the discovery URL is
   `https://api.example.com/.well-known/oauth-protected-resource/mcp/agent`.
2. Read the metadata's `resource` and `authorization_servers`. Discover OAuth
   endpoints from the advertised authorization server; its origin may differ
   from the MCP endpoint's origin. Do not use the metadata URL or issuer URL as
   the resource value.
3. Register or configure the client using the discovered registration endpoint
   and the client's actual callback URI. Use authorization code flow with PKCE
   (`S256`). Keep callback validation, state verification, and consent enabled.
4. Send exactly one `resource` parameter containing the discovered resource in
   the authorization URL query **and** in the form-encoded token request body.
   Supplying it only during registration or only in the browser URL is insufficient.
   For the synthetic endpoint above, the encoded parameter is
   `resource=https%3A%2F%2Fapi.example.com%2Fmcp%2Fagent`.
5. Send the access token as an Authorization Bearer header to the MCP endpoint.
   Clients should also send the resource on refresh requests. Den's existing
   refresh compatibility path can infer its singleton audience when omitted;
   this does not make omission valid for the initial authorization or code exchange.

These steps follow the [MCP authorization specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization#resource-parameter-implementation)
and [RFC 9728 discovery](https://www.rfc-editor.org/rfc/rfc9728.html).

## `invalid_target`: “must include the protected resource”

This response means an MCP OAuth request omitted `resource`. Confirm that the
client sends the field at both stages above. Some generic OAuth clients support
extra authorization parameters but cannot include extra token-body parameters.
If your client cannot send both, update it or use a client that implements MCP
resource indicators. Changing scopes or registering the client again does not
supply this missing field.

An unknown resource or multiple resource parameters also return `invalid_target`.
Use the single discovered value; do not add arbitrary audiences or disable
validation. [RFC 8707](https://www.rfc-editor.org/rfc/rfc8707.html#section-2)
defines this error for missing, unknown, malformed, or otherwise invalid resources.

For a support report, record only the failing stage, HTTP status, error code,
and whether the parameter was present. Do not share full authorization URLs,
cookies, authorization codes, tokens, client secrets, or tenant identifiers.

## Regression evidence

The existing `mcp-auth-rate-limit-recovery` journey follows the challenge to the
protected-resource metadata, rejects missing, unknown, and repeated resources
at authorization and code exchange, then exchanges the same code with the
advertised resource and uses the token on MCP. Run:

```sh
pnpm evals:e2e mcp-auth-rate-limit-recovery
```
