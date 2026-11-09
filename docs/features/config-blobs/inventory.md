# Inventory: sidebar → blob keys → tables

Taken from `ee/apps/den-web/app/(den)/dashboard/_lib/dashboard-navigation.ts` (`buildDashboardNavSections`) and `ee/packages/den-db/src/schema/**` at `b95f7d89e8`.

## Key naming

The user's request: *main sidebar page = key, sub-page = sub-key*. Area paths are written with dots, e.g. `ai-gateway.providers`. In the file they nest: `areas["ai-gateway"]["providers"]`.

The sidebar isn't fully stable, so keys **follow the sidebar but live in their own registry**. Three examples:

- `authSecuritySettings` merges SSO and SCIM.
- `desktopPolicyScreenRemoved` moves desktop policies into team tabs.
- Roles moves between Settings and Members.

We pick the key once and never rename it. If the UI moves, the key stays and the registry records which screen it belongs to. Data shown on several screens (for example, team access to a provider) has **one** owning key; see "Where grants live" below.

## Areas

Legend:
- ✅ in v1
- 🔜 later phase
- ⛔ never exported (runtime data, billing, secrets or operator-owned)

### `members` (Team › Members)

| Key | What | Tables | Natural key | Secrets | Phase |
|---|---|---|---|---|---|
| `members.teams` | teams | `team` | `externalKey`, `name` (unique per org) | – | ✅ |
| `members.roles` | permission sets (roles) and team assignments | `permission_set`, `permission_set_permission` (current state only), `permission_set_team`, `organization_role` | `default_key` for built-in roles; name | – | ✅ |
| `members.agent-permissions` | the Agents and Browser tabs on teams and Everyone | `agent_permission_policy`, `agent_permission_setting` | `scope_key` (`everyone` / team), `permission_key` | – | 🔜 |
| `members.prompts` | Prompts tab | `org_prompt`, `org_prompt_access` | none (title) | `content` is encrypted **content**: exported (decision D1) | 🔜 |
| `members.default-models` | Models tab: default model per scope | `org_default_model` | `scope_key` | – (`provider_id` is free text and must be remapped) | 🔜 |
| `members.people` | members, their role, team membership, pending invitations | `member`, `team_member`, `invitation` (not the token) | user email | – | ✅ (decision D2, see "People" below) |

### `ai-gateway` (Manage › AI Gateway)

| Key | What | Tables | Natural key | Secrets | Phase |
|---|---|---|---|---|---|
| `ai-gateway.providers` | inference providers, models, model groups, credential sets, access | `gateway_providers`, `gateway_provider_models`, `gateway_model_groups`, `gateway_model_group_models`, `gateway_credential_sets`, `gateway_provider_access` | `provider_id` + upstream base URL (not unique: needs the confirm step) | `oauth_client_secret` (provider and credential set), `gateway_provider_credentials.secret` | ✅ |
| `ai-gateway.byok` | legacy custom LLM providers | `llm_provider`, `llm_provider_model`, `llm_provider_access` | `externalKey` | `api_key` | ✅ (it already has keyed writes) |
| `ai-gateway.smart-routers` | auto routers (flag `autoRouter`, cloud only) | `auto_router*` except `auto_router_reasoning` | task `name_key`; router name | – | 🔜 |
| `ai-gateway.limits` | usage limit policies, entries, assignments | `gateway_usage_limit_policy`, `_entry`, `_assignment` | name | – | 🔜 |
| `ai-gateway.openwork-models` | OpenWork Models settings and org limits | `inference_org_limit_policies` | (window, type) | `inference_org_upstream_provider_keys` | 🔜 (cloud only; dropped on self-hosted) |
| usage and overview | – | `gateway_usage_*`, request logs, rollups | – | – | ⛔ runtime |

### `connectors` (Manage › Connectors)

| Key | What | Tables | Natural key | Secrets | Phase |
|---|---|---|---|---|---|
| `connectors.mcp` | MCP connections and access | `external_mcp_connection`, `external_mcp_connection_access_grant` | `externalKey`, URL | `api_key`, `request_headers`, `access_token`, `refresh_token` | ✅ |
| `connectors.oauth-clients` | org OAuth clients | `org_oauth_client` | `provider_id` (unique per org) | `client_secret`, `extra.registration_access_token` | ✅ |
| per-member sign-ins | – | `connected_account` | – | tokens | ⛔ personal, can't be moved |

### `plugins` (Manage › Plugins)

