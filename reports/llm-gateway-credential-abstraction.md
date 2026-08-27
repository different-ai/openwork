# LLM gateway credential abstraction

## Recommendation

Split the current Cloud provider object into three concerns:

1. **Gateway profile** — shared endpoint, protocol, models, and display configuration.
2. **Access policy** — which members, teams, or workloads may use which models.
3. **Credential binding** — how a specific principal authenticates to that gateway.

Then add optional **control-plane adapters** for gateways such as LiteLLM. Generic
OpenAI-compatible endpoints keep working without an adapter.

For the immediate enterprise use case, ship these together:

- `per_member` credentials as the portable baseline;
- generic binding APIs and UI states that any provisioner can drive — a member
  pasting a key, an admin bulk-importing, or an automation;
- a maintained LiteLLM recipe built on those generic APIs, promoted to a
  packaged adapter only if repeated demand proves it out;
- a later federated-token mode for customers that already operate OIDC/JWT.

The schema is the one-way door; keep it vendor-neutral. Recipes and adapters
are two-way doors and can stay outside core.

Do not make “one provider row per person” the product model. Do not make a
customer-maintained sync script the permanent solution.

## What is wrong with the current shape

Today one `llm_provider` owns one credential. Member, team, and organization
access rows only control who may see that provider; they do not select a
different credential. An authorized desktop receives the raw Cloud credential.

That creates several problems:

- A shared key cannot provide per-user attribution, budgets, or revocation.
- Duplicating a provider for every user creates administrative and model-policy
  drift.
- Duplicate providers can collide because runtime credentials are partly
  flattened by environment-variable name rather than kept by runtime provider
  identity.
- Hosted worker materialization currently loads organization providers without
  applying the creating member's provider grants.
- The secret-returning `/connect` route is exposed through the generated MCP
  surface.

Relevant implementation areas:

- `ee/packages/den-db/src/schema/sharables/llm-providers.ts`
- `ee/apps/den-api/src/routes/org/llm-providers.ts`
- `ee/apps/den-api/src/llm/provider-credentials.ts`
- `apps/server/src/cloud-provider-sync.ts`
- `apps/server/src/managed-provider-auth.ts`
- `ee/apps/den-api/src/llm/cloud-provider-materialization.ts`

## Proposed domain model

```ts
type Principal =
  | { kind: "member"; id: string }
  | { kind: "team"; id: string }
  | { kind: "workload"; id: string }

type CredentialPolicy =
  | { kind: "shared" }
  | { kind: "per_member"; source: "member_supplied" | "provisioned" }
  | { kind: "per_team"; source: "admin_supplied" | "provisioned" }
  | { kind: "federated"; protocol: "oidc_jwt" }

interface GatewayProfile {
  id: string
  protocol: "openai_compatible" | "anthropic_compatible" | "custom"
  baseUrl: string
  modelCatalog: ModelDefinition[]
  credentialPolicy: CredentialPolicy
  adapterId?: string
}

interface AccessPolicy {
  gatewayProfileId: string
  principal: Principal
  allowedModels: string[]
}

interface CredentialBinding {
  gatewayProfileId: string
  principal: Principal
  secretRef?: string
  externalPrincipalId?: string
  externalCredentialId?: string
  state: "pending" | "active" | "blocked" | "error"
  version: number
}
```

Important rules:

- Store a secret reference, not a secret, in ordinary domain responses.
- Resolve credentials by gateway profile and principal, never by environment
  variable name.
- Materialize a unique runtime provider identity for the resolved binding.
- Make overlapping team credentials explicit. Never silently pick one based on
  database ordering.
- Keep credential source separate from delivery. A provisioned credential may
  be delivered directly to the desktop today and brokered later.

## Adapter contract

Blocks come first: the core schema, binding APIs, and UI states must never
reference a vendor. An "adapter" is only a packaged, supported provisioner —
the promotion of a recipe that already works through the generic APIs. Core
code depends on the contract below, never on LiteLLM.

OpenAI compatibility describes the inference data plane; it does not imply a
portable user, team, key, budget, or audit API. Those features belong behind an
optional adapter.

