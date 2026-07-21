# mcp-tool-catalog — See what an MCP gives your agents before they use it

Cast: Alex, an Acme Robotics workspace admin, in OpenWork Cloud. The connected
Incident Response MCP is a real protocol-compatible test server. Catalog
inspection reads its live `tools/list` response and never invokes a tool.

1. Alex opens MCP Connections and sees a new View tools action on the connected Incident Response MCP. Discovery stays tucked into the existing connection row, so setup and inspection remain one workflow.

2. Alex opens the searchable catalog and immediately sees the live tool names, descriptions, and input counts. Even a large catalog stays manageable, and OpenWork makes the safety boundary explicit: inspecting, searching, or refreshing this list does not run a tool.

3. Alex expands search_incidents to see the provider's read-only hint, which inputs are required, their basic types, and separate input and output schema details. He can now understand what the MCP adds before an agent ever calls it.

4. Alex edits the same connection and turns off create_postmortem while leaving search_incidents enabled. Tool policy lives beside the connection settings, and reading or changing it still never invokes the provider.

5. After saving, the live catalog clearly marks create_postmortem as disabled. Den also removes it from agent discovery and rejects a forged direct call before the provider sees tools/call, while search_incidents stays available.
