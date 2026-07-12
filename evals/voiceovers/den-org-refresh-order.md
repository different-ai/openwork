# den-org-refresh-order — the latest Den session owns organization state

1. OpenWork starts loading organizations for one Den session while the account or Den endpoint is still allowed to change.

2. A newer session starts its own organization refresh before the first response returns; the newer response sets the organization list, selection, and persisted active-organization metadata.

3. When the older response finally arrives, it is ignored and cannot replace the newer organizations, clear the newer selection, change the active organization context, or dismiss the current loading state.

4. Errors and busy-state completion are also latest-request-only, so a stale failure cannot cover healthy organization data with an error after an account or endpoint switch.
