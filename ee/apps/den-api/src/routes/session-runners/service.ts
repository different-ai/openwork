import type { AutomationDesktopRunnerRegistration, DesktopRunnerInventory } from "@openwork/types/automations"
import { isActiveAutomationOwner } from "../../automations/authority.js"
import { automationRepository } from "../../automations/repository.js"

export type SessionRunnerScope = { organizationId: string; ownerMemberId: string; runnerId: string }

/** Shared runner storage and authority, independent of the scheduler runtime. */
export class SessionRunnerService {
  registerDesktopRunner(scope: Omit<SessionRunnerScope, "runnerId">, registration: AutomationDesktopRunnerRegistration) {
    return automationRepository.registerDesktopRunner({ ...scope, ...registration, now: Date.now() })
  }

  isActiveRunnerOwner(scope: Omit<SessionRunnerScope, "runnerId">) {
    return isActiveAutomationOwner(scope)
  }

  touchDesktopRunner(scope: SessionRunnerScope) {
    return automationRepository.touchDesktopRunner({ ...scope, now: Date.now() })
  }

  saveDesktopRunnerInventory(scope: SessionRunnerScope, inventory: DesktopRunnerInventory) {
    return automationRepository.saveDesktopRunnerInventory({ ...scope, inventory, now: Date.now() })
  }
}

export const sessionRunnerService = new SessionRunnerService()
