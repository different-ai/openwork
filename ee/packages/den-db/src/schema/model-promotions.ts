import { bigint, index, int, json, mysqlTable, timestamp, uniqueIndex, varchar } from "drizzle-orm/mysql-core"
import type { ModelPromotionTerms } from "@openwork/types/den/model-promotions"
import { denTypeIdColumn, encryptedTextColumn } from "../columns"

const dollars = (name: string) => bigint(name, { mode: "number", unsigned: true }).notNull().default(0)
export const ModelPromotionTable = mysqlTable("model_promotions", {
  id: varchar("id", { length: 36 }).primaryKey(),
  slug: varchar("slug", { length: 64 }).notNull(),
  alias: varchar("alias", { length: 64 }).notNull(),
  version: int("version").notNull().default(1),
  status: varchar("status", { length: 16 }).notNull().default("draft"),
  terms: json("terms").$type<ModelPromotionTerms>().notNull(),
  encrypted_key: encryptedTextColumn("encrypted_key").notNull(),
  key_fingerprint: varchar("key_fingerprint", { length: 64 }).notNull(),
  claimed: int("claimed").notNull().default(0),
  spent_microusd: dollars("spent_microusd"),
  reserved_microusd: dollars("reserved_microusd"),
  created_at: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
}, (t) => [uniqueIndex("model_promotion_slug").on(t.slug), uniqueIndex("model_promotion_alias").on(t.alias), uniqueIndex("model_promotion_key").on(t.key_fingerprint)])

export const ModelPromotionGrantTable = mysqlTable("model_promotion_grants", {
  id: varchar("id", { length: 36 }).primaryKey(),
  campaign_id: varchar("campaign_id", { length: 36 }).notNull(),
  user_id: denTypeIdColumn("user", "user_id").notNull(),
  organization_id: denTypeIdColumn("organization", "organization_id").notNull(),
  member_id: denTypeIdColumn("member", "member_id").notNull(),
  status: varchar("status", { length: 16 }).notNull(),
  terms: json("terms").$type<ModelPromotionTerms>().notNull(),
  terms_version: int("terms_version").notNull(),
  credit_microusd: dollars("credit_microusd"),
  spent_microusd: dollars("spent_microusd"),
  reserved_microusd: dollars("reserved_microusd"),
  stripe_session_id: varchar("stripe_session_id", { length: 255 }),
  stripe_subscription_id: varchar("stripe_subscription_id", { length: 255 }),
  stripe_invoice_id: varchar("stripe_invoice_id", { length: 255 }),
  paid_at: timestamp("paid_at", { fsp: 3 }),
  activate_by: timestamp("activate_by", { fsp: 3 }),
  expires_at: timestamp("expires_at", { fsp: 3 }),
  created_at: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
}, (t) => [uniqueIndex("model_grant_user").on(t.campaign_id, t.user_id), uniqueIndex("model_grant_org").on(t.campaign_id, t.organization_id), uniqueIndex("model_grant_session").on(t.stripe_session_id), index("model_grant_subscription").on(t.stripe_subscription_id)])

export const ModelPromotionRequestTable = mysqlTable("model_promotion_requests", {
  id: varchar("id", { length: 36 }).primaryKey(),
  campaign_id: varchar("campaign_id", { length: 36 }).notNull(),
  grant_id: varchar("grant_id", { length: 36 }).notNull(),
  status: varchar("status", { length: 16 }).notNull(),
  reserved_microusd: dollars("reserved_microusd"),
  cost_microusd: dollars("cost_microusd"),
  generation_id: varchar("generation_id", { length: 255 }),
  created_at: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
}, (t) => [index("model_request_grant_time").on(t.grant_id, t.created_at)])

export const ModelPromotionVisitTable = mysqlTable("model_promotion_visits", {
  token_hash: varchar("token_hash", { length: 64 }).primaryKey(),
  campaign_id: varchar("campaign_id", { length: 36 }).notNull(),
  claimed_by: denTypeIdColumn("user", "claimed_by"),
  created_at: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
})

export const ModelPromotionAuditTable = mysqlTable("model_promotion_audit", {
  id: varchar("id", { length: 36 }).primaryKey(),
  campaign_id: varchar("campaign_id", { length: 36 }).notNull(),
  actor_id: varchar("actor_id", { length: 64 }).notNull(),
  action: varchar("action", { length: 64 }).notNull(),
  subject_id: varchar("subject_id", { length: 255 }),
  created_at: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
}, (t) => [index("model_promo_audit_time").on(t.campaign_id, t.created_at)])
