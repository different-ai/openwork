import type { Database } from "bun:sqlite";
import { parseJsonValue, stringifyJsonValue } from "./json.js";
import type {
  CloudSigninRecord,
  ManagedConfigRecord,
  RouterBindingRecord,
  RouterIdentityRecord,
  ServerConfigStateRecord,
  ServerRecord,
  ServerRuntimeStateRecord,
  WorkspaceAssignmentRecord,
  WorkspaceConfigStateRecord,
  WorkspaceRecord,
  WorkspaceRuntimeStateRecord,
  WorkspaceShareRecord,
} from "./types.js";

function toBoolean(value: number | boolean | null | undefined) {
  return Boolean(value);
}

function toSqlBoolean(value: boolean) {
  return value ? 1 : 0;
}

function nowIso() {
  return new Date().toISOString();
}

type RawServerRow = {
  auth_json: string | null;
  base_url: string | null;
  capabilities_json: string;
  created_at: string;
  hosting_kind: ServerRecord["hostingKind"];
  id: string;
  is_enabled: number;
  is_local: number;
  kind: ServerRecord["kind"];
  label: string;
  last_seen_at: string | null;
  notes_json: string | null;
  source: string;
  updated_at: string;
};

type RawWorkspaceRow = {
  config_dir: string | null;
  created_at: string;
  data_dir: string | null;
  display_name: string;
  id: string;
  is_hidden: number;
  kind: WorkspaceRecord["kind"];
  notes_json: string | null;
  opencode_project_id: string | null;
  remote_workspace_id: string | null;
  server_id: string;
  slug: string;
  status: WorkspaceRecord["status"];
  updated_at: string;
};

type RawServerRuntimeStateRow = {
  health_json: string | null;
  last_exit_json: string | null;
  last_started_at: string | null;
  opencode_base_url: string | null;
  opencode_status: string;
  opencode_version: string | null;
  restart_policy_json: string | null;
  router_status: string;
  router_version: string | null;
  runtime_version: string | null;
  server_id: string;
  updated_at: string;
};

type RawWorkspaceRuntimeStateRow = {
  backend_kind: WorkspaceRuntimeStateRecord["backendKind"];
  health_json: string | null;
  last_error_json: string | null;
  last_session_refresh_at: string | null;
  last_sync_at: string | null;
  updated_at: string;
  workspace_id: string;
};

type RawServerConfigStateRow = {
  opencode_json: string;
  server_id: string;
  updated_at: string;
};

type RawWorkspaceConfigStateRow = {
  openwork_json: string;
  opencode_json: string;
  updated_at: string;
  workspace_id: string;
};

type RawManagedConfigRow = {
  auth_json: string | null;
  cloud_item_id: string | null;
  config_json: string;
  created_at: string;
  display_name: string;
  id: string;
  item_key: string | null;
  metadata_json: string | null;
  source: ManagedConfigRecord["source"];
  updated_at: string;
};

type RawCloudSigninRow = {
  auth_json: string | null;
  cloud_base_url: string;
  created_at: string;
  id: string;
  last_validated_at: string | null;
  metadata_json: string | null;
  org_id: string | null;
  server_id: string;
  updated_at: string;
  user_id: string | null;
};

type RawWorkspaceShareRow = {
  access_key: string | null;
  audit_json: string | null;
  created_at: string;
  id: string;
  last_used_at: string | null;
  revoked_at: string | null;
  status: WorkspaceShareRecord["status"];
  updated_at: string;
  workspace_id: string;
};

type RawRouterIdentityRow = {
  auth_json: string | null;
  config_json: string;
  created_at: string;
  display_name: string;
  id: string;
  is_enabled: number;
  kind: string;
  server_id: string;
  updated_at: string;
};

type RawRouterBindingRow = {
  binding_key: string;
  config_json: string;
  created_at: string;
  id: string;
  is_enabled: number;
  router_identity_id: string;
  server_id: string;
  updated_at: string;
};

function mapServer(row: RawServerRow | null | undefined): ServerRecord | null {
  if (!row) {
    return null;
  }

  return {
    auth: parseJsonValue(row.auth_json, null),
    baseUrl: row.base_url,
    capabilities: parseJsonValue(row.capabilities_json, {}),
    createdAt: row.created_at,
    hostingKind: row.hosting_kind,
    id: row.id,
    isEnabled: toBoolean(row.is_enabled),
    isLocal: toBoolean(row.is_local),
    kind: row.kind,
    label: row.label,
    lastSeenAt: row.last_seen_at,
    notes: parseJsonValue(row.notes_json, null),
    source: row.source,
    updatedAt: row.updated_at,
  };
}

