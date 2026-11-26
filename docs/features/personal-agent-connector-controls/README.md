# Agent connector controls

- Feature key: `personalAgents` (existing)
- Deployment: Cloud; Agents are off by default
- Owner: `benjaminshafii`

Enable this feature for an organization that has `personalAgents` enabled. New agents only see tools on connectors chosen for them; existing agents keep their access. In a run, the agent can see the names of eligible off connectors and ask for one by name. If it names a verified, exact tool, the person can grant that tool once for a later run. An owner can turn on the connector; a manager's request to turn it on waits for the owner. Turning on the connector does not approve writes or bypass the organization's rules.

To try it, create an agent without selecting a connector and start a routine that needs one. Check the agent's requests, turn on the connector, and verify that a later run can read from it. Check that a write still asks for approval. If the feature is disabled, no new connector requests can be made or granted, and existing requests remain readable. Check the agent's activity for new requests, manager escalations, and decisions.
