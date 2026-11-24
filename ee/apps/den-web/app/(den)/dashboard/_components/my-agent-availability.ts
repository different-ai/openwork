import type { DenOrgContext } from "../../_lib/den-org"

export function myAgentAvailable(orgContext: DenOrgContext | null | undefined): boolean {
  return orgContext?.capabilities.workbot === true
}