```ts
interface GatewayControlPlaneCapabilities {
  principals: "supported" | "unsupported" | "unknown"
  teams: "supported" | "unsupported" | "unknown"
  credentialLifecycle: "supported" | "unsupported" | "unknown"
  modelEntitlements: "supported" | "unsupported" | "unknown"
  budgets: "supported" | "unsupported" | "unknown"
  federation: "supported" | "unsupported" | "unknown"
  auditAttribution: "supported" | "unsupported" | "unknown"
}
```

An adapter should expose idempotent operations such as:

- inspect deployed product/version and capabilities;
- resolve or create an external principal;
- provision, update, rotate, block, and revoke a client credential;
- apply the supported subset of model and usage policy;
- reconcile desired state and report drift.

Unsupported controls must be reported as unsupported, not treated as enforced.
Vendor-specific request fields can live in adapter configuration without
leaking into the portable provider model.

## LiteLLM integration

LiteLLM is a strong first adapter because its control plane already models the
required hierarchy:

- organizations contain teams;
- teams contain users;
- virtual keys can belong to a user, a team, or both;
- `/key/generate` can mint keys with model restrictions, route restrictions,
  budgets, RPM/TPM limits, expiry, aliases, and metadata;
- key update, rotation, blocking, and deletion are available;
- usage can be attributed to key, user, team, and organization;
- SCIM can provision/deprovision users and teams;
- JWT-to-virtual-key mapping can avoid distributing long-lived user keys.

### Static virtual-key mode — recommended first integration

1. An admin adds the LiteLLM base URL and master/control-plane credential once.
2. OpenWork stores that credential as control-plane-only; it is never returned
   by a normal provider-connect API.
3. The admin maps OpenWork teams to existing LiteLLM teams and chooses model
   groups.
4. For each eligible member, the provisioner (recipe or packaged adapter)
   creates or resolves the LiteLLM user, then generates a user-plus-team
   virtual key with an explicit `user_id` and `team_id`.
5. OpenWork stores the returned key as that member's encrypted credential
   binding and records the external IDs.
6. Access or model changes update the external key. Offboarding blocks the key
   before local materialization is removed.
7. Rotation uses a credential version and overlap/grace period so desktops can
   sync the replacement before the prior key expires.

Use a stable opaque OpenWork subject ID in external metadata and a readable key
alias. Email may help discovery, but should not be the durable join key. Send
LiteLLM's change-attribution header on management operations where supported.

### Existing-key mode — portable fallback

If the customer already issues a key to every employee, the admin creates one
gateway profile and selects `per_member / member_supplied`. Each member provides
only their key; endpoint, models, and policy remain centrally managed. This is
far safer and simpler than asking each member to configure a complete provider.

### Federated JWT mode — best long-term security

LiteLLM Enterprise can validate OIDC JWTs and map a stable claim to a virtual
key. It can auto-register that mapping on first use, providing per-user model
access, budgets, limits, and spend attribution without distributing API keys.

This is the cleanest end state, but OpenWork first needs a deliberate token
story: either obtain a customer-IdP access token or issue a short-lived,
audience-bound identity token from a trusted OpenWork issuer. Reusing an
ordinary desktop or Cloud session token would be the wrong abstraction.

## Options

| Option | User experience | Central control | Secret exposure | Portability | Recommendation |
| --- | --- | --- | --- | --- | --- |
| Duplicate provider per user | Poor | Fragile | User key reaches desktop | Low | Reject |
| Customer-maintained API sync | Invisible after setup | Good | Depends on script | Low | Temporary bridge only |
| Member-supplied credential binding | One-time key entry | Shared profile and model policy | User key reaches desktop | High | Ship as baseline |
| LiteLLM-provisioned virtual key | Automatic | Strong | Scoped user key reaches desktop | Medium | Best near-term integration |
| Federated OIDC/JWT | Sign-in/refresh flow | Strong | No long-lived gateway key | Medium | Best long-term mode |
| OpenWork inference broker | Invisible | Strongest | Upstream secret stays server-side | High | Consider only when customers accept OpenWork in the inference data path |

