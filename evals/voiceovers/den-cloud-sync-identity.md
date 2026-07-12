# den-cloud-sync-identity — stale organization snapshots never reach workspace sync

1. OpenWork begins a desktop cloud-resource sync for organization A and records the exact Den base URL, token identity, and active organization that authorized the snapshot request.

2. Before organization A’s snapshot returns, the user switches to organization B; the delayed A response is recognized as stale and is not sent to the OpenWork workspace.

3. A sync for organization B reads B’s current snapshot and applies it to the intended workspace, so providers, plugins, and configuration never briefly revert to the previous organization.

4. Missing authentication still returns without syncing, and identity checks compare opaque settings without logging or copying token values into new persistence.