function mapWorkspace(row: RawWorkspaceRow | null | undefined): WorkspaceRecord | null {
  if (!row) {
    return null;
  }

  return {
    configDir: row.config_dir,
    createdAt: row.created_at,
    dataDir: row.data_dir,
    displayName: row.display_name,
    id: row.id,
    isHidden: toBoolean(row.is_hidden),
    kind: row.kind,
    notes: parseJsonValue(row.notes_json, null),
    opencodeProjectId: row.opencode_project_id,
    remoteWorkspaceId: row.remote_workspace_id,
    serverId: row.server_id,
    slug: row.slug,
    status: row.status,
    updatedAt: row.updated_at,
  };
}

function mapServerRuntimeState(row: RawServerRuntimeStateRow | null | undefined): ServerRuntimeStateRecord | null {
  if (!row) {
    return null;
  }

  return {
    health: parseJsonValue(row.health_json, null),
    lastExit: parseJsonValue(row.last_exit_json, null),
    lastStartedAt: row.last_started_at,
    opencodeBaseUrl: row.opencode_base_url,
    opencodeStatus: row.opencode_status,
    opencodeVersion: row.opencode_version,
    restartPolicy: parseJsonValue(row.restart_policy_json, null),
    routerStatus: row.router_status,
    routerVersion: row.router_version,
    runtimeVersion: row.runtime_version,
    serverId: row.server_id,
    updatedAt: row.updated_at,
  };
}

function mapWorkspaceRuntimeState(row: RawWorkspaceRuntimeStateRow | null | undefined): WorkspaceRuntimeStateRecord | null {
  if (!row) {
    return null;
  }

  return {
    backendKind: row.backend_kind,
    health: parseJsonValue(row.health_json, null),
    lastError: parseJsonValue(row.last_error_json, null),
    lastSessionRefreshAt: row.last_session_refresh_at,
    lastSyncAt: row.last_sync_at,
    updatedAt: row.updated_at,
    workspaceId: row.workspace_id,
  };
}

function mapServerConfigState(row: RawServerConfigStateRow | null | undefined): ServerConfigStateRecord | null {
  if (!row) {
    return null;
  }

  return {
    opencode: parseJsonValue(row.opencode_json, {}),
    serverId: row.server_id,
    updatedAt: row.updated_at,
  };
}

function mapWorkspaceConfigState(row: RawWorkspaceConfigStateRow | null | undefined): WorkspaceConfigStateRecord | null {
  if (!row) {
    return null;
  }

  return {
    openwork: parseJsonValue(row.openwork_json, {}),
    opencode: parseJsonValue(row.opencode_json, {}),
    updatedAt: row.updated_at,
    workspaceId: row.workspace_id,
  };
}

function mapManagedConfig(row: RawManagedConfigRow | null | undefined): ManagedConfigRecord | null {
  if (!row) {
    return null;
  }

  return {
    auth: parseJsonValue(row.auth_json, null),
    cloudItemId: row.cloud_item_id,
    config: parseJsonValue(row.config_json, {}),
    createdAt: row.created_at,
    displayName: row.display_name,
    id: row.id,
    key: row.item_key,
    metadata: parseJsonValue(row.metadata_json, null),
    source: row.source,
    updatedAt: row.updated_at,
  };
}

function mapCloudSignin(row: RawCloudSigninRow | null | undefined): CloudSigninRecord | null {
  if (!row) {
    return null;
  }

  return {
    auth: parseJsonValue(row.auth_json, null),
    cloudBaseUrl: row.cloud_base_url,
    createdAt: row.created_at,
    id: row.id,
    lastValidatedAt: row.last_validated_at,
    metadata: parseJsonValue(row.metadata_json, null),
    orgId: row.org_id,
    serverId: row.server_id,
    updatedAt: row.updated_at,
    userId: row.user_id,
  };
}

function mapWorkspaceShare(row: RawWorkspaceShareRow | null | undefined): WorkspaceShareRecord | null {
  if (!row) {
    return null;
  }

  return {
    accessKey: row.access_key,
    audit: parseJsonValue(row.audit_json, null),
    createdAt: row.created_at,
    id: row.id,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
    status: row.status,
    updatedAt: row.updated_at,
    workspaceId: row.workspace_id,
  };
}

