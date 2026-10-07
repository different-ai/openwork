# ENG-76: Native Slack for OpenWork Cloud

Status: **Approved for implementation; scope revised 2026-09-30.** Build the multi-workspace hosted integration and demo it before pursuing Slack approval. Live app setup, credentials, deployment enablement, and provider outreach have not been performed.

## Working-integration milestone

Prove Cloud members in different OpenWork organizations can authorize their own Slack workspaces, find discussions, read thread context, and receive source-linked answers without customer developer setup. A synthetic multi-workspace demo precedes provider approval. Slack Marketplace/RTS distribution approval is now part of the launch path, not a prerequisite to building this integration. A separately arranged live internal demo uses synthetic conversations in an OpenWork-owned workspace.

## Agreed product scope

- Use Slack's Web API, not Slack's upstream MCP server. Reuse normal OpenWork Connect capability interfaces rather than introducing a desktop-only integration.
- OpenWork supplies the Slack app for hosted Connect. Members do not create apps, configure app permissions, or supply client credentials. Workspace administrator approval and individual authorization may still be required.
- Read-only search and thread context across public channels, private channels, one-to-one DMs, and group DMs, bounded by the connecting member's Slack permissions.
- One connected Slack workspace per member for the initial release.
- Live lookup only: no background sync, bulk history import, or separate Slack archive.
- Bounded reads with clear incomplete-context indicators and source links. A thread excerpt must not be represented as a complete thread; users can request more context.
- Partial consent remains usable. Public-only access is not a broken connection; private/DM categories are queried only when authorized, and unavailable categories must not be reported as having no results.
- No message sending, replies, reactions, or file-content search in this milestone.
- The first end-to-end acceptance surface is OpenWork desktop using hosted Connect. Self-hosted platform-app setup and additional client-specific acceptance journeys are outside this milestone.
- A minimal in-Slack connection/help surface is allowed if needed to satisfy RTS app guidance, such as an App Home explaining the integration and linking to connection management. No chatbot or conversation-message posting is included; the precise provider requirement must be verified rather than assuming a decorative page satisfies it.
- For synthetic-data-only acceptance, normal OpenWork session persistence is acceptable. Do not build a new retention system for this milestone, add a Slack archive or content logging, or promise zero retention. Ordinary internal or external real-data use remains separately gated.

## Existing integration compatibility

The original issue calls for preserving the enterprise BYO-app path. The proposed native connector must not silently migrate or delete existing Slack MCP/BYO connections, change their credentials, or remove the eligibility warnings applicable to that distinct path. Any change to those existing connections requires a separate decision; their existence does not establish permission for new external installations.

## Availability boundary

The integration targets hosted multi-org Cloud. OpenWork configures one platform app. Workspace/member identities are verified from Slack OAuth and `auth.test`; customers never supply workspace IDs, client credentials, or app registrations. One member-owned account slot remains supported; explicit reauthorization can select a different workspace, while refresh must retain both workspace and member identity.

The shared feature registry declares `nativeSlack` (**Slack search**) default-off and Cloud-only. Platform administrators roll it out through the existing `/admin` controls, either per OpenWork organization or by changing the deployment-wide default. The shared kill switch overrides both. An organization's explicit off overrides an everyone-on default; clearing its override means inherit. This controls availability, not provider authorization. Keep the public production release disabled until Slack distribution/search eligibility and real-data processing decisions are resolved. Controlled synthetic demo deployments can exercise the completed architecture before approval.

The deployment classification is `DEN_DEPLOYMENT=cloud`, with `DEN_ORG_MODE=multi_org`; single-org and self-hosted deployments remain excluded. The former Slack-specific environment switch is removed. OAuth and capability routes also respect general organization Connect policy. Customer organization ownership is not platform-admin authority: customers cannot grant themselves this feature, override the platform OAuth app, or create additional native Slack slots. Feature granularity is the OpenWork organization, not individual members, teams, or Slack workspace IDs. App Home uses encrypted per-workspace installation grants returned by OAuth, not a deployment-wide bot token; its generic help plumbing respects shared deployment/kill/lock constraints without inventing an organization from a Slack workspace.

