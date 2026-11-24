import { isDenTypeId, type DenTypeId } from "@openwork-ee/utils/typeid"
import { env } from "../env.js"

export function isHarnessFeedbackOrganization(id: string): id is DenTypeId<"organization"> {
  return isDenTypeId("organization", id) && env.harnessFeedbackOrgIds.has(id)
}

export function harnessFeedbackOrganizationIds() {
  return [...env.harnessFeedbackOrgIds].filter((id) => isDenTypeId("organization", id))
}
