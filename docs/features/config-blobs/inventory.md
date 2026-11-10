# Inventory: sidebar → blob keys → tables

Taken from `ee/apps/den-web/app/(den)/dashboard/_lib/dashboard-navigation.ts` (`buildDashboardNavSections`) and `ee/packages/den-db/src/schema/**`; updated to the as-built registry (2026-11-09).

## Key naming

The user's request: *main sidebar page = key, sub-page = sub-key*. Area paths are written with dots, e.g. `ai-gateway.providers`. In the file they nest: `areas["ai-gateway"]["providers"]`.

The sidebar isn't fully stable, so keys **follow the sidebar but live in their own registry**. Three examples:

- `authSecuritySettings` merges SSO and SCIM.
- `desktopPolicyScreenRemoved` moves desktop policies into team tabs.
- Roles moves between Settings and Members.

We pick the key once and never rename it. If the UI moves, the key stays and the registry records which screen it belongs to. Data shown on several screens (for example, team access to a provider) has **one** owning key; see "Where grants live" below.

## Areas (as built: all 25)

Source of truth: `ee/apps/den-api/src/config-blobs/registry.ts` (one adapter per key in `areas/*.ts`). Every area is on cloud and self-hosted unless noted. "Preflight" marks areas whose `preflight` skips or blocks writes that can't work before the apply (see change-requests.md › Preflight).