| Key | What | Tables | Natural key | Secrets | Phase |
|---|---|---|---|---|---|
| `plugins.plugins` | plugins and their contents | `plugin`, `plugin_config_object`, `plugin_access_grant`, `plugin_mcp_requirement_binding` | name (**not unique**) | – | 🔜 |
| `plugins.skills` (and agents, commands, hooks…) | config objects, latest version only | `config_object`, `config_object_version`, `config_object_access_grant`, `remote_mcp_app` | title (**not unique**) | payloads are encrypted **content**: exported (D1) | 🔜 |
| `plugins.sources` | GitHub sources | `connector_instance`, `connector_target`, `connector_mapping` | instance name (unique) | GitHub App install belongs to the instance | 🔜, probably config only, re-linked on target |

Plugins and skills are where same-name collisions really happen: titles and names aren't unique. The agent-plugin v1 format in `plugin-system/agent-plugin-v1.ts` may be a better inner format for this area than raw rows.

### `desktop-policies` (Manage › Desktop policies, or the team Desktop tab)

| Key | Tables | Natural key | Phase |
|---|---|---|---|
| `desktop-policies` | `desktop_policy`, `desktop_policy_member` (team / role assignments only) | `externalKey`, `is_default` | ✅ |

### `workbot` (Manage › Workbot)

| Key | Tables | Phase |
|---|---|---|
| `workbot.settings` | `organization.metadata` (default model, name) | 🔜 |
| `workbot.proactive` | org-level proactive settings | 🔜 (flag `workbotProactive`) |
| Slack install | `slack_assistant_installation` | ⛔ in v1: secrets plus a workspace binding to the instance |

### `settings` (Team › Settings)

| Key | What | Tables / fields | Secrets | Phase |
|---|---|---|---|---|
| `settings.general` | allowed email domains, allowed desktop versions, automation settings, `desktopAppRestrictions` | `organization` columns + `metadata` | – | ✅ (**not** name or slug: identity of the target org) |
| `settings.web-origins` | web origins | `organization_web_origin` | – | ✅ |
| `settings.auth-security` | session settings, SSO connections, SCIM group mappings | `organization.metadata`, `sso_connection`, `sso_provider`, `scim_group_role` | `oidc_config`, `saml_config` (whole encrypted JSON), `scim_token` | 🔜. SSO on another instance needs new redirect URIs; probably export the shape and require re-entry |
| `settings.advanced.collections` | marketplaces | `marketplace`, `marketplace_plugin`, `marketplace_access_grant` | – | ✅ (metadata), plugin links with `plugins` |
| `settings.advanced.brand` | app name, logo, icon | `organization.metadata`, `organization_brand_asset` (bytes) | – | 🔜 (assets as base64 or a separate file in a zip) |
| `settings.audit` | audit capture settings | `audit_policy` | – | 🔜 |
| `settings.api-keys` | – | `apikey` | – | ⛔ (keys are secrets; recreate) |
| `settings.billing` | – | `org_subscriptions` | – | ⛔ commercial |
| `settings.diagnostics` | – | `organization_diagnostic_credential` | – | ⛔ |

### Never exported

| Item | Reason |
|---|---|
| Observability: analytics, audit log entries, telemetry | runtime |
| Deployments (`managed_deployment*`) | operator state |
| Billing, OpenWork Web, grants, benefits | commercial, platform-owned |
| `organization_feature` | platform admins own flag state, not tenants |
| Personal: My Library, My Automations, My bot, Your connections | per member. Could be a later "personal blob" |
| All `*_run`, `*_event`, queue, lease, OAuth state and token tables | runtime |

## People (`members.people`)

Decision D2: blobs carry people. Each item is one person, identified by **email** (the user ID is per instance and only used as a tier-1 hint on the same instance):

```jsonc
{ "id": "om_01h…", "key": "ada@example.com", "name": "Ada Lovelace",
  "spec": { "email": "ada@example.com", "role": "admin", "status": "active",   // active | invited
            "teams": [ { "$ref": "members.teams/tem_01h…", "name": "Platform" } ],
            "permissionSets": [ { "$ref": "members.roles/pms_01h…" } ],
            "managedBy": "scim" } }                                                  // scim | sso | manual
```

On import:

| Target state | Result |
|---|---|
| email is a member of the target org | `update` (role, team membership) |
| email has a user on the instance but isn't a member | `create`: add as member |
| no user with that email | `create` as an **invitation**. A per-request choice: send invite emails now, or create pending invitations silently (recommended for cloud → self-hosted migrations, so nobody gets mail before the instance is ready) |
| member on target, absent from blob | `untouched` in merge; `delete` (remove from org) only in mirror, with explicit confirmation, and **never the person applying** |

Guards:
- Can't demote or remove the last owner, or the applier themself.
- SCIM-managed people and SCIM-managed teams are skipped with a reason when the target has SCIM on (the IdP owns them).
- Allowed email domains on the target are enforced; people outside them are `blocked`.
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
