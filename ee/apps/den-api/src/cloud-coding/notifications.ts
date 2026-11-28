import { and, eq } from "@openwork-ee/den-db/drizzle"
import { AuthUserTable, MemberTable } from "@openwork-ee/den-db/schema"
import { db } from "../db.js"
import { env } from "../env.js"
import { ORGANIZATION_ADMIN_ROLE, ORGANIZATION_OWNER_ROLE, organizationRoleValueIncludes } from "../organization-role-hierarchy.js"
import { peopleMemberCondition } from "../setup-agent-members.js"
import { sendEmail } from "../utils/email/send-email.js"
import type { CloudCodingMemberScope } from "./links.js"

function people(organizationId: CloudCodingMemberScope["organizationId"]) {
  return db.$primary.select({ memberId: MemberTable.id, role: MemberTable.role, name: AuthUserTable.name, email: AuthUserTable.email })
    .from(MemberTable).innerJoin(AuthUserTable, eq(AuthUserTable.id, MemberTable.userId))
    .where(and(eq(MemberTable.organizationId, organizationId), peopleMemberCondition()))
}

export async function sendCloudCodingLinkReminder(input: CloudCodingMemberScope & { targetMemberId: string }): Promise<boolean> {
  const rows = await people(input.organizationId)
  const target = rows.find(row => row.memberId === input.targetMemberId)
  const sender = rows.find(row => row.memberId === input.memberId)
  if (!target || !sender) return false
  await sendEmail({ to: target.email, template: "cloudCodingLinkGithub", props: { senderName: sender.name, url: `${env.webUrl}/dashboard/cloud-coding/link` } })
  return true
}

export async function sendCloudCodingAdminRequest(input: CloudCodingMemberScope): Promise<boolean> {
  const rows = await people(input.organizationId)
  const requester = rows.find(row => row.memberId === input.memberId)
  if (!requester) return false
  const admins = rows.filter(row => organizationRoleValueIncludes(row.role, ORGANIZATION_OWNER_ROLE) || organizationRoleValueIncludes(row.role, ORGANIZATION_ADMIN_ROLE))
  await Promise.all(admins.map(admin => sendEmail({ to: admin.email, template: "cloudCodingAdminRequest", props: { requesterName: requester.name, url: `${env.webUrl}/dashboard/cloud-coding` } })))
  return admins.length > 0
}
