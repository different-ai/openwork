import { sql } from "drizzle-orm"
import { index, mysqlTable, timestamp, uniqueIndex, varchar } from "drizzle-orm/mysql-core"
import type {
  RemoteDeviceDiagnostics,
  RemoteDeviceEventActor,
  RemoteDeviceEventLevel,
  RemoteDeviceEventType,
  RemoteDeviceKind,
  RemoteDevicePlatform,
  RemoteDeviceProvider,
  RemoteDeviceSource,
  RemoteDeviceState,
} from "@openwork/types/den/remote-devices"
import { compatJsonColumn, denTypeIdColumn } from "../columns"

/**
 * The computers a member can reach through OpenWork (feature `remoteDevices`,
 * packages/types/src/den/remote-devices.ts): desktops running OpenWork Desktop,
 * Workbot's cloud computers and registered virtual computers. One row per
 * organization, provider and the provider's own id for the computer.
 *
 * Names, versions, state and readiness only: never provider credentials, file
 * paths, screen content or conversation text. Only den-api's remote devices
 * module reads or writes this table.
 */
export const RemoteDeviceTable = mysqlTable(
  "remote_device",
  {
    id: denTypeIdColumn("remoteDevice", "id").notNull().primaryKey(),
    organizationId: denTypeIdColumn("organization", "organization_id").notNull(),
    /** The member whose computer this is; null when it is shared with the whole organization. */
    ownerMemberId: denTypeIdColumn("member", "owner_member_id"),
    /** Who registered a computer by hand; null for computers that registered themselves. */
    createdByMemberId: denTypeIdColumn("member", "created_by_member_id"),
    kind: varchar("kind", { length: 16 }).$type<RemoteDeviceKind>().notNull(),
    provider: varchar("provider", { length: 32 }).$type<RemoteDeviceProvider>().notNull(),
    source: varchar("source", { length: 16 }).$type<RemoteDeviceSource>().notNull(),
    platform: varchar("platform", { length: 16 }).$type<RemoteDevicePlatform>(),
    /**
     * The provider's id for the computer: a desktop's runner row id (`rnr_…`, the `computerId` remote sessions use),
     * a Workbot computer's runner session id (`hs_…`), or a VM id.
     */
    externalId: varchar("external_id", { length: 191 }).notNull(),
    label: varchar("label", { length: 120 }).notNull(),
    state: varchar("state", { length: 24 }).$type<RemoteDeviceState>().notNull().default("unknown"),
    statusDetail: varchar("status_detail", { length: 300 }),
    appVersion: varchar("app_version", { length: 80 }),
    /** For Workbot's computers: `main` or the side chat's id. */
    workbotChat: varchar("workbot_chat", { length: 96 }),
    /** The latest desktop report, for platform admins. */
    diagnostics: compatJsonColumn<RemoteDeviceDiagnostics>("diagnostics"),
    lastSeenAt: timestamp("last_seen_at", { fsp: 3 }),
    /** Removed from the list by its owner. A computer that reports again comes back. */
    removedAt: timestamp("removed_at", { fsp: 3 }),
    createdAt: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)`),
  },
  (table) => [
    uniqueIndex("remote_device_identity").on(table.organizationId, table.provider, table.externalId),
    index("remote_device_owner").on(table.organizationId, table.ownerMemberId),
    index("remote_device_seen").on(table.lastSeenAt),
  ],
)

/**
 * What happened to a device, newest first when read: registration, state
 * changes, viewer connections, pauses, rebuilds and failures. Fixed event names,
 * one plain sentence and fixed codes; never content from the computer. Pruned
 * per device (REMOTE_DEVICE_EVENT_LIMIT, REMOTE_DEVICE_EVENT_RETENTION_MS).
 */
export const RemoteDeviceEventTable = mysqlTable(
  "remote_device_event",
  {
    id: denTypeIdColumn("remoteDeviceEvent", "id").notNull().primaryKey(),
    organizationId: denTypeIdColumn("organization", "organization_id").notNull(),
    deviceId: denTypeIdColumn("remoteDevice", "device_id").notNull(),
    type: varchar("type", { length: 32 }).$type<RemoteDeviceEventType>().notNull(),
    level: varchar("level", { length: 8 }).$type<RemoteDeviceEventLevel>().notNull(),
    message: varchar("message", { length: 300 }).notNull(),
    actor: varchar("actor", { length: 16 }).$type<RemoteDeviceEventActor>().notNull(),
    /** The member who acted, when one did. */
    actorId: varchar("actor_id", { length: 64 }),
    data: compatJsonColumn<Record<string, string | number | boolean | null>>("data"),
    createdAt: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
  },
  (table) => [
    index("remote_device_event_device").on(table.deviceId, table.createdAt),
    index("remote_device_event_organization").on(table.organizationId, table.createdAt),
  ],
)

/**
 * Signed-in desktops that were disconnected from their organization. A row
 * means "this install is refused": Den mints it no runner credential, honours
 * none it still holds and takes no report from it, until someone signs in on
 * that computer again, which deletes the row.
 */
export const ComputerDisconnectionTable = mysqlTable(
  "computer_disconnection",
  {
    /** The install's runner row id (`rnr_…`): `automation_runner.id`, and `remote_device.external_id` for a desktop. */
    id: varchar("id", { length: 160 }).notNull().primaryKey(),
    organizationId: denTypeIdColumn("organization", "organization_id").notNull(),
    ownerMemberId: denTypeIdColumn("member", "owner_member_id").notNull(),
    disconnectedAt: timestamp("disconnected_at", { fsp: 3 }).notNull(),
    /** The member who disconnected it: its owner, or someone with Disconnect team computers. */
    disconnectedByMemberId: denTypeIdColumn("member", "disconnected_by_member_id"),
    createdAt: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
  },
  (table) => [
    index("computer_disconnection_owner").on(table.organizationId, table.ownerMemberId),
  ],
)
