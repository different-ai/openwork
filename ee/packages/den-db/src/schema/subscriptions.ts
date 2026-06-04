import { relations } from "drizzle-orm"
import { boolean, index, int, mysqlEnum, mysqlTable, timestamp, uniqueIndex, varchar } from "drizzle-orm/mysql-core"
import { denTypeIdColumn, timestamps } from "../columns"
import { MemberTable, OrganizationTable } from "./org"

export const OrgSubscriptionType = ["inference", "seat"] as const
export const OrgSubscriptionStatus = [
  "incomplete",
  "incomplete_expired",
  "trialing",
  "active",
  "past_due",
  "canceled",
  "unpaid",
  "paused",
  "expired",
] as const

export const OrgSubscriptionTable = mysqlTable(
  "org_subscriptions",
  {
    id: denTypeIdColumn("orgSubscription", "id").notNull().primaryKey(),
    organization_id: denTypeIdColumn("organization", "organization_id").notNull(),
    created_by_org_membership_id: denTypeIdColumn("member", "created_by_org_membership_id"),
    type: mysqlEnum("type", OrgSubscriptionType).notNull(),
    status: mysqlEnum("status", OrgSubscriptionStatus).notNull().default("incomplete"),
    stripe_customer_id: varchar("stripe_customer_id", { length: 255 }).notNull(),
    stripe_subscription_id: varchar("stripe_subscription_id", { length: 255 }).notNull(),
    stripe_price_id: varchar("stripe_price_id", { length: 255 }),
    stripe_subscription_item_id: varchar("stripe_subscription_item_id", { length: 255 }),
    quantity: int("quantity").notNull().default(0),
    current_period_start: timestamp("current_period_start", { fsp: 3 }),
    current_period_end: timestamp("current_period_end", { fsp: 3 }),
    cancel_at_period_end: boolean("cancel_at_period_end").notNull().default(false),
    canceled_at: timestamp("canceled_at", { fsp: 3 }),
    ended_at: timestamp("ended_at", { fsp: 3 }),
    last_event_id: varchar("last_event_id", { length: 255 }),
    ...timestamps,
  },
  (table) => [
    index("org_subscriptions_organization_id").on(table.organization_id),
    index("org_subscriptions_customer_id").on(table.stripe_customer_id),
    uniqueIndex("org_subscriptions_subscription_id").on(table.stripe_subscription_id),
    uniqueIndex("org_subscriptions_org_type").on(table.organization_id, table.type),
    index("org_subscriptions_status").on(table.status),
  ],
)

export const orgSubscriptionRelations = relations(OrgSubscriptionTable, ({ one }) => ({
  organization: one(OrganizationTable, {
    fields: [OrgSubscriptionTable.organization_id],
    references: [OrganizationTable.id],
  }),
  createdByOrgMembership: one(MemberTable, {
    fields: [OrgSubscriptionTable.created_by_org_membership_id],
    references: [MemberTable.id],
  }),
}))

export const orgSubscription = OrgSubscriptionTable
