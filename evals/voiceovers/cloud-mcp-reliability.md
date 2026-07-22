# cloud-mcp-reliability — Verify and repair Cloud agent access per workspace

1. I open **Settings → Connect** and see my connected service separately from **Agent access to connected services**, so service connectivity and agent readiness are clearly distinguished.

2. Agent access clearly says Ready, Connecting, Disabled, or Degraded. If it is degraded, I see the first failing stage and what to do next—for example, sign in, select an organization, repair authentication, update OpenWork, or choose a model that supports the Cloud tools.

3. I click **Test now** for a read-only live check. OpenWork confirms whether Cloud is actually available in this workspace rather than trusting saved configuration.

4. I click **Repair and test**. OpenWork repairs access for this exact workspace and verifies the live connection and tools.

5. Every stage becomes healthy, and the card shows both `openwork-cloud_search_capabilities` and `openwork-cloud_execute_capability` as available to my current model.

6. In **Advanced Settings**, I can inspect workspace, revision, delivery, version, plugin, and compatibility diagnostics or copy a sanitized report without exposing credentials.

7. I start a new task and request an action against my connected service. The agent searches Cloud capabilities first and does not substitute documentation search for the requested action.
