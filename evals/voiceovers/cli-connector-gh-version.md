# cli-connector-gh-version — GitHub CLI connector vertical slice

1. A workspace admin opens Connectors and sees one reviewed GitHub CLI Demo action. It needs no credentials and exposes only a hosted version check.

2. Enabling the connector is one click and idempotent. The card and connector row become Ready, with exactly one read-only command pinned to manifest version 1.0.0.

3. The same organization’s agent MCP still exposes only search_capabilities and execute_capability. Search discovers the exact cli connection capability, and execution either returns the pinned GitHub CLI result through Daytona or fails closed when Daytona is not configured—never falling back to a desktop binary.