function mapRouterIdentity(row: RawRouterIdentityRow | null | undefined): RouterIdentityRecord | null {
  if (!row) {
    return null;
  }

  return {
    auth: parseJsonValue(row.auth_json, null),
    config: parseJsonValue(row.config_json, {}),
    createdAt: row.created_at,
    displayName: row.display_name,
    id: row.id,
    isEnabled: toBoolean(row.is_enabled),
    kind: row.kind,
    serverId: row.server_id,
    updatedAt: row.updated_at,
  };
}

function mapRouterBinding(row: RawRouterBindingRow | null | undefined): RouterBindingRecord | null {
  if (!row) {
    return null;
  }

  return {
    bindingKey: row.binding_key,
    config: parseJsonValue(row.config_json, {}),
    createdAt: row.created_at,
    id: row.id,
    isEnabled: toBoolean(row.is_enabled),
    routerIdentityId: row.router_identity_id,
    serverId: row.server_id,
    updatedAt: row.updated_at,
  };
}

export class ServersRepository {
  constructor(private readonly database: Database) {}

  getById(id: string) {
    return mapServer(this.database.query("SELECT * FROM servers WHERE id = ?1").get(id) as RawServerRow | null);
  }

  list() {
    return (this.database.query("SELECT * FROM servers ORDER BY is_local DESC, updated_at DESC").all() as RawServerRow[]).map(mapServer).filter(Boolean) as ServerRecord[];
  }

  count() {
    const row = this.database.query("SELECT COUNT(1) AS count FROM servers").get() as { count?: number } | null;
    return row?.count ?? 0;
  }

  upsert(input: Omit<ServerRecord, "createdAt" | "updatedAt"> & { createdAt?: string; updatedAt?: string }) {
    const createdAt = input.createdAt ?? nowIso();
    const updatedAt = input.updatedAt ?? nowIso();
    this.database
      .query(
        `
          INSERT INTO servers (
            id, kind, hosting_kind, label, base_url, auth_json, capabilities_json, is_local,
            is_enabled, source, notes_json, created_at, updated_at, last_seen_at
          )
          VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
          ON CONFLICT(id) DO UPDATE SET
            kind = excluded.kind,
            hosting_kind = excluded.hosting_kind,
            label = excluded.label,
            base_url = excluded.base_url,
            auth_json = excluded.auth_json,
            capabilities_json = excluded.capabilities_json,
            is_local = excluded.is_local,
            is_enabled = excluded.is_enabled,
            source = excluded.source,
            notes_json = excluded.notes_json,
            updated_at = excluded.updated_at,
            last_seen_at = excluded.last_seen_at
        `,
      )
      .run(
        input.id,
        input.kind,
        input.hostingKind,
        input.label,
        input.baseUrl,
        stringifyJsonValue(input.auth),
        stringifyJsonValue(input.capabilities),
        toSqlBoolean(input.isLocal),
        toSqlBoolean(input.isEnabled),
        input.source,
        stringifyJsonValue(input.notes),
        createdAt,
        updatedAt,
        input.lastSeenAt,
      );

    return this.getById(input.id)!;
  }
}

export class WorkspacesRepository {
  constructor(private readonly database: Database) {}

  deleteById(id: string) {
    const existing = this.getById(id);
    if (!existing) {
      return false;
    }
    this.database.query("DELETE FROM workspaces WHERE id = ?1").run(id);
    return true;
  }

  getById(id: string) {
    return mapWorkspace(this.database.query("SELECT * FROM workspaces WHERE id = ?1").get(id) as RawWorkspaceRow | null);
  }

  getBySlug(slug: string) {
    return mapWorkspace(this.database.query("SELECT * FROM workspaces WHERE slug = ?1").get(slug) as RawWorkspaceRow | null);
  }

  list(input?: { includeHidden?: boolean }) {
    const includeHidden = input?.includeHidden ?? false;
    const query = includeHidden
      ? "SELECT * FROM workspaces ORDER BY is_hidden ASC, display_name COLLATE NOCASE ASC"
      : "SELECT * FROM workspaces WHERE is_hidden = 0 ORDER BY display_name COLLATE NOCASE ASC";
    return (this.database.query(query).all() as RawWorkspaceRow[]).map(mapWorkspace).filter(Boolean) as WorkspaceRecord[];
  }

