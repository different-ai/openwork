# Cloud plugin MCP warnings

This demo proves that marketplace plugins can bundle both skills and MCP servers, and that a bad MCP payload no longer disappears silently.

1. I’m signed in to the local Acme cloud org and open the Extension Marketplace. Two fresh org plugins are visible side by side: one intentionally broken MCP bundle and one valid Linear MCP bundle.

2. I install the broken bundle first. The skill still imports, but OpenWork now warns me that the Broken MCP component could not be installed because no server config with a url or command was found.

3. I check the durable state after that warning. The skill is listed for this workspace, while the MCP settings page has no broken server row, so the app is honest about the partial install.

4. I install the valid bundle next and return to MCP settings without reloading the engine. The Linear MCP appears in Your apps immediately, proving the valid remote server was installed and hot-synced.
