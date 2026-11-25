import type { AutomationDesktopRunnerRegistration, DesktopRunnerInventory } from "@openwork/types/automations"
import { runnerStanding } from "../../computer-disconnect.js"
import { automationRepository, type StoredRunnerSessionReport } from "../../automations/repository.js"

export type SessionRunnerScope = { organizationId: string; ownerMemberId: string; runnerId: string }

export class SessionRunnerService {
  registerDesktopRunner(scope: Omit<SessionRunnerScope, "runnerId">, registration: AutomationDesktopRunnerRegistration, authSessionId: string | null = null) {
    return automationRepository.registerDesktopRunner({ ...scope, ...registration, authSessionId, now: Date.now() })
  }

  runnerStanding(scope: SessionRunnerScope) {
    return runnerStanding(scope)
  }

  touchDesktopRunner(scope: SessionRunnerScope) {
    return automationRepository.touchDesktopRunner({ ...scope, now: Date.now() })
  }

  saveDesktopRunnerInventory(scope: SessionRunnerScope, inventory: DesktopRunnerInventory) {
    return automationRepository.saveDesktopRunnerInventory({ ...scope, inventory, now: Date.now() })
  }

  saveDesktopRunnerSessions(scope: SessionRunnerScope, report: StoredRunnerSessionReport) {
    return automationRepository.saveDesktopRunnerSessions({ ...scope, access: report.access, sessions: report.sessions, now: Date.now() })
  }
}

export const sessionRunnerService = new SessionRunnerService()
