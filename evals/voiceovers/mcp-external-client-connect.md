# mcp-external-client-connect — A URL-only MCP client connects to the API origin end to end

Regression proof for the multi-origin protected-resource fix: den-api serves
MCP on a direct API origin (127.0.0.1:8790 here, api.openworklabs.com in prod)
while browser auth lives on the den-web origin (localhost:3005 here,
app.openworklabs.com in prod). Before the fix, RFC 9728 metadata on the API
origin declared the web-app origin's resource, so spec-strict clients (Cursor)
refused to connect. The flow plays a Cursor-like client: discovery, dynamic
client registration, PKCE browser OAuth with a loopback callback, token
exchange, and real tool calls — all against the API origin.

1. On a fresh Den stack, an unauthenticated call to the MCP endpoint on the API origin comes back 401 — and the challenge now points at the API origin's own metadata, not the web app's.

2. The protected-resource metadata on the API origin declares the API origin itself as the resource — exactly the check that made Cursor bail before the fix — and hands over the matching authorization server.

3. Playing a Cursor-like client, I register via dynamic client registration with a loopback redirect and get sent to the real OpenWork sign-in page to authorize.

4. I sign in as the demo owner and land on the organization consent screen — I pick my workspace and approve, and the browser bounces back to the client's loopback callback with the code.

5. The client trades the code for tokens against the API origin's resource and the client page flips to connected — access token accepted, audience validated.

6. With that token, tools/list on the agent endpoint shows exactly search and execute, and a real search-then-execute round trip returns the org's data — the exact flow that failed in Cursor now completes end to end.