  listByServerId(serverId: string, input?: { includeHidden?: boolean }) {
    const includeHidden = input?.includeHidden ?? false;
    const query = includeHidden
      ? "SELECT * FROM workspaces WHERE server_id = ?1 ORDER BY is_hidden ASC, display_name COLLATE NOCASE ASC"
      : "SELECT * FROM workspaces WHERE server_id = ?1 AND is_hidden = 0 ORDER BY display_name COLLATE NOCASE ASC";
    return (this.database.query(query).all(serverId) as RawWorkspaceRow[]).map(mapWorkspace).filter(Boolean) as WorkspaceRecord[];
  }

  countVisible() {
    const row = this.database.query("SELECT COUNT(1) AS count FROM workspaces WHERE is_hidden = 0").get() as { count?: number } | null;
    return row?.count ?? 0;
  }

  findSlugConflict(slug: string, excludeWorkspaceId?: string) {
    const row = excludeWorkspaceId
      ? (this.database
          .query("SELECT * FROM workspaces WHERE slug = ?1 AND id != ?2")
          .get(slug, excludeWorkspaceId) as RawWorkspaceRow | null)
      : (this.database.query("SELECT * FROM workspaces WHERE slug = ?1").get(slug) as RawWorkspaceRow | null);
    return mapWorkspace(row);
  }

  upsert(input: Omit<WorkspaceRecord, "createdAt" | "updatedAt"> & { createdAt?: string; updatedAt?: string }) {
    const createdAt = input.createdAt ?? nowIso();
    const updatedAt = input.updatedAt ?? nowIso();
    this.database
      .query(
        `
          INSERT INTO workspaces (
            id, server_id, kind, display_name, slug, is_hidden, status, opencode_project_id,
            remote_workspace_id, data_dir, config_dir, notes_json, created_at, updated_at
          )
          VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
          ON CONFLICT(id) DO UPDATE SET
            server_id = excluded.server_id,
            kind = excluded.kind,
            display_name = excluded.display_name,
            slug = excluded.slug,
            is_hidden = excluded.is_hidden,
            status = excluded.status,
            opencode_project_id = excluded.opencode_project_id,
            remote_workspace_id = excluded.remote_workspace_id,
            data_dir = excluded.data_dir,
            config_dir = excluded.config_dir,
            notes_json = excluded.notes_json,
            updated_at = excluded.updated_at
        `,
      )
      .run(
        input.id,
        input.serverId,
        input.kind,
        input.displayName,
        input.slug,
        toSqlBoolean(input.isHidden),
        input.status,
        input.opencodeProjectId,
        input.remoteWorkspaceId,
        input.dataDir,
        input.configDir,
        stringifyJsonValue(input.notes),
        createdAt,
        updatedAt,
      );
    return this.getById(input.id)!;
  }
}

export class ServerRuntimeStateRepository {
  constructor(private readonly database: Database) {}

  getByServerId(serverId: string) {
    return mapServerRuntimeState(
      this.database.query("SELECT * FROM server_runtime_state WHERE server_id = ?1").get(serverId) as RawServerRuntimeStateRow | null,
    );
  }

  upsert(input: Omit<ServerRuntimeStateRecord, "updatedAt"> & { updatedAt?: string }) {
    const updatedAt = input.updatedAt ?? nowIso();
    this.database
      .query(
        `
          INSERT INTO server_runtime_state (
            server_id, runtime_version, opencode_status, opencode_version, opencode_base_url,
            router_status, router_version, restart_policy_json, last_started_at, last_exit_json,
            health_json, updated_at
          )
          VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
          ON CONFLICT(server_id) DO UPDATE SET
            runtime_version = excluded.runtime_version,
            opencode_status = excluded.opencode_status,
            opencode_version = excluded.opencode_version,
            opencode_base_url = excluded.opencode_base_url,
            router_status = excluded.router_status,
            router_version = excluded.router_version,
            restart_policy_json = excluded.restart_policy_json,
            last_started_at = excluded.last_started_at,
            last_exit_json = excluded.last_exit_json,
            health_json = excluded.health_json,
            updated_at = excluded.updated_at
        `,
      )
      .run(
        input.serverId,
        input.runtimeVersion,
        input.opencodeStatus,
        input.opencodeVersion,
        input.opencodeBaseUrl,
        input.routerStatus,
        input.routerVersion,
        stringifyJsonValue(input.restartPolicy),
        input.lastStartedAt,
        stringifyJsonValue(input.lastExit),
        stringifyJsonValue(input.health),
        updatedAt,
      );
    return this.getByServerId(input.serverId)!;
  }
}

export class WorkspaceRuntimeStateRepository {
  constructor(private readonly database: Database) {}