| Key | Label (dashboard) | Tables owned | Secrets (`$secret` fields) | Can't be undone by a restore (`irreversible`) | Notes |
|---|---|---|---|---|---|
| `members.teams` | Teams (Members › Teams) | `team` | – | deleting a team removes everything given to it (access, limits, prompts, default model, agent permissions, roles) | SCIM-managed teams can't be deleted |
| `members.roles` | Roles (Members › Roles) | `permission_set`, `permission_set_permission`, `permission_set_team`, `organization_role` | – | a deleted role is archived with its history; a restore creates a new role | built-in roles matched by key, never deleted |
| `members.people` | People (Members › People) | `member`, `team_member`, `invitation` | – | invitation emails (only when the request chose to send them); a removed member's sign-ins, own keys and API keys | imports invite, never add; preflight: allowed email domains (block), SCIM-provisioned people when the target has SCIM (skip), owner invited as admin (warning) |
| `connectors.oauth-clients` | OAuth apps | `org_oauth_client` | `clientSecret` | a client change revokes members' sign-ins to the provider | never deleted |
| `connectors.mcp` | MCP connections | `external_mcp_connection`, `external_mcp_connection_access_grant` | `apiKey`, `requestHeaders[].value`, `oauth.client.clientSecret` | sign-ins revoked on identity changes; personal keys of people losing access; on delete, shared key, headers and client secret | probes the server on write |
| `ai-gateway.providers` | AI Providers | `gateway_providers`, `gateway_provider_models`, `gateway_model_groups`, `gateway_model_group_models`, `gateway_credential_sets`, `gateway_provider_access` | `credentialSets[].credential`, `credentialSets[].oauthClientSecret` | replaced or deleted keys (revoked upstream), members' sign-ins through a changed set, LiteLLM-issued keys | groups and sets are compared by name (`comparableSpec`); preflight: a custom provider moving host with a kept key (block) |
| `ai-gateway.byok` | Bring your own keys | `llm_provider`, `llm_provider_model`, `llm_provider_access` | `credentials.apiKey`, `credentials.apiKeys.*` | replaced or deleted keys; members' own keys on delete or credential-mode change; inline credentials of a provider that moves | preflight: custom provider moving address with a kept key (block) |
| `desktop-policies` | Desktop policies | `desktop_policy`, `desktop_policy_member` | – | – | the default policy matched by natural key |
| `settings.general` | General | `organization` (allowlisted columns and metadata) | – | – | never the name or slug |
| `settings.web-origins` | Web origins | `organization_web_origin` | – | – | |
| `settings.advanced.collections` | Collections | `marketplace`, `marketplace_access_grant` | – | a deleted collection loses its plugins and access; a restore recreates it | |
| `members.agent-permissions` | Agent permissions (team Agents/Browser tabs) | `agent_permission_policy`, `agent_permission_setting` | – | – | |
| `members.default-models` | Default models (team Models tab) | `org_default_model` | – | – | provider by reference (BYOK or AI Gateway) |
| `members.prompts` | Prompts | `org_prompt`, `org_prompt_access` | – | – | confidential content (D1) |
| `ai-gateway.limits` | Limits | `gateway_usage_limit_policy`, `gateway_usage_limit_entry`, `gateway_usage_limit_assignment` | – | pending increase requests closed when effective limits change | |
| `ai-gateway.smart-routers` | Smart routers | `auto_router`, `auto_router_access`, `auto_router_model`, `auto_router_task`, `auto_router_model_task` | – | a deleted router's model id is gone; re-created routers get a new one | cloud only, `autoRouter` |
| `ai-gateway.openwork-models` | OpenWork Models | – (organization metadata) | – | turning Auto off revokes members' OpenWork Models keys | cloud only; never the subscription, tier or upstream keys |
| `plugins.plugins` | Plugins | `plugin`, `plugin_config_object`, `plugin_access_grant`, `plugin_mcp_requirement_binding`, `marketplace_plugin` | – | moving an MCP requirement to another connection doesn't carry sign-ins | archived, never deleted; source-filled plugins refused |
| `plugins.skills` | Skills, agents and commands | `config_object`, `config_object_version`, `config_object_access_grant`, `remote_mcp_app` | – | each content change saves a new version | org-shared objects only, never personal ones, authored MCP Apps or the Workbot "Your agent" template (owned by `workbot.proactive`); preflight: source-managed creates and the template (skip), source-managed content changes (block) |
| `plugins.sources` | Sources | `connector_instance`, `connector_target`, `connector_mapping`, `connector_instance_access_grant`, `connector_account` | – | a sync is queued; deleting a source deletes everything imported from it | the GitHub installation is never created; preflight: no matching installation here (block) |
| `workbot.settings` | Workbot | – (organization metadata) | – | – | never the Slack installation |
| `workbot.proactive` | Members' agents | – (organization metadata, "Your agent" template versions) | – | turning agents on starts reading members' sources; sent messages can't be unsent | `workbotProactive` |
| `settings.auth-security` | Auth & Security | `sso_connection`, `sso_provider`, `scim_provider` | `oidc.clientSecret` | sign-ins ended by stricter session limits or Require SSO; SSO identities on delete; a reconfigured connection is disabled until tested | new connections start disabled and unverified; never SCIM tokens; preflight: Require SSO / Restrict domain without a ready connection or under `ssoPerOrganization` (block), OIDC secret unset (block) |
| `settings.advanced.brand` | Brand appearance | `organization_brand_asset` | – | – | uploaded images travel as base64 `data` (2 MB each) |
| `settings.audit` | Audit logs (settings) | `audit_policy` | – | – | only `captureOn` |

Run `pnpm --filter @openwork-ee/den-api config-blobs:coverage` for the live numbers: 146 org-scoped tables, 58 owned by an area, 95 excluded (`excluded.ts`).

### Excluded tables (`excluded.ts`), by reason

| Reason | Count | What |
|---|---|---|
| `runtime` | 65 | usage, logs, rollups, buckets and events (gateway, inference, telemetry, audit), sync state of sources, SCIM groups and events (pushed by the IdP), member agent checks and deliveries, sessions, workers, workflow runs |
| `secret` | 6 | tables holding only credentials: `gateway_provider_credentials` (carried as `$secret` placeholders of `ai-gateway.providers`), LiteLLM issued keys, OpenWork Models upstream keys, analytics settings, the Slack installation, diagnostic credentials |
| `personal` | 10 | one member's: their Gateway and inference keys, BYOK member credentials, connected accounts, their agent, automations, artifacts, dashboard apps, intro state |
| `billing` | 4 | subscriptions, purchases, grants, benefit settings |
| `platform` | 6 | feature flags and changes, sandbox organizations, managed deployments, account follow-ups |
| `config_blobs_internal` | 4 | `config_change_request`, `config_apply_run`, `config_blob_alias`, `config_blob_export` |

