# org-connections-capability — One /admin switch decides whether org connections exist for an org, consistently on every surface

Org-level External MCP Connections were gated by a bespoke org-metadata flag
(`mcpConnectionsEnabled`) that only an ops script with direct database access
could flip — and it only gated the member-facing list, so an org admin could
publish connections that members (and their desktops) silently never saw.
This flow proves the gate is now a first-class organization capability
(`metadata.capabilities.mcpConnections`), controlled from the /admin
backoffice, and enforced uniformly: dashboard navigation, member surfaces,
and the agent's search/execute capabilities all read the same switch.
Gating posture matches hosted production (`DEN_MCP_CONNECTIONS_GATING_ENABLED=true`).

1. This org hasn't been enabled for organization connections yet — and you can tell, because there's nothing to tell: no Connections section in the dashboard sidebar at all.

2. The desktop app agrees — a member's extensions view shows just their own apps, no org connections, no dead ends.

3. I'm a platform operator, so I open the admin backoffice, find the org, and turn on the MCP connections capability — one checkbox, no database scripts.

4. The org dashboard now has Connections in the sidebar, and I publish the Notion preset for the whole team in a couple of clicks.

5. On the member's desktop, the organization's Notion connection appears under extensions, ready to use.

6. Uncheck the capability and everything goes uniformly dark again — dashboard and desktop agree, because every surface reads the same switch.
