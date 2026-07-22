# marketplace-plugin-mcp-auth - Assigned plugin capabilities guide each user through the connection they need

Alex is an Acme Robotics admin. Maya is on the Support team and works from an MCP-compatible harness with only the OpenWork MCP connected. The Support Operations plugin contains three Slack-dependent skills: Triage support channel, Prepare escalation brief, and Create shift handoff.

1. Alex opens the marketplace and assigns Support Operations to the Support team. Its three cloud skills become available through the OpenWork MCP automatically, with no separate installation step for Maya or anyone else on the team.

2. OpenWork recognizes that the assigned plugin contains a Slack MCP and shows Alex exactly what is missing. The server details come from the plugin, so Alex does not copy URLs or recreate the connection manually; he only chooses whether the organization shares one account or each user connects their own.

3. Alex chooses individual accounts. OpenWork configures the Slack requirement for the Support team and shows that assigned users can now connect, while all three skills remain automatically discoverable through search.

4. In her MCP-compatible harness, Maya asks for a handoff of unresolved support issues. OpenWork search finds Create shift handoff because the marketplace is assigned to her team, even though Maya never installed the plugin and the harness never loaded its skills or Slack MCP directly.

5. When the harness tries to execute the capability, OpenWork sees that Maya has not connected Slack. Instead of returning a generic authentication error, it explains which connection is required, why it is needed, and gives Maya a secure OpenWork link to continue.

6. The link opens Your Connections directly on Slack. Maya sees that it is required by Support Operations, connects her own account through the provider's authorization flow, and returns with the connection marked ready.

7. Maya retries the same request, and OpenWork executes the capability using her Slack permissions. If Alex had selected an organization-shared connection, the request would have worked immediately without asking Maya to sign in.
