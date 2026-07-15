# mcp-tool-catalog — See what an MCP gives your agents before they use it

Cast: Alex, an Acme Robotics workspace admin, in OpenWork Cloud. The connected
Incident Response MCP is a real protocol-compatible test server. Catalog
inspection reads its live `tools/list` response and never invokes a tool.

1. Alex opens MCP Connections and sees a compact connected row. Tool inspection and technical setup stay tucked behind More, so the connection list remains easy to scan.

2. Alex opens More, chooses View tools, and immediately sees the searchable live tool names, descriptions, and input counts. Even a large catalog stays manageable, and OpenWork makes the safety boundary explicit: inspecting, searching, or refreshing this list does not run a tool.

3. Alex expands search_incidents to see the provider's read-only hint, which inputs are required, their basic types, and separate input and output schema details. He can now understand what the MCP adds before an agent ever calls it.

4. Alex opens the same connection's manual tool runner from Your Connections at a constrained dashboard width. Refresh tools stays on one line, remains fully visible, and does not create horizontal scrolling; simply opening the runner still does not execute a tool.
