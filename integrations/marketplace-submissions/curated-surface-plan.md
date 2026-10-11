# Urgent public-surface implementation plan

This is listing-blocker work, **not** the optional deeper-integration project.
No endpoint, feature flag or generated API change is implemented by this packet.

## Decision

Keep the general `/mcp/agent` unchanged for direct/private clients. Add a static,
server-owned, enforceably bounded Library MCP surface for public review if
OpenAI/Anthropic confirm the intended scope. Do not expose the entire `/mcp`
OpenAPI catalog, rename a catch-all executor or use a benign reviewer account as
the security boundary.

A metadata-only first slice has three proposed operations:

- `list_library_skills`: bounded metadata for granted items.
- `get_library_plugin`: authorized Plugin metadata/component summary.
- `get_library_skill_metadata`: title, description and source/version metadata;
  deliberately no behavioral instruction body.

This is the conservative alternative to the document-read/add candidate in
[`openai.md`](openai.md). Choose the useful reviewed scope before implementation
and rewrite the draft review cases accordingly. Metadata-only may not provide
sufficient independent user value; acceptance is not guaranteed. User-requested
content retrieval is a separate policy/product decision, not an automatic
“follow these instructions” mechanism.

## Existing code to reuse

Baseline inspected: committed `origin/dev` `b439de768`.

| Concern | Existing source / boundary |
| --- | --- |
| Public token verification | `ee/apps/den-api/src/mcp/auth.ts` and `resource.ts`: issuer, audience/resource, token use, scopes, grant/session liveness, active membership. |
| Narrow skill descriptor reads | `ee/apps/den-api/src/mcp/marketplace-capabilities.ts`: `listAccessibleMarketplaceSkillDescriptors`; member/team/org grants. Do not include built-in generic-execution instructions. |
| Library authorization | `ee/apps/den-api/src/routes/org/plugin-system/access.ts`: actor and capability/grant checks. Preserve all checks, not just organization ownership. |
| Item/version readers | `ee/apps/den-api/src/routes/org/plugin-system/store.ts`: Plugin/config-object detail readers. Project a deliberate metadata output, never serialize full raw source implicitly. |
| Exact native REST execution | `ee/apps/den-api/src/mcp/invoke.ts`: fixed operation re-entry can preserve route authorization/validation/audit; no caller-selected method/path/capability. |
| Finite-tool precedent | `ee/apps/den-api/src/mcp/app-server.ts` and `app-tools.ts`: exact declared tools, unknown-call rejection, read-scope checks and native-operation restrictions. |
| HTTP transport | `ee/apps/den-api/src/mcp/agent-http.ts`: authenticated scope isolation and dual-era transport. Choose one SDK version deliberately; not every registrar uses the same SDK generation. |

## Traps that prevent a trivial allowlist patch

1. Some **GET Library readers mutate data**. `listPlugins` and the effective
   member-library path call `retireEmptyStarterPlugins`; `listMarketplaces`
   provisions defaults/retirements. A GET method is not sufficient evidence for
   `readOnlyHint: true`. Extract shared pure readers and keep cleanup/provisioning
   outside the new read operations.
2. Resolved item/version serializers can include `latestVersion.rawSourceText`.
   Explicitly project minimal outputs so a metadata tool does not leak raw
   instructions/source or unnecessary internal fields.
3. Current `get_skill` tells the model to read and follow dynamic SKILL.md, and
   built-in skills direct generic execution/sharing. Do not reuse that tool or
   the current server instructions unchanged.
4. Generic response-truncation text suggests `execute_capability_script`.
   Curated output/error helpers must not point at a hidden escape hatch.
5. Ordinary authored Apps are organization-owned and mutable; revisions can
   change the catalog, descriptions and UI, and bindings support Workflows and
   external MCPs. A saved App is useful for an internal proof, not a stable
   product-wide reviewed endpoint.

## OAuth decision

Standalone App endpoints already use public-agent verification and the canonical
agent audience. That proves a finite child server can reuse the current auth
boundary without accepting arbitrary audiences. It does **not** grant
Library-only token authority: an agent-scoped token still authorizes its parent
surface according to its scopes and grants.

Choose explicitly between an intentionally shared logical protected resource
and an independent Library audience. A shared-resource child must advertise the
correct RFC 9728 discovery and be tested in each target client; do not assume
reviewers accept a different logical resource identifier. An independent
resource requires changes to the current singleton normalization/JWT contract,
not just another metadata alias. The public listing should request only needed
read scope and optional refresh access; writes need separate truthful scope and
annotation review.

Never claim an independent authority boundary while reusing a broadly scoped
agent token. Preserve consent, PKCE, resource validation, redirect security and
membership/grant checks.

## Proposed implementation PR

Before feature code, declare a cloud-only default-off registry feature, e.g.
`publicLibraryMcp`. Then:

- Add `ee/apps/den-api/src/mcp/library.ts` with static server instructions,
  exact registrations, bounded inputs/output schemas, explicit annotations and
  tool OAuth declarations; no generic capability registry or hidden resources.
- Register it in `ee/apps/den-api/src/app.ts` and add correct metadata/auth/audit
  plumbing. Resolve the feature fresh per authenticated request.
- Kill switch refuses the new endpoint; **never falls back to `/mcp/agent`**.
  Existing general/private gateway behavior remains unchanged.
- Add required audit declarations and shared pure readers/projections, retaining
  REST/membership/grant boundaries and no new database schema unless proven needed.
- Run `pnpm features:sync` / `pnpm den:contract`; include the generated
  `packages/docs/openapi.json`, `packages/sdk/src/gen/**` and rollout artifacts.

Required proof:

1. Exact fixed catalog; identical tool definitions for members/admins. Unknown
   executor/search/script/admin/proxy calls rejected, not merely unlisted.
2. No dynamic instruction/resource/connection-index/raw-source leakage.
3. Successful read-only OAuth; wrong audience, revoked grant/membership,
   cross-workspace and ungranted-item refusal.
4. Repeated reads leave Library domain rows unchanged; correct error/output
   minimization and annotation behavior.
5. Feature-off refusal, safe in-flight behavior and unchanged private gateway.
6. Native-host OAuth/tool proof and a useful repeatable review scenario.

Reuse journey patterns in `evals/specs/mcp-app-servers.e2e.test.ts`,
`mcp-auth-rate-limit-recovery.e2e.test.ts`, `skill-grant-access.test.ts` and
`ee/apps/den-api/test/mcp-policy.test.ts` without treating their existing
synthetic/reference-host tests as native-client evidence.

The read-only scoping audit estimates **2–3 engineering days** for a three-tool
metadata-only slice, with further work for an independent audience or content/UI
surface. This is an estimate, not a delivery promise. Semantic read-only behavior,
policy eligibility and real client authentication are the gating work—not tool
registration.
