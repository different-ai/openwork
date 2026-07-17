# reliable-openwork-connect - Reliable OpenWork Connect

1. I open OpenWork Connect and see the permanent server address `https://api.openworklabs.com/mcp/agent`. Clients are labeled according to evidence: verified clients have passed a native end-to-end OAuth test, while setup-only clients are not presented as proven.

2. I choose my client and get its exact configuration and authentication sequence. OpenCode shows `opencode mcp auth openwork`, Codex shows `codex mcp login openwork`, and every other guide clearly explains how that client starts OAuth.

3. My client opens OpenWork in the browser, where I sign in, choose an organization, review the access request, and approve it. The browser returns me to the client without exposing tokens.

4. Back in the verified client, I can search OpenWork capabilities and execute one against the selected organization. Short-lived access tokens refresh automatically, and reconnect instructions are available when a grant expires or is revoked.

5. When a request is malformed, unauthorized, expired, concurrently refreshed, or rate-limited, OpenWork returns a standards-compliant response with a useful error and support reference instead of failing silently.

6. The documentation matches the shipped behavior: one public API endpoint, accurate OAuth discovery and token lifetimes, explicit client instructions, organization switching, troubleshooting, support status, and a clear note that `app.openworklabs.com/api/den` is an internal desktop proxy.
