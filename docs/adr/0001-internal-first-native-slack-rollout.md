# Keep the native Slack rollout internal until external use is authorized

**Superseded on 2026-09-30 by [ADR 0002](0002-cloud-slack-before-distribution-approval.md).** The fixed organization/workspace gate below is historical, not the current implementation contract.

ENG-76 will use Slack's Web API through hosted OpenWork Connect, not Slack's MCP server; its initial working-integration milestone is limited to OpenWork's own organization and Slack workspace. The connector may be built for later external availability, but a server-enforced gate must keep external organizations and workspaces disabled until their distribution authorization and search eligibility are established and external enablement is explicitly approved. This deliberately separates implementation readiness from provider permission: a feature flag or invite-only installation does not make external distribution internal, and Marketplace submission is outside this milestone.

The initial live acceptance milestone uses synthetic conversations in an OpenWork-owned validation workspace with normal OpenWork session persistence; everyday internal use is a separate enablement decision after retention and model-processing behavior are addressed. Accepting persistence for synthetic results is not clearance to retain real Slack conversations.

See [the primary-source feasibility research](../research/eng-76-slack-web-api-feasibility.md) for the constraints behind this decision. The user confirmed the design and approved implementation; app creation, live credential changes, flag enablement, external rollout, and outreach require separate approval.
