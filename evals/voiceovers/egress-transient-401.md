# egress-transient-401 — One proxy 401 must not wipe credentials

1. The lab injects a single bare 401 before recovering. The client treats that proxy-shaped response as unavailable rather than revoked, keeps the stored Den token, succeeds on retry, and OpenWork's shipped Cloud MCP diagnostics report the recovered transient 401 instead of telling the user to reconnect.
