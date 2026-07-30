# semi-airgapped-den-contract — Semi air-gapped Den deployments keep their network contract

1. The desktop only needs one Den address: the private Den web origin behind the VPN. From that one address it derives the API and MCP paths, so the firewall request stays to a single hostname.

2. Den blocks private MCP server addresses by default, protecting hosted deployments. For a customer network, the operator must deliberately turn on the documented private-MCP switch before Den can reach those internal servers.

3. The desktop diagnostic refuses to contact a Den MCP endpoint unless the origin is trusted. If a self-hosted origin is not on the list, the check is skipped before any organization token can leave the laptop.

4. Den's outbound diagnostics target is configurable, so a VPN-only deployment can point the self-check at its own diagnostics service. The default public target remains explicit, and the bearer token must be long enough to be safe.