See [ADR 0002](adr/0002-cloud-slack-before-distribution-approval.md) and [Cloud setup](slack-cloud-setup.md).

## Acceptance proof

The agreed live journey is:

1. Authorize without member-side developer setup in OpenWork desktop using hosted Connect.
2. Search for a known synthetic discussion and retrieve bounded thread context.
3. Produce a useful answer with links to the Slack sources and an explicit indication if context is incomplete.
4. Demonstrate public/private-channel, one-to-one-DM, and group-DM access using synthetic conversations.
5. Use two internal test members to prove one member cannot retrieve another member's inaccessible private conversations.
6. Demonstrate usable partial consent without claiming unsearched categories had no results.

The proof also covers two synthetic Slack workspaces and two OpenWork organizations with the same platform configuration. A new organization must authorize its own account rather than reuse another organization's grant. Cross-workspace thread requests must use the caller's token and fail when inaccessible. Unflagged/disabled organizations, a shared kill switch, excluded deployments, single-org topology, and disabled organization Connect policy must reject retained capabilities. The generated Admin controls demonstrate opt-in for one organization without granting another organization access.

Synthetic verification receipts are recorded in `docs/evidence/eng-76/verification.md`; no live Slack proof is claimed.

## Implementation and activation facts

- Slack's modern Real-time Search API documents internal-app eligibility and outside-Slack user-token queries. This does not clear external unlisted distribution. Legacy search is not an established permitted fallback.
- RTS general guidance also asks for an in-Slack experience but does not define the minimum internal-app surface. OpenWork-side acceptance and app-level provider requirements are distinct.
- OpenWork's normal session history retains tool output. Saved Workflows can retain result snapshots; disconnecting an account does not erase existing transcripts or snapshots. No end-to-end per-provider no-persistence switch was found.
- An arbitrary external client controls its own storage after receiving capability results. A hosted connector cannot promise to erase or prevent all client-side copies.
- Internal own-company use differs from external commercial distribution, but neither a read-only interface nor live lookup alone establishes permission for every retention or model-processing arrangement.

## Provider setup and activation prerequisites

These are checks to complete before live activation, not permission granted by this design:

- Verify the chosen direct search API and internal app setup meet Slack's documented eligibility, scope, consent, and app-level experience requirements. Modern RTS is the documented internal-app candidate; do not silently substitute legacy search to bypass unresolved requirements.
- Determine the precise minimal in-Slack connection/help surface needed. If the requirement cannot be established, record it as an activation blocker rather than claim the app is compliant.
- Confirm the OpenWork organization and owned validation workspace, synthetic fixtures, and two test members without putting private identities or live credentials into public documentation or fixtures.
- Obtain separate approval before creating an app, provisioning live fixtures, configuring credentials, or enabling the gate. No external installations or outreach are authorized.
- Keep routine real-data use and external availability disabled. Review model processing, result retention, and provider authorization before either is enabled.

## Implementation authorization and verification seams

The user reviewed the documents and approved implementation. App creation, live credential changes, flag enablement, external rollout, and outreach remain separate approval-gated actions.

The retained E2E journey exercises member-facing connection discovery and consent state; OAuth authorization and disconnect; native Connect search/thread execution including direct-route and retained-capability denial; and the app-web connection journey with synthetic providers. It also verifies that limited access is not a policy block and that disabled organization availability names OpenWork as policy owner rather than requesting reconnection. The same journey exercises platform-only changes through the shared organization and deployment feature UI, including inheritance, explicit off, kill and restore. Following the repository's E2E-only verification convention, package-level unit suites are not retained; their historical Home, rotation, diagnostics-rendering and schema-rejection receipts are not current journey coverage. Provider HTTP, credential storage, and identity fixtures may be controlled in tests; private implementation details are not the acceptance contract.

## References

- [Domain glossary](../CONTEXT.md)
- [Slack feasibility and internal-preview research](research/eng-76-slack-web-api-feasibility.md)
- [Existing external MCP OAuth behavior](external-mcp-oauth.md) — the existing Slack MCP/BYO path is distinct from this proposed native connector.
