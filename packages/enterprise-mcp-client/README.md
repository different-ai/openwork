# `@openwork/enterprise-mcp-client`

Server-side remote MCP consumption for OpenWork Den.

This package owns the provider-neutral MCP and OAuth lifecycle while the Den
adapter retains organization authority, encrypted credential persistence, and
network policy. It is additive: Den's current implementation remains the
default unless the enterprise client is explicitly enabled.

## Den rollout

```bash
DEN_ENABLE_ENTERPRISE_MCP_CLIENT=true pnpm dev:den
```

When the variable is unset or `false`, Den uses its current MCP client. Only
the exact values `true` and `false` are accepted so a deployment typo cannot
silently select an unexpected implementation.

## Contracts

- `EnterpriseMcpClient` covers connect, OAuth callback, tool discovery, and
  tool execution.
- `EnterpriseMcpOAuthStore` is implemented by Den so secrets never move into
  the package or logs.
- `EnterpriseMcpFetch` lets Den preserve its SSRF and private-network policy.
- `EnterpriseMcpDiagnosticSink` receives secret-free operation and request
  phases suitable for tests and future tracing.
- `EnterpriseMcpClientError` identifies both the operation and the last
  provider request phase while retaining the original error as its cause.

The package deliberately has no dependency on Den routes, database models,
organization types, or process environment variables.
