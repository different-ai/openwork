export const phase2RegistryRuntimeMigration = {
  name: "registry-runtime",
  sql: `
    CREATE TABLE IF NOT EXISTS servers (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('local', 'remote')),
      hosting_kind TEXT NOT NULL CHECK (hosting_kind IN ('desktop', 'self_hosted', 'cloud')),
      label TEXT NOT NULL,
      base_url TEXT,
      auth_json TEXT,
      capabilities_json TEXT NOT NULL DEFAULT '{}',
      is_local INTEGER NOT NULL DEFAULT 0,
      is_enabled INTEGER NOT NULL DEFAULT 1,
      source TEXT NOT NULL DEFAULT 'seeded',
      notes_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_seen_at TEXT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_servers_single_local ON servers (is_local) WHERE is_local = 1;

    CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY,
      server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('local', 'remote', 'control', 'help')),
      display_name TEXT NOT NULL,
      slug TEXT NOT NULL,
      is_hidden INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL CHECK (status IN ('ready', 'imported', 'attention')),
      opencode_project_id TEXT,
      remote_workspace_id TEXT,
      data_dir TEXT,
      config_dir TEXT,
      notes_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_workspaces_slug ON workspaces (slug);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_workspaces_local_data_dir ON workspaces (data_dir) WHERE data_dir IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_workspaces_server ON workspaces (server_id);

    CREATE TABLE IF NOT EXISTS server_runtime_state (
      server_id TEXT PRIMARY KEY REFERENCES servers(id) ON DELETE CASCADE,
      runtime_version TEXT,
      opencode_status TEXT NOT NULL DEFAULT 'unknown',
      opencode_version TEXT,
      opencode_base_url TEXT,
      router_status TEXT NOT NULL DEFAULT 'disabled',
      router_version TEXT,
      restart_policy_json TEXT,
      last_started_at TEXT,
      last_exit_json TEXT,
      health_json TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workspace_runtime_state (
      workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
      backend_kind TEXT NOT NULL CHECK (backend_kind IN ('local_opencode', 'remote_openwork')),
      last_sync_at TEXT,
      last_session_refresh_at TEXT,
      last_error_json TEXT,
      health_json TEXT,
      updated_at TEXT NOT NULL
    );
  `,
  version: "0001",
} as const;
