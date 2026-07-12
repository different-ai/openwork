# remote-settings-connections — Settings manages connections on the selected workspace's server

1. A user selects a remote workspace and opens Connect or AI Providers in Settings; the lists come from that workspace's owning worker, so they match the connections available in the remote session.

2. Adding, editing, or removing an MCP or provider configuration sends the request through the same remote endpoint and its server-side workspace ID; the local OpenWork server and local workspace configuration remain unchanged.

3. When a provider change requires an engine reload, Settings asks the owning remote worker to reload that workspace, then refreshes providers from the remote engine instead of reloading the local engine or silently disposing the wrong client.

4. If the remote worker disconnects, connection changes fail within that remote workspace and never fall back to local configuration; reconnecting and refreshing restores the authoritative remote MCP and provider state.
