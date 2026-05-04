# MCPs Data Structure

## Source formats to support

Source docs:

- `https://opencode.ai/docs/mcp-servers/`

Actual allowed keys verified from the OpenCode SDK/config schema:

- local MCP
  - `type: "local"`
  - `command: string[]`
  - `environment?: Record<string, string>`
  - `enabled?: boolean`
  - `timeout?: number`
- remote MCP
  - `type: "remote"`
  - `url: string`
  - `enabled?: boolean`
  - `headers?: Record<string, string>`
  - `oauth?: McpOAuthConfig | false`
  - `timeout?: number`
- OAuth config
  - `clientId?: string`
  - `clientSecret?: string`
  - `scope?: string`

Important schema behavior:

- the OpenCode MCP config is strict and discriminated by `type`
- unlike agents, MCP objects do not accept arbitrary extra keys in the core schema

## Canonical storage recommendation

### Shared tables

- `config_object`
- `config_object_version`

### Current projection table

Add:

- `config_object_mcp_current`

Suggested columns:

- `config_object_id`
- `mcp_name`
- `connection_type` (`local`, `remote`)
- `enabled` nullable
- `timeout_ms` nullable
- `command_json` nullable
- `environment_json` nullable
- `url` nullable
- `headers_json` nullable
- `oauth_mode` nullable (`auto`, `configured`, `disabled`)
- `oauth_client_id` nullable
- `oauth_scope` nullable
- `has_oauth_client_secret` boolean nullable

### OpenWork-specific local install fields

For local MCPs, we likely want extra product fields that are not part of the upstream OpenCode schema but help with distribution and setup.

Suggested additional columns:

- `requires_install` boolean nullable
- `install_command_script` nullable
- `install_docs_link` nullable
- `install_notes` nullable

Optional future additions:

- `install_check_command` nullable
- `platforms_json` nullable
- `package_manager` nullable

## Raw version storage

Each version should preserve:

- raw JSON or markdown-derived config source
- normalized MCP config JSON
- parser version

## Secret-handling note

MCPs are the most likely type to contain secrets or sensitive values.

Recommendations:

- treat `headers` and `environment` as potentially secret-bearing;
- like all config-object key payload columns, MCP core config data should be encrypted at rest;
- avoid copying secret material into searchable top-level text fields;
- if we later support secure secret storage, keep secret references separate from public metadata.

This is especially important for:

- remote MCP headers
- local MCP environment values
- OAuth client secrets

## Search and title strategy

Friendly title strategy:

- use the MCP object name from the config key

Description strategy:

- MCP objects do not have a native `description` field in the upstream schema;
- for dashboard UX, we should probably allow a local friendly description on `config_object.description` even though it is not part of the OpenCode MCP payload.

This means MCPs are a strong example of:

- raw source-of-truth in version history
- plus locally-managed friendly metadata on the parent object

## Why an MCP-specific table helps

MCPs have discriminated connection shapes and operational concerns that we will want to filter by:

- local vs remote
- enabled/disabled
- install required
- OAuth mode
- timeout

These are current operational fields and should not require parsing historical versions for every UI query.

## Table recommendation summary

- shared backbone: `config_object`, `config_object_version`
- type projection: `config_object_mcp_current`

## Open questions specific to MCPs

- Should local install scripts be executable content we store directly, or pointers to bundled files/docs?
- Should secret-bearing headers and environment values be split into secure secret references from day one?
- Do we want friendly dashboard metadata for MCPs to be always locally editable even when the core MCP payload is connector-managed?
