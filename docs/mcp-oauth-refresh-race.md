# MCP sign-in followed by “Auth required”

Codex's `WorkerTransport<StreamableHttpClientWorker<AuthClient<...>>>: Auth required`
message is not enough to identify a server-side cause. In the investigated local
run, the connection initialized and the OAuth transport then logged
`invalid_grant: invalid refresh token`. That establishes a rejected refresh
attempt, not a failed browser login. The logs do not establish whether that
particular credential was expired, used by the wrong client, or involved in a
rotation race.

## Concurrent refresh failure

OpenWork pins `@better-auth/oauth-provider` to `1.7.0-beta.10` and configures a
30-second refresh-token reuse interval. Independent MCP workers can hold the
same refresh token and refresh it concurrently.

The provider atomically marks the original token revoked before it creates the
successor and persists the encrypted replay response. Two failure windows exist:

1. Both requests read the original token as active. One wins the atomic update;
   the other gets `invalid_grant` from the failed update.
2. A request reads the revoked token while the winner is still building its
   response. It is inside the grace interval, but no replay response exists yet,
   so the provider returns `invalid_grant`.

The patch lets both losing paths poll for the winning response up to 40 times
at 25-millisecond intervals (plus database latency).
It reloads the original row from the database, allowing workers on different
API processes to see the result. It returns the existing encrypted response
through the provider's original validation; it never issues a second successor.
The original client, scope, resource, confirmation-binding, expiry, and reuse
interval checks remain in force. A missing/deleted row, elapsed grace interval,
mismatched replay request, or missing response after the bounded wait still
fails closed. The patch is pinned to this provider version and must be reviewed
when upgrading Better Auth.

## Verification

`pnpm evals:pr specs/mcp-oauth-concurrent-refresh.test.ts` starts an isolated Den
API and exercises dynamic client registration, PKCE authorization and consent,
three rounds of four concurrent HTTP refresh requests, and authenticated MCP
initialization using the final successor. It also checks mismatched replay
requests and family revocation after the grace interval. Each round must return one shared
successor. A different registered client and a request for broader scopes must
still be rejected.

The general spec lane reports missing MySQL/Redis as an explicit skip. Linux CI
then starts those services and runs this journey separately with
`OPENWORK_EVAL_MCP_OAUTH_REQUIRED=1`, which makes a missing service a failure.

## Recovery for an already rejected credential

Reauthorize the OpenWork MCP connection to obtain a new credential. A server
fix cannot restore a credential that expired or whose refresh family was
already invalidated. If the problem recurs, correlate the MCP request reference
ID and token endpoint status with server diagnostics. Never include access
tokens, refresh tokens, authorization codes, or raw credential-store contents
in issue reports.