  getByWorkspaceId(workspaceId: string) {
    return mapWorkspaceRuntimeState(
      this.database.query("SELECT * FROM workspace_runtime_state WHERE workspace_id = ?1").get(workspaceId) as RawWorkspaceRuntimeStateRow | null,
    );
  }

  upsert(input: Omit<WorkspaceRuntimeStateRecord, "updatedAt"> & { updatedAt?: string }) {
    const updatedAt = input.updatedAt ?? nowIso();
    this.database
      .query(
        `
          INSERT INTO workspace_runtime_state (
            workspace_id, backend_kind, last_sync_at, last_session_refresh_at, last_error_json,
            health_json, updated_at
          )
          VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
          ON CONFLICT(workspace_id) DO UPDATE SET
            backend_kind = excluded.backend_kind,
            last_sync_at = excluded.last_sync_at,
            last_session_refresh_at = excluded.last_session_refresh_at,
            last_error_json = excluded.last_error_json,
            health_json = excluded.health_json,
            updated_at = excluded.updated_at
        `,
      )
      .run(
        input.workspaceId,
        input.backendKind,
        input.lastSyncAt,
        input.lastSessionRefreshAt,
        stringifyJsonValue(input.lastError),
        stringifyJsonValue(input.health),
        updatedAt,
      );
    return this.getByWorkspaceId(input.workspaceId)!;
  }
}

export class ServerConfigStateRepository {
  constructor(private readonly database: Database) {}

  getByServerId(serverId: string) {
    return mapServerConfigState(
      this.database.query("SELECT * FROM server_config_state WHERE server_id = ?1").get(serverId) as RawServerConfigStateRow | null,
    );
  }

  upsert(input: Omit<ServerConfigStateRecord, "updatedAt"> & { updatedAt?: string }) {
    const updatedAt = input.updatedAt ?? nowIso();
    this.database
      .query(
        `
          INSERT INTO server_config_state (server_id, opencode_json, updated_at)
          VALUES (?1, ?2, ?3)
          ON CONFLICT(server_id) DO UPDATE SET
            opencode_json = excluded.opencode_json,
            updated_at = excluded.updated_at
        `,
      )
      .run(input.serverId, stringifyJsonValue(input.opencode), updatedAt);
    return this.getByServerId(input.serverId)!;
  }
}

export class WorkspaceConfigStateRepository {
  constructor(private readonly database: Database) {}

  getByWorkspaceId(workspaceId: string) {
    return mapWorkspaceConfigState(
      this.database.query("SELECT * FROM workspace_config_state WHERE workspace_id = ?1").get(workspaceId) as RawWorkspaceConfigStateRow | null,
    );
  }

  upsert(input: Omit<WorkspaceConfigStateRecord, "updatedAt"> & { updatedAt?: string }) {
    const updatedAt = input.updatedAt ?? nowIso();
    this.database
      .query(
        `
          INSERT INTO workspace_config_state (workspace_id, openwork_json, opencode_json, updated_at)
          VALUES (?1, ?2, ?3, ?4)
          ON CONFLICT(workspace_id) DO UPDATE SET
            openwork_json = excluded.openwork_json,
            opencode_json = excluded.opencode_json,
            updated_at = excluded.updated_at
        `,
      )
      .run(
        input.workspaceId,
        stringifyJsonValue(input.openwork),
        stringifyJsonValue(input.opencode),
        updatedAt,
      );
    return this.getByWorkspaceId(input.workspaceId)!;
  }
}

export class ManagedConfigRepository {
  constructor(
    private readonly database: Database,
    private readonly tableName: "mcps" | "skills" | "plugins" | "provider_configs",
  ) {}

  getById(id: string) {
    return mapManagedConfig(
      this.database.query(`SELECT * FROM ${this.tableName} WHERE id = ?1`).get(id) as RawManagedConfigRow | null,
    );
  }

  findByKey(key: string) {
    return (this.database
      .query(`SELECT * FROM ${this.tableName} WHERE item_key = ?1 ORDER BY updated_at DESC`)
      .all(key) as RawManagedConfigRow[]).map(mapManagedConfig).filter(Boolean) as ManagedConfigRecord[];
  }

  list() {
    return (this.database
      .query(`SELECT * FROM ${this.tableName} ORDER BY updated_at DESC`)
      .all() as RawManagedConfigRow[]).map(mapManagedConfig).filter(Boolean) as ManagedConfigRecord[];
  }

  deleteById(id: string) {
    const existing = this.getById(id);
    if (!existing) {
      return false;
    }
    this.database.query(`DELETE FROM ${this.tableName} WHERE id = ?1`).run(id);
    return true;
  }

