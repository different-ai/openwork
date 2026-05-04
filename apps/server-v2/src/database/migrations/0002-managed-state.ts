export const phase2ManagedStateMigration = {
  name: "managed-state",
  sql: `
    CREATE TABLE IF NOT EXISTS mcps (
      id TEXT PRIMARY KEY,
      item_kind TEXT NOT NULL,
      display_name TEXT NOT NULL,
      item_key TEXT,
      config_json TEXT NOT NULL DEFAULT '{}',
      auth_json TEXT,
      metadata_json TEXT,
      source TEXT NOT NULL CHECK (source IN ('openwork_managed', 'imported', 'discovered', 'cloud_synced')),
      cloud_item_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS skills (
      id TEXT PRIMARY KEY,
      item_kind TEXT NOT NULL DEFAULT 'skill',
      display_name TEXT NOT NULL,
      item_key TEXT,
      config_json TEXT NOT NULL DEFAULT '{}',
      auth_json TEXT,
      metadata_json TEXT,
      source TEXT NOT NULL CHECK (source IN ('openwork_managed', 'imported', 'discovered', 'cloud_synced')),
      cloud_item_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS plugins (
      id TEXT PRIMARY KEY,
      item_kind TEXT NOT NULL DEFAULT 'plugin',
      display_name TEXT NOT NULL,
      item_key TEXT,
      config_json TEXT NOT NULL DEFAULT '{}',
      auth_json TEXT,
      metadata_json TEXT,
      source TEXT NOT NULL CHECK (source IN ('openwork_managed', 'imported', 'discovered', 'cloud_synced')),
      cloud_item_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS provider_configs (
      id TEXT PRIMARY KEY,
      item_kind TEXT NOT NULL DEFAULT 'provider',
      display_name TEXT NOT NULL,
      item_key TEXT,
      config_json TEXT NOT NULL DEFAULT '{}',
      auth_json TEXT,
      metadata_json TEXT,
      source TEXT NOT NULL CHECK (source IN ('openwork_managed', 'imported', 'discovered', 'cloud_synced')),
      cloud_item_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workspace_mcps (
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      item_id TEXT NOT NULL REFERENCES mcps(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (workspace_id, item_id)
    );

    CREATE TABLE IF NOT EXISTS workspace_skills (
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      item_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (workspace_id, item_id)
    );

    CREATE TABLE IF NOT EXISTS workspace_plugins (
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      item_id TEXT NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (workspace_id, item_id)
    );

    CREATE TABLE IF NOT EXISTS workspace_provider_configs (
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      item_id TEXT NOT NULL REFERENCES provider_configs(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (workspace_id, item_id)
    );

    CREATE TABLE IF NOT EXISTS cloud_signin (
      id TEXT PRIMARY KEY,
      server_id TEXT NOT NULL UNIQUE REFERENCES servers(id) ON DELETE CASCADE,
      cloud_base_url TEXT NOT NULL,
      user_id TEXT,
      org_id TEXT,
      auth_json TEXT,
      metadata_json TEXT,
      last_validated_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workspace_shares (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      access_key TEXT,
      status TEXT NOT NULL CHECK (status IN ('active', 'revoked', 'disabled')),
      last_used_at TEXT,
      audit_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      revoked_at TEXT
    );

    CREATE TABLE IF NOT EXISTS router_identities (
      id TEXT PRIMARY KEY,
      server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      display_name TEXT NOT NULL,
      config_json TEXT NOT NULL DEFAULT '{}',
      auth_json TEXT,
      is_enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS router_bindings (
      id TEXT PRIMARY KEY,
      server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
      router_identity_id TEXT NOT NULL REFERENCES router_identities(id) ON DELETE CASCADE,
      binding_key TEXT NOT NULL,
      config_json TEXT NOT NULL DEFAULT '{}',
      is_enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_workspace_shares_workspace ON workspace_shares (workspace_id);
    CREATE INDEX IF NOT EXISTS idx_router_identities_server ON router_identities (server_id);
    CREATE INDEX IF NOT EXISTS idx_router_bindings_server ON router_bindings (server_id);
  `,
  version: "0002",
} as const;
