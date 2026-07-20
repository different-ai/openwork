# org-connections-capability — One /admin switch decides whether org connections exist for an org, consistently on every surface

Org-level External MCP Connections used to require a staged rollout flag. Now
Connect is default-on, and the emergency brake is a first-class organization
capability (`metadata.capabilities.mcpConnections`), controlled from the
/admin backoffice and enforced uniformly: dashboard navigation, member
surfaces, and the agent's search/execute capabilities all read the same switch.
The old `DEN_MCP_CONNECTIONS_GATING_ENABLED` deployment flag is inert.

1. This org has explicitly disabled organization connections — and you can tell, because there's nothing to tell: no Connections section in the dashboard sidebar at all.

2. The desktop app agrees — a member's extensions view shows just their own apps, no org connections, no dead ends.

3. I'm a platform operator, so I open the admin backoffice, find the org, and restore the MCP connections capability — one checkbox, no database scripts.

4. The org dashboard now has Connections in the sidebar, and I publish the Notion preset for the whole team in a couple of clicks.

5. On the member's desktop, OpenWork Connect shows the organization's Notion connection under Needs your sign-in, ready for that member to connect.

6. Uncheck the capability and everything goes uniformly dark again — dashboard navigation disappears and the Connect org row is gone, because every surface reads the same switch.