  upsert(input: Omit<ManagedConfigRecord, "createdAt" | "updatedAt"> & { createdAt?: string; updatedAt?: string }) {
    const createdAt = input.createdAt ?? nowIso();
    const updatedAt = input.updatedAt ?? nowIso();
    const itemKind = this.tableName === "mcps"
      ? "mcp"
      : this.tableName === "plugins"
        ? "plugin"
        : this.tableName === "provider_configs"
          ? "provider"
          : "skill";
    this.database
      .query(
        `
          INSERT INTO ${this.tableName} (
            id, item_kind, display_name, item_key, config_json, auth_json, metadata_json,
            source, cloud_item_id, created_at, updated_at
          )
          VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
          ON CONFLICT(id) DO UPDATE SET
            item_kind = excluded.item_kind,
            display_name = excluded.display_name,
            item_key = excluded.item_key,
            config_json = excluded.config_json,
            auth_json = excluded.auth_json,
            metadata_json = excluded.metadata_json,
            source = excluded.source,
            cloud_item_id = excluded.cloud_item_id,
            updated_at = excluded.updated_at
        `,
      )
      .run(
        input.id,
        itemKind,
        input.displayName,
        input.key,
        stringifyJsonValue(input.config),
        stringifyJsonValue(input.auth),
        stringifyJsonValue(input.metadata),
        input.source,
        input.cloudItemId,
        createdAt,
        updatedAt,
      );
    return this.getById(input.id)!;
  }
}

export class WorkspaceAssignmentRepository {
  constructor(
    private readonly database: Database,
    private readonly tableName:
      | "workspace_mcps"
      | "workspace_skills"
      | "workspace_plugins"
      | "workspace_provider_configs",
  ) {}

  listForWorkspace(workspaceId: string) {
    return (this.database
      .query(`SELECT workspace_id, item_id, created_at, updated_at FROM ${this.tableName} WHERE workspace_id = ?1`)
      .all(workspaceId) as Array<{
      created_at: string;
      item_id: string;
      updated_at: string;
      workspace_id: string;
    }>).map((row) => ({
      createdAt: row.created_at,
      itemId: row.item_id,
      updatedAt: row.updated_at,
      workspaceId: row.workspace_id,
    })) as WorkspaceAssignmentRecord[];
  }

  listForItem(itemId: string) {
    return (this.database
      .query(`SELECT workspace_id, item_id, created_at, updated_at FROM ${this.tableName} WHERE item_id = ?1`)
      .all(itemId) as Array<{
      created_at: string;
      item_id: string;
      updated_at: string;
      workspace_id: string;
    }>).map((row) => ({
      createdAt: row.created_at,
      itemId: row.item_id,
      updatedAt: row.updated_at,
      workspaceId: row.workspace_id,
    })) as WorkspaceAssignmentRecord[];
  }

  deleteForItem(itemId: string) {
    this.database.query(`DELETE FROM ${this.tableName} WHERE item_id = ?1`).run(itemId);
  }

  replaceAssignments(workspaceId: string, itemIds: string[]) {
    const replace = this.database.transaction((nextItemIds: string[]) => {
      this.database.query(`DELETE FROM ${this.tableName} WHERE workspace_id = ?1`).run(workspaceId);
      const timestamp = nowIso();
      const insert = this.database.query(
        `INSERT INTO ${this.tableName} (workspace_id, item_id, created_at, updated_at) VALUES (?1, ?2, ?3, ?4)`,
      );
      for (const itemId of nextItemIds) {
        insert.run(workspaceId, itemId, timestamp, timestamp);
      }
    });

    replace(itemIds);
    return this.listForWorkspace(workspaceId);
  }
}

export class CloudSigninRepository {
  constructor(private readonly database: Database) {}

  getPrimary() {
    return mapCloudSignin(this.database.query("SELECT * FROM cloud_signin LIMIT 1").get() as RawCloudSigninRow | null);
  }

