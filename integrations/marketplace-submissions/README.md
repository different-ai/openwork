# OpenWork gateway listing preparation

**Priority: one approved public gateway listing. Deeper client integrations are a
separate workstream.** Prepared from current official documentation on
2026-10-09; live checks ran on 2026-10-10 UTC. No applications have been submitted
by this preparation, and no publisher terms have been accepted.

## Where things stand

| Destination | Actual status | Next action |
| --- | --- | --- |
| Official MCP Registry | **Published and active**, `com.openworklabs/openwork`, version `1.0.0`, published 2026-09-26 | Keep the existing namespace; do not create a duplicate listing. |
| Cursor official marketplace | Application route and package format established; **not submitted** | Finish native-client verification, supply the publisher account, review the terms, then apply. Most promising first listing for the general gateway. |
| Cursor community directory | Separate submission route; **not submitted** | Optional parallel community submission; this does not grant official Cursor placement. |
| Claude connector directory | **Architecture preflight required; not submitted** | Resolve mixed read/write executor and dynamic-instruction concerns, then provide a durable populated reviewer login. |
| Claude plugin directory | GitHub bundle route established; **not submitted** | Validate the exported small repository and linked connector, then submit separately from the MCP connector. |
| OpenAI universal Plugin Directory | **Known policy mismatch; not submitted** | Build a curated, individually exposed tool surface or obtain written clarification. Do not submit the generic gateway as compliant. |

The official MCP Registry listing does not automatically enroll OpenWork in any
of these curated directories. A personal/repository marketplace is also not a
public-store approval. Claude's directory portal is not a guaranteed route into
`claude-plugins-official`.

## Recommended order

1. **Cursor:** distribute the existing gateway package, prove OAuth and tool use
   in Cursor, and apply to the official marketplace. Submit the community
   directory separately if useful.
2. **Claude:** send the prepared architectural questions to the review team;
   validate Claude web, Cowork and Code independently. Submit connector and
   plugin bundle separately once the actual surface meets review requirements.
3. **OpenAI:** keep direct/private gateway access working, but prepare a bounded
   public surface. Current rules explicitly prohibit discovering operations and
   enabling them through a generic executor. Tool annotations alone do not fix
   this.

Do not delay Cursor for optional UIs, hooks, mods, modes, engine integrations,
or subscription-token sharing.

## Packet

- [OpenAI](openai.md): current universal-directory route, blocker, metadata,
  five-positive/three-negative review-case preparation and OAuth details.
- [Claude](claude.md): connector versus plugin submissions, documented fields,
  architectural questions and review requirements.
- [Cursor](cursor.md): official publisher application, community listing and
  concrete copy.
- [Curated-surface plan](curated-surface-plan.md): concrete reuse points, hidden
  mutations in existing GET readers, OAuth boundaries and required implementation
  proof for the urgent OpenAI/Claude blocker.
- [Reviewer runbook](reviewer-runbook.md): synthetic fixture, account/access
  boundaries, native-client test matrix and private handoff.
- [Preflight emails](preflight-emails.md): unsent drafts for review-policy
  clarification; do not send without an authorized person's approval.
- [Review cases](review-cases.json): reusable test prompts with clearly separated
  private-gateway and proposed-curated-surface expectations.
- [Live evidence](evidence/2026-10-10.md): bounded checks, failure diagnoses and
  remaining unverified work.
- Existing portable plugin: [`../agent-plugins/openwork-connect`](../agent-plugins/openwork-connect).
- Existing registry manifest: [`../../ee/apps/den-api/server.json`](../../ee/apps/den-api/server.json).

The packet contains no passwords, claim links, OAuth clients or tokens. Review
contacts and credentials belong in private submission fields, not in public PRs,
ZIPs, Git repositories or screenshots.

## Repeat the checks

No new dependencies are needed. The preflight is internal tooling, not a new
product feature, and does not alter the gateway.

```sh
# Public GETs and one unauthenticated MCP request; no account creation.
node scripts/marketplaces/gateway-preflight.mjs --public

# Explicitly creates one isolated, provisional workspace and a synthetic skill.
# Use a NEW owner-only directory OUTSIDE the checkout.
node scripts/marketplaces/gateway-preflight.mjs --prepare-qa /absolute/private/new-directory

# Reuses that workspace and fixture without creating another account/workspace.
node scripts/marketplaces/gateway-preflight.mjs --check-qa /absolute/private/new-directory

node --test scripts/marketplaces/gateway-preflight.test.mjs
```

The QA workspace expires after 72 hours; its assertion is secret. State is
stored in `bootstrap.json` with mode `0600` in an owner-only directory. The
script prints only a sanitized report. Claiming the workspace revokes its
anonymous credentials. **This is not a password-backed reviewer account and
must not be supplied as one.** The CLI intentionally has no submit, publish,
billing, invitation, real-connector or external-message action.

## Approval-dependent handoff

An authorized owner still needs to provide:

- The intended OpenAI organization/project and verified business identity,
  paid Claude organization/submitter role, and Cursor publisher identity.
- A real company-controlled reviewer inbox or an existing review account, with
  credentials supplied through a secure channel. Do not invent an email address
  and assume it receives verification mail.
- A durable, isolated reviewer workspace with the exact production capabilities
  being submitted; no admin access, billing, customer connections or personal
  data beyond the login identity.
- Native-host recordings/tests and a reviewed, accurate legal/data-handling
  description.
- The final application fields, country availability, policy acknowledgments and
  approval to submit/accept publisher terms.

## Common readiness gaps

- Native ChatGPT/Codex, Claude and Cursor OAuth, refresh, revoke and tenant
  isolation remain unverified. Public docs correctly label these clients
  **Setup only**; do not change them to Verified based on this preflight.
- All 14 tools observed in the isolated QA catalog carry the four explicit
  annotations. Their correctness still needs behavioral review. Catalogs may
  differ by organization and grants.
- OpenWork-specific generated-app launch metadata is not proof that generic
  hosts render those apps. Start with text-only workflows rather than adding UI
  obligations to the urgent listing.
- Terms currently say content is not retained after processing, while saved
  skills/workflows exist. Privacy should explicitly cover the MCP gateway,
  downstream dispatch, operational records and retention; verify billing and
  subprocessors. Legal owners must resolve discrepancies, not mechanically
  copy an inaccurate claim into a form.
- OpenAI requires general-audience suitability including ages 13–17; current
  OpenWork terms require 18+. Resolve the audience/eligibility mismatch with
  legal and the review team; do not silently change age terms.

See the platform packets for primary sources and distinguish verified published
requirements from policy assessments and owner-dependent facts.
