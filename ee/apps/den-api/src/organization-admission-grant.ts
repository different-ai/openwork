import { AsyncLocalStorage } from "node:async_hooks"
import type { AdmissionDecision } from "@openwork/types/den/organization-admission"

export type OrganizationAdmissionGrant = {
  method: "scim"
  organizationId: string
  providerId: string
  decisions: Map<string, AdmissionDecision>
}

const admissionGrantStorage = new AsyncLocalStorage<OrganizationAdmissionGrant>()

export function runWithOrganizationAdmissionGrant<T>(
  grant: OrganizationAdmissionGrant,
  callback: () => T,
) {
  return admissionGrantStorage.run(grant, callback)
}

export function getOrganizationAdmissionGrant() {
  return admissionGrantStorage.getStore() ?? null
}

export function organizationAdmissionGrantKey(organizationId: string, userId: string) {
  return `${organizationId}:${userId}`
}
