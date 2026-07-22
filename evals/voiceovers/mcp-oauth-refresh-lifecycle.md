# MCP OAuth refresh lifecycle

1. OpenWork exercises the real OAuth and MCP endpoints with two-second access tokens. Serial refreshes stay connected, concurrent refreshes recover during the rotation grace window, stale reuse revokes the family, and revoked sessions stay blocked.
