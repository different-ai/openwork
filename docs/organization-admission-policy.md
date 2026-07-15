# Organization admission policy

OpenWork authenticates a person into one global account and authorizes that account for each organization separately. Successful authentication never implies organization membership.

Every user-backed membership is evaluated by the Den admission service before it is created, bound, or reactivated. Invitation placeholders may exist without a user ID; they are not admitted memberships.

## Standard flow

1. Authenticate or identify the global account.
2. Select an organization or present trusted admission evidence.
3. Load the organization policy, verified account state, active or removed membership, invitation, SSO, SCIM, claim, and seat evidence from Den storage.
4. Evaluate without mutation.
5. Return an allow decision, a required next step, or a denial.
6. On allow, lock and re-evaluate the relevant policy, membership, evidence, and seat state before committing membership, provenance, evidence consumption, and audit records.
7. On protected organization requests, require an active membership and the exact organization/provider SSO assurance when configured.

The explicit evaluation endpoint never mutates membership or consumes evidence; it writes a redacted evaluation audit. Joining is always explicit except for the eligible initial owner, a valid one-time workspace claim, SSO JIT, and SCIM provisioning.

## Presets

Presets are UI shortcuts over the versioned, composable policy.

| Preset | Admission methods | Email domains | Authentication | Lifecycle |
| --- | --- | --- | --- | --- |
| Open | Self-join, invitation | Any | Any | Local |
| Domain restricted | Self-join, invitation | Exact allowlist | Any | Local |
| Invite only | Invitation | Any by default | Any | Local |
| SSO JIT only | SSO JIT | Provider trust | Organization SSO | Local |
| SCIM managed + SSO | SCIM | Provider trust | Organization SSO | SCIM |
| Invite or SSO | Invitation, SSO JIT | Any by default | Any | Local |

Advanced controls can express other valid combinations. At least one method is required. Domain allowlists must contain valid normalized domains. SSO-dependent policies require an enabled, domain-verified organization provider. SCIM-managed lifecycle requires an enabled SCIM provider and SCIM as the sole ordinary admission method. A depended-on SSO or SCIM connection cannot be deleted.

Domain comparison lowercases and converts IDNs to ASCII. It is exact: allowing `example.com` does not allow `sub.example.com`.

## Decision order

The evaluator applies this precedence:

1. Deny unavailable organizations or policy state.
2. Return an existing active membership without changing its role or provenance.
3. Enforce sticky removals.
4. Validate trusted invitation, SSO, SCIM, workspace-claim, bootstrap, or admin-restore evidence.
5. Select an enabled method and candidate role.
6. Enforce verification and exact domain requirements.
7. Require exact organization SSO assurance without consuming pending evidence.
8. Validate seat availability.
9. Commit atomically and audit the outcome.

Email self-join, invitations, organization creation, and workspace claims require a verified account email. SSO and SCIM rely on provider evidence. Invitations, SSO, SCIM, and admin restoration cannot grant `owner`; only the eligible initial owner and a valid owner workspace claim can do so. Dynamic member and admin roles remain supported.

An administrative removal is sticky. Self-join and SSO JIT cannot silently restore it. A new invitation, explicit administrative restoration, or authoritative SCIM reactivation is required. Voluntary leavers may explicitly rejoin when the current policy allows it. Removed rows retain their user ID and are reactivated rather than duplicated.

## Trust boundaries

Clients can request an evaluation but cannot assert that an email is verified, an invitation is valid, an SSO provider was used, or a SCIM identity is active. Den loads those facts from its own tables.

Better Auth may create or identify the global user. Its SSO organization auto-provisioning is disabled. SCIM mutations run with a request-scoped grant derived from the organization bearer token. Better Auth member hooks reject ungranted user bindings in enforcement mode. Raw organization mutation endpoints are observed in shadow mode and rejected in enforcement mode when they could bypass canonical admission.

Browser sessions record authentication method, provider, organization, and time. SSO assurance is organization-specific: assurance for organization A cannot satisfy organization B. API keys, OAuth/MCP grants, and internal service identities remain non-interactive and continue to use their organization and permission scopes.

Invitation tokens are random, one use, and valid for seven days. Den stores only SHA-256 hashes. Resending rotates the token; cancellation invalidates it. Raw tokens are excluded from API responses, persistence, logs, and audits.

## Migration

The migration creates one versioned policy per existing organization and records membership admission provenance.

- Existing active memberships are grandfathered as `legacy`.
- Multi-organization workspaces default to invitations, with SSO JIT or SCIM added when those connections exist.
- Single-organization workspaces preserve self-join eligibility through the first policy read or admission reconciliation, but require an explicit join after the initial owner.
- Existing domain restrictions become the exact allowlist without enabling self-join in multi-organization mode.
- Existing `requireSso` metadata becomes organization SSO. A configured single-organization SSO connection also remains required.
- Existing organizations retain local lifecycle authority until an admin explicitly adopts SCIM management.
- New multi-organization and provisional workspaces default to invite-only; a valid provisional claim remains a one-time privileged admission.
- Legacy domain and `requireSso` response fields are mirrored for older clients. They are not admission decision sources.
- Existing invitation links are preserved by hashing the current token, or the invitation ID used by older links, before the raw column is cleared.

## Rollout

`DEN_ORG_ADMISSION_ENFORCEMENT` accepts `shadow` or `enforce` and defaults to `shadow`.

In shadow mode, explicit evaluation and join endpoints follow the policy. Legacy automatic paths evaluate and record mismatches while preserving their previous effective result through the centralized service. Raw Better Auth bypass attempts are recorded.

OpenTelemetry counters record evaluations and shadow mismatches by method, structured decision or reason, policy version, enforcement mode, and effective outcome. Organization and user identifiers are intentionally omitted from metric dimensions.

In enforcement mode, every new user-backed membership requires an allow or privileged bootstrap decision. A missing policy fails closed for new admission while existing active members remain usable. Protected browser requests enforce exact organization SSO assurance.

Audits include organization ID, user ID, method, decision, reason, policy version, enforcement mode, and membership ID. They exclude email addresses, invitation tokens, assertions, SCIM payloads, and identity-provider credentials.

## Enforcement activation checklist

Before changing from shadow to enforce:

- Confirm every organization has a readable policy and dependencies are healthy.
- Review shadow mismatches by method, reason, and policy version.
- Confirm current SSO connections are enabled and domain verified where required.
- Confirm SCIM-managed organizations have an enabled provider and successful provisioning/deprovisioning checks.
- Confirm invitation delivery and token rotation behavior.
- Confirm legacy clients no longer call raw membership mutation endpoints.
- Exercise account-only signup, explicit self-join, invitation plus SSO, SSO JIT, SCIM lifecycle, workspace claim, admin removal/restore, organization switching, and seat exhaustion.
- Enable enforcement in a staged environment, monitor denial and policy-unavailable alerts, then promote gradually.
