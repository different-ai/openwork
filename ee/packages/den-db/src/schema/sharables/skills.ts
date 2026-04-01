import { relations, sql } from "drizzle-orm";
import {
    index,
    mysqlEnum,
    mysqlTable,
    text,
    timestamp,
    uniqueIndex,
    varchar,
} from "drizzle-orm/mysql-core";
import { denTypeIdColumn } from "../../columns";
import { MemberTable, OrganizationTable } from "../org";
import { TeamTable } from "../teams";

export const SkillTable = mysqlTable(
    "skill",
    {
        id: denTypeIdColumn("skill", "id").notNull().primaryKey(),
        organizationId: denTypeIdColumn(
            "organization",
            "organization_id",
        ).notNull(),
        createdByOrgMembershipId: denTypeIdColumn(
            "member",
            "created_by_org_membership_id",
        ).notNull(),
        title: varchar("title", { length: 255 }).notNull(),
        description: text("description"),
        skillText: text("skill_text").notNull(),
        shared: mysqlEnum("shared", ["org", "public"]),
        createdAt: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
        updatedAt: timestamp("updated_at", { fsp: 3 })
            .notNull()
            .default(sql`CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)`),
    },
    (table) => [
        index("skill_organization_id").on(table.organizationId),
        index("skill_created_by_org_membership_id").on(
            table.createdByOrgMembershipId,
        ),
        index("skill_shared").on(table.shared),
    ],
);

export const SkillHubTable = mysqlTable(
    "skill_hub",
    {
        id: denTypeIdColumn("skillHub", "id").notNull().primaryKey(),
        organizationId: denTypeIdColumn(
            "organization",
            "organization_id",
        ).notNull(),
        createdByOrgMembershipId: denTypeIdColumn(
            "member",
            "created_by_org_membership_id",
        ).notNull(),
        name: varchar("name", { length: 255 }).notNull(),
        description: text("description"),
        createdAt: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
        updatedAt: timestamp("updated_at", { fsp: 3 })
            .notNull()
            .default(sql`CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)`),
    },
    (table) => [
        index("skill_hub_organization_id").on(table.organizationId),
        index("skill_hub_created_by_org_membership_id").on(
            table.createdByOrgMembershipId,
        ),
    ],
);

export const SkillHubSkillTable = mysqlTable(
    "skill_hub_skill",
    {
        id: denTypeIdColumn("skillHubSkill", "id").notNull().primaryKey(),
        skillHubId: denTypeIdColumn("skillHub", "skill_hub_id").notNull(),
        skillId: denTypeIdColumn("skill", "skill_id").notNull(),
        addedByOrgMembershipId: denTypeIdColumn(
            "member",
            "org_membership_id",
        ).notNull(),
        createdAt: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
    },
    (table) => [
        index("skill_hub_skill_skill_hub_id").on(table.skillHubId),
        index("skill_hub_skill_skill_id").on(table.skillId),
        uniqueIndex("skill_hub_skill_hub_skill").on(
            table.skillHubId,
            table.skillId,
        ),
    ],
);

export const SkillHubMemberTable = mysqlTable(
    "skill_hub_member",
    {
        id: denTypeIdColumn("skillHubMember", "id").notNull().primaryKey(),
        skillHubId: denTypeIdColumn("skillHub", "skill_hub_id").notNull(),
        orgMembershipId: denTypeIdColumn("member", "org_membership_id"),
        teamId: denTypeIdColumn("team", "team_id"),
        createdAt: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
    },
    (table) => [
        index("skill_hub_member_skill_hub_id").on(table.skillHubId),
        index("skill_hub_member_org_membership_id").on(table.orgMembershipId),
        index("skill_hub_member_team_id").on(table.teamId),
        uniqueIndex("skill_hub_member_hub_org_membership").on(
            table.skillHubId,
            table.orgMembershipId,
        ),
        uniqueIndex("skill_hub_member_hub_team").on(
            table.skillHubId,
            table.teamId,
        ),
    ],
);

export const skillRelations = relations(SkillTable, ({ many, one }) => ({
    organization: one(OrganizationTable, {
        fields: [SkillTable.organizationId],
        references: [OrganizationTable.id],
    }),
    createdByOrgMembership: one(MemberTable, {
        fields: [SkillTable.createdByOrgMembershipId],
        references: [MemberTable.id],
    }),
    skillHubLinks: many(SkillHubSkillTable),
}));

export const skillHubRelations = relations(SkillHubTable, ({ many, one }) => ({
    organization: one(OrganizationTable, {
        fields: [SkillHubTable.organizationId],
        references: [OrganizationTable.id],
    }),
    createdByOrgMembership: one(MemberTable, {
        fields: [SkillHubTable.createdByOrgMembershipId],
        references: [MemberTable.id],
    }),
    skillLinks: many(SkillHubSkillTable),
    memberLinks: many(SkillHubMemberTable),
}));

export const skillHubSkillRelations = relations(
    SkillHubSkillTable,
    ({ one }) => ({
        skillHub: one(SkillHubTable, {
            fields: [SkillHubSkillTable.skillHubId],
            references: [SkillHubTable.id],
        }),
        skill: one(SkillTable, {
            fields: [SkillHubSkillTable.skillId],
            references: [SkillTable.id],
        }),
        addedByOrgMembership: one(MemberTable, {
            fields: [SkillHubSkillTable.addedByOrgMembershipId],
            references: [MemberTable.id],
        }),
    }),
);

export const skillHubMemberRelations = relations(
    SkillHubMemberTable,
    ({ one }) => ({
        skillHub: one(SkillHubTable, {
            fields: [SkillHubMemberTable.skillHubId],
            references: [SkillHubTable.id],
        }),
        orgMembership: one(MemberTable, {
            fields: [SkillHubMemberTable.orgMembershipId],
            references: [MemberTable.id],
        }),
        team: one(TeamTable, {
            fields: [SkillHubMemberTable.teamId],
            references: [TeamTable.id],
        }),
    }),
);

export const skill = SkillTable;
export const skillHub = SkillHubTable;
export const skillHubSkill = SkillHubSkillTable;
export const skillHubMember = SkillHubMemberTable;
