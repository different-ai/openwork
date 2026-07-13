# durable-auth-mcp — Sign in once and stay connected

1. Maya signs into OpenWork and connects a shared MCP. She completes the provider's consent once, and the connection shows Ready.

2. More than seven days of normal desktop and MCP use pass. Maya opens OpenWork and continues working without being sent through sign-in again, because active sessions renew quietly in the background.

3. The MCP access token expires and the agent engine restarts. OpenWork silently uses the stored refresh grant and returns the connection to Ready—without opening a browser, consent screen, security check, or engine-reload prompt.

4. OpenWork Cloud temporarily becomes unreachable. Maya's local work remains available and OpenWork shows that it is reconnecting; it does not erase her session or redirect her to sign-in. When service returns, the account state recovers automatically.

5. Later, Maya adds another shared MCP after her OpenWork sign-in is more than fifteen minutes old. OpenWork does not insert a redundant identity check before the provider's consent flow, so one provider sign-in completes setup.

6. Maya attempts a genuinely sensitive action, such as transferring ownership, rotating an API key, or changing SSO. OpenWork asks her to confirm her identity once and automatically resumes the pending action.

7. When Maya explicitly signs out, an administrator removes her membership, or credentials are revoked, her OpenWork sessions and MCP access stop immediately.

8. An MCP client connected before this update asks for offline access so it can refresh quietly. OpenWork upgrades that client's refresh permission and shows workspace authorization instead of returning an invalid-scope error.