  upsert(input: Omit<CloudSigninRecord, "createdAt" | "updatedAt"> & { createdAt?: string; updatedAt?: string }) {
    const createdAt = input.createdAt ?? nowIso();
    const updatedAt = input.updatedAt ?? nowIso();
    this.database
      .query(
        `
          INSERT INTO cloud_signin (
            id, server_id, cloud_base_url, user_id, org_id, auth_json, metadata_json,
            last_validated_at, created_at, updated_at
          )
          VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
          ON CONFLICT(id) DO UPDATE SET
            server_id = excluded.server_id,
            cloud_base_url = excluded.cloud_base_url,
            user_id = excluded.user_id,
            org_id = excluded.org_id,
            auth_json = excluded.auth_json,
            metadata_json = excluded.metadata_json,
            last_validated_at = excluded.last_validated_at,
            updated_at = excluded.updated_at
        `,
      )
      .run(
        input.id,
        input.serverId,
        input.cloudBaseUrl,
        input.userId,
        input.orgId,
        stringifyJsonValue(input.auth),
        stringifyJsonValue(input.metadata),
        input.lastValidatedAt,
        createdAt,
        updatedAt,
      );
    return this.getPrimary()!;
  }

  deletePrimary() {
    this.database.query("DELETE FROM cloud_signin").run();
  }
}

export class WorkspaceSharesRepository {
  constructor(private readonly database: Database) {}

  getById(id: string) {
    return mapWorkspaceShare(this.database.query("SELECT * FROM workspace_shares WHERE id = ?1").get(id) as RawWorkspaceShareRow | null);
  }

  listByWorkspace(workspaceId: string) {
    return (this.database
      .query("SELECT * FROM workspace_shares WHERE workspace_id = ?1 ORDER BY updated_at DESC")
      .all(workspaceId) as RawWorkspaceShareRow[]).map(mapWorkspaceShare).filter(Boolean) as WorkspaceShareRecord[];
  }

  getLatestByWorkspace(workspaceId: string) {
    return mapWorkspaceShare(
      this.database.query("SELECT * FROM workspace_shares WHERE workspace_id = ?1 ORDER BY updated_at DESC LIMIT 1").get(workspaceId) as RawWorkspaceShareRow | null,
    );
  }

  upsert(input: Omit<WorkspaceShareRecord, "createdAt" | "updatedAt"> & { createdAt?: string; updatedAt?: string }) {
    const createdAt = input.createdAt ?? nowIso();
    const updatedAt = input.updatedAt ?? nowIso();
    this.database
      .query(
        `
          INSERT INTO workspace_shares (
            id, workspace_id, access_key, status, last_used_at, audit_json, created_at, updated_at, revoked_at
          )
          VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
          ON CONFLICT(id) DO UPDATE SET
            workspace_id = excluded.workspace_id,
            access_key = excluded.access_key,
            status = excluded.status,
            last_used_at = excluded.last_used_at,
            audit_json = excluded.audit_json,
            updated_at = excluded.updated_at,
            revoked_at = excluded.revoked_at
        `,
      )
      .run(
        input.id,
        input.workspaceId,
        input.accessKey,
        input.status,
        input.lastUsedAt,
        stringifyJsonValue(input.audit),
        createdAt,
        updatedAt,
        input.revokedAt,
      );
    return this.listByWorkspace(input.workspaceId).find((item) => item.id === input.id)!;
  }
}

export class RouterIdentitiesRepository {
  constructor(private readonly database: Database) {}

  getById(id: string) {
    return mapRouterIdentity(this.database.query("SELECT * FROM router_identities WHERE id = ?1").get(id) as RawRouterIdentityRow | null);
  }

  listByServer(serverId: string) {
    return (this.database
      .query("SELECT * FROM router_identities WHERE server_id = ?1 ORDER BY updated_at DESC")
      .all(serverId) as RawRouterIdentityRow[]).map(mapRouterIdentity).filter(Boolean) as RouterIdentityRecord[];
  }

  deleteById(id: string) {
    const existing = this.getById(id);
    if (!existing) {
      return false;
    }
    this.database.query("DELETE FROM router_identities WHERE id = ?1").run(id);
    return true;
  }

  upsert(input: Omit<RouterIdentityRecord, "createdAt" | "updatedAt"> & { createdAt?: string; updatedAt?: string }) {
    const createdAt = input.createdAt ?? nowIso();
    const updatedAt = input.updatedAt ?? nowIso();
    this.database
      .query(
        `
          INSERT INTO router_identities (
            id, server_id, kind, display_name, config_json, auth_json, is_enabled, created_at, updated_at
          )
          VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
          ON CONFLICT(id) DO UPDATE SET
            server_id = excluded.server_id,
            kind = excluded.kind,
            display_name = excluded.display_name,
            config_json = excluded.config_json,
            auth_json = excluded.auth_json,
            is_enabled = excluded.is_enabled,
            updated_at = excluded.updated_at
        `,
      )
      .run(
        input.id,
        input.serverId,
        input.kind,
        input.displayName,
        stringifyJsonValue(input.config),
        stringifyJsonValue(input.auth),
        toSqlBoolean(input.isEnabled),
        createdAt,
        updatedAt,
      );
    return this.listByServer(input.serverId).find((item) => item.id === input.id)!;
  }
}

