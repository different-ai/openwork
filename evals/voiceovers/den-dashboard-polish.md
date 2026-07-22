# den-dashboard-polish — Admin navigation, connectors, settings, and branding

1. As a workspace admin, I land on the dashboard and can immediately use Quick add for the team’s most common connectors. Extensions now points to the Marketplace instead of the connector setup page.

2. Opening Extensions lands on Marketplace first. The navigation order is Marketplace, Sources, Plugins, and Connectors, with Connectors clearly marked Beta, and each marketplace offers an Add a plugin action.

3. Add a plugin opens the normal plugin creator with the marketplace I came from already selected, so the new plugin is published to the intended catalog without another lookup.

4. Connectors is labeled Beta and explains that this is where the team adds shared MCP servers. There is one clear Add MCP button, the reusable Quick add choices, and no plugin-bundle import path.

5. General settings reports the actual deployed Den commit instead of a generic development label. An admin can view the page while owner-only identity controls remain disabled.

6. The same admin can change Allowed Desktop Versions and save the policy, while an attempted owner-only organization-name change is rejected by the API.

7. The egress support check now has its own Settings → Diagnostics page, keeping General settings focused while preserving the Run egress diagnostic action.

8. After the owner uploads a square workspace icon, the same managed image appears in the sidebar and browser favicon with no gray tile behind it. The brand preview is clean and no longer shows the stray loading line.