## Why capability-based adapters matter

The products share concepts but not control-plane APIs:

- **LiteLLM** has virtual keys, users, teams, model allowlists, budgets, SCIM,
  JWT mapping, and detailed key lifecycle APIs.
- **Portkey** separates organization/admin keys from workspace user/service
  keys and supports workspace policies and JWT authentication.
- **Kong** composes Consumers, Consumer Groups, credentials, OIDC, and plugins;
  there is no single LLM virtual-key object to mirror.
- **Cloudflare AI Gateway** can use Cloudflare Access identity and split spend
  by a verified user ID, but its AI Gateway API tokens are account-scoped rather
  than gateway-scoped.
- A generic **OpenAI-compatible endpoint** may support only a URL, bearer key,
  inference routes, and perhaps `/v1/models`.

Therefore OpenWork should normalize principals, credential bindings,
entitlements, and lifecycle state—not vendor endpoint names or every budget
field.

## Delivery plan

### Phase 0 — correctness and secret boundaries

- Apply provider grants when materializing hosted workers.
- Associate auth directly with each runtime provider ID; remove env-name-based
  cross-provider collisions.
- Remove or redact secret-returning routes from MCP exposure.
- Add credential versions, audit events, and idempotency to lifecycle writes.

### Phase 1 — portable credential policies

- Add `shared`, `per_member`, and `per_team` credential policies.
- Add encrypted principal credential bindings.
- Add a member flow that accepts only the credential for an admin-defined
  profile.
- Allow access policies to expose different model subsets without cloning the
  whole provider.

### Phase 2 — LiteLLM reference recipe, then optional adapter

- Ship a maintained recipe (workflow/automation + docs) that provisions,
  rotates, and blocks LiteLLM virtual keys through the generic binding APIs.
- Emit membership lifecycle events (member added/removed, team changed) so the
  recipe can react without polling.
- Keep the LiteLLM master key in the customer's control plane or in a
  control-plane-only secret; never in a member-visible binding.
- Promote the recipe to a packaged adapter with drift/status UI only when
  several customers need the supported version.

### Phase 3 — federation or brokerage

- Add audience-bound short-lived identity tokens for gateways that support
  trusted JWT authentication; or
- generalize the existing OpenWork inference proxy pattern when server-side
  secret custody is required.

## Questions for the design partner

1. Are their existing LiteLLM credentials user-only keys or user-plus-team
   virtual keys?
2. Is the desired policy per person, team, model group, budget, or all four?
3. Is LiteLLM already synchronized from an IdP through SCIM?
4. Can their LiteLLM deployment use Enterprise JWT authentication?
5. Must credentials remain hidden from endpoint devices, or are scoped user
   keys acceptable locally?
6. Should OpenWork own key lifecycle, or only consume keys owned elsewhere?

## Primary sources researched with Exa

- [LiteLLM virtual keys](https://docs.litellm.ai/docs/proxy/virtual_keys)
- [LiteLLM identity provisioning](https://docs.litellm.ai/docs/proxy/identity_provisioning)
- [LiteLLM JWT-to-virtual-key mapping](https://docs.litellm.ai/docs/proxy/jwt_key_mapping)
- [LiteLLM SCIM](https://docs.litellm.ai/docs/tutorials/scim_litellm)
- [Portkey API key model](https://docs.portkey.ai/docs/product/enterprise-offering/org-management/api-keys-authn-and-authz)
- [Portkey JWT authentication](https://docs.portkey.ai/docs/product/enterprise-offering/org-management/jwt)
- [Kong Consumers](https://developer.konghq.com/gateway/entities/consumer/)
- [Kong OIDC with Consumers](https://developer.konghq.com/how-to/configure-oidc-with-consumers/)
- [Cloudflare AI Gateway authentication](https://developers.cloudflare.com/ai-gateway/configuration/authentication/)
- [Cloudflare Access for AI Gateway](https://developers.cloudflare.com/ai-gateway/configuration/cloudflare-access/)
- [Cloudflare AI Gateway spend limits](https://developers.cloudflare.com/ai-gateway/features/spend-limits/)