export class RouterBindingsRepository {
  constructor(private readonly database: Database) {}

  getById(id: string) {
    return mapRouterBinding(this.database.query("SELECT * FROM router_bindings WHERE id = ?1").get(id) as RawRouterBindingRow | null);
  }

  listByServer(serverId: string) {
    return (this.database
      .query("SELECT * FROM router_bindings WHERE server_id = ?1 ORDER BY updated_at DESC")
      .all(serverId) as RawRouterBindingRow[]).map(mapRouterBinding).filter(Boolean) as RouterBindingRecord[];
  }

  deleteById(id: string) {
    const existing = this.getById(id);
    if (!existing) {
      return false;
    }
    this.database.query("DELETE FROM router_bindings WHERE id = ?1").run(id);
    return true;
  }

  upsert(input: Omit<RouterBindingRecord, "createdAt" | "updatedAt"> & { createdAt?: string; updatedAt?: string }) {
    const createdAt = input.createdAt ?? nowIso();
    const updatedAt = input.updatedAt ?? nowIso();
    this.database
      .query(
        `
          INSERT INTO router_bindings (
            id, server_id, router_identity_id, binding_key, config_json, is_enabled, created_at, updated_at
          )
          VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
          ON CONFLICT(id) DO UPDATE SET
            server_id = excluded.server_id,
            router_identity_id = excluded.router_identity_id,
            binding_key = excluded.binding_key,
            config_json = excluded.config_json,
            is_enabled = excluded.is_enabled,
            updated_at = excluded.updated_at
        `,
      )
      .run(
        input.id,
        input.serverId,
        input.routerIdentityId,
        input.bindingKey,
        stringifyJsonValue(input.config),
        toSqlBoolean(input.isEnabled),
        createdAt,
        updatedAt,
      );
    return this.listByServer(input.serverId).find((item) => item.id === input.id)!;
  }
}

export type ServerRepositories = {
  cloudSignin: CloudSigninRepository;
  mcps: ManagedConfigRepository;
  plugins: ManagedConfigRepository;
  providerConfigs: ManagedConfigRepository;
  routerBindings: RouterBindingsRepository;
  routerIdentities: RouterIdentitiesRepository;
  serverConfigState: ServerConfigStateRepository;
  serverRuntimeState: ServerRuntimeStateRepository;
  servers: ServersRepository;
  skills: ManagedConfigRepository;
  workspaceConfigState: WorkspaceConfigStateRepository;
  workspaceMcps: WorkspaceAssignmentRepository;
  workspacePlugins: WorkspaceAssignmentRepository;
  workspaceProviderConfigs: WorkspaceAssignmentRepository;
  workspaceRuntimeState: WorkspaceRuntimeStateRepository;
  workspaceShares: WorkspaceSharesRepository;
  workspaceSkills: WorkspaceAssignmentRepository;
  workspaces: WorkspacesRepository;
};

export function createRepositories(database: Database): ServerRepositories {
  return {
    cloudSignin: new CloudSigninRepository(database),
    mcps: new ManagedConfigRepository(database, "mcps"),
    plugins: new ManagedConfigRepository(database, "plugins"),
    providerConfigs: new ManagedConfigRepository(database, "provider_configs"),
    routerBindings: new RouterBindingsRepository(database),
    routerIdentities: new RouterIdentitiesRepository(database),
    serverConfigState: new ServerConfigStateRepository(database),
    serverRuntimeState: new ServerRuntimeStateRepository(database),
    servers: new ServersRepository(database),
    skills: new ManagedConfigRepository(database, "skills"),
    workspaceConfigState: new WorkspaceConfigStateRepository(database),
    workspaceMcps: new WorkspaceAssignmentRepository(database, "workspace_mcps"),
    workspacePlugins: new WorkspaceAssignmentRepository(database, "workspace_plugins"),
    workspaceProviderConfigs: new WorkspaceAssignmentRepository(database, "workspace_provider_configs"),
    workspaceRuntimeState: new WorkspaceRuntimeStateRepository(database),
    workspaceShares: new WorkspaceSharesRepository(database),
    workspaceSkills: new WorkspaceAssignmentRepository(database, "workspace_skills"),
    workspaces: new WorkspacesRepository(database),
  };
}
