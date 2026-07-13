# Marketplace Core Extension Surface

1. The marketplace list now seeds an OpenWork Directory from the existing MCP presets, and the directory exposes pure plugin items with schema-driven setup fields instead of credentials.

2. An admin can configure a directory MCP template into an External MCP Connection, and the resulting connection is bound back to the plugin item with server metadata.

3. API-key templates use the same marketplace path: the entered key is stored on the External MCP Connection, while plugin template responses keep only metadata and field declarations.

4. A GitHub plugin URL can still import skills into the org skill store, and the imported skill is available through the same search-capabilities surface as native tools and MCP tools.

5. When an admin disables the imported skill item, the skill disappears from search and direct execute no longer returns the skill content.