Also never exported: the organization's name and slug (target identity; `source` info only), API keys (secrets; recreate them), billing.

## People (`members.people`)

Decision D2: blobs carry people. Each item is one person, identified by **email** (the user ID is per instance and only used as a tier-1 hint on the same instance):

```jsonc
{ "id": "om_01h…", "key": "ada@example.com", "name": "Ada Example",
  "spec": { "email": "ada@example.com", "role": "admin", "status": "active",   // active | invited
            "teams": [ { "$ref": "members.teams/tem_01h…", "name": "Platform" } ],
            "managedBy": "scim" } }                                                  // scim | sso | manual
```

On import:

| Target state | Result |
|---|---|
| email is a member of the target org | `update` (role, team membership) |
| email has a user on the instance but isn't a member | `create` as an **invitation** too (an import never adds someone without their accept) |
| no user with that email | `create` as an **invitation**. A per-request choice: send invite emails now, or create pending invitations silently (recommended for cloud → self-hosted migrations, so nobody gets mail before the instance is ready) |
| member on target, absent from blob | `untouched` in merge; `delete` (remove from org) only in mirror, with explicit confirmation, and **never the person applying** |

Guards:
- Can't demote or remove the last owner, or the applier themself.
- SCIM-managed people are skipped at plan time when the target has SCIM on (the IdP provisions them); SCIM-managed teams can't be deleted.
- Allowed email domains on the target are checked at plan time: people outside them are `blocked` (allow the domain, or skip them).
- An owner on the source is invited as an admin (ownership is only moved by transferring it).
- Invite tokens, sessions, accounts and passwords are never exported.

Other areas reference people as `{ "$ref": "people/ada@example.com" }`. When `members.people` is in the same blob, those resolve to planned creates.

## Where grants live

Access grants (`*_access_grant`, `llm_provider_access`, `gateway_provider_access`, `desktop_policy_member`, `permission_set_team`, …) are exported **with the resource**, as a list of references, the way the declarative API does it:

```json
"access": { "orgWide": false, "teams": [{ "$ref": "members.teams/tem_01h…", "name": "Platform" }], "members": [{ "$ref": "people/ada@example.com" }] }
```

So `ai-gateway.providers` can be imported alone. Its team references are resolved against the target's teams (see [mapping.md](./mapping.md#references)).

## Secrets: the full list we must handle

Every `encryptedColumn` in `ee/packages/den-db/src/columns.ts` (AES-256-GCM, one key per deployment from `DEN_DB_ENCRYPTION_KEY`) falls into one of two groups:

**Secrets** (never exported; become `$secret` placeholders):

| Table | Columns |
|---|---|
| `org_oauth_client` | `client_secret` |
| `external_mcp_connection` | `api_key`, `request_headers`, `access_token`, `refresh_token` |
| `llm_provider` | `api_key` |
| `gateway_providers` | `oauth_client_secret` |
| `gateway_credential_sets` | `oauth_client_secret` |
| `gateway_provider_credentials` | `secret` |
| `inference_org_upstream_provider_keys` | `encrypted_api_key` |
| `sso_provider` | `oidc_config`, `saml_config` |
| `scim_provider` | `scim_token` |
| `models_analytics_settings` | `langfuse_*` |
| `slack_assistant_installation` | `signing_secret`, `bot_token` |
| `organization_diagnostic_credential` | `bearer_token` |
| per-member credentials and tokens | `connected_account`, `llm_provider_member_credential`, `gateway_keys`, `inference_keys` |

**Encrypted content that isn't a secret**: skill and plugin payloads (`config_object_version`), prompts (`org_prompt.content`), automation instructions, artifact view sources. These are encrypted at rest because they're confidential, not because they are credentials. **Decision D1: this content is exported.** The export screen warns per area that the file contains confidential content. Only the *secrets* list above is never exported.

**Secret-like data inside plain JSON columns** (needs a field-level allowlist, not a column list): `org_oauth_client.extra`, `gateway_providers.settings` / `provider_config`, `llm_provider.provider_config`, `external_mcp_connection.oauth_configuration`. Adapters export through an **allowlist serializer** (the same idea as `audit/domain/snapshot.ts`), never by dumping rows.
