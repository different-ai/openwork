# remote-auto-compaction — workspace preferences read and write only their owning server

1. A user opens Preferences for a remote workspace; Auto context compaction stays disabled while OpenWork loads that worker’s actual configuration, then shows the saved remote value.

2. Toggling Auto context compaction writes `opencode.compaction.auto` through the selected workspace endpoint and server-side workspace ID, without reading from or mutating the local workspace configuration.

3. Switching between local and remote workspaces reloads the preference from each owning server, and a late response from the previous workspace cannot overwrite the newly selected workspace’s state.

4. If the remote worker is unavailable, the switch remains disabled instead of presenting an unverified default or attempting a local fallback; reconnecting and refreshing restores the authoritative remote value.
