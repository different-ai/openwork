export const phase7FilesConfigMigration = {
  name: "files-config",
  sql: `
    CREATE TABLE IF NOT EXISTS server_config_state (
      server_id TEXT PRIMARY KEY REFERENCES servers(id) ON DELETE CASCADE,
      opencode_json TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workspace_config_state (
      workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
      openwork_json TEXT NOT NULL DEFAULT '{}',
      opencode_json TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL
    );
  `,
  version: "0003",
} as const;
