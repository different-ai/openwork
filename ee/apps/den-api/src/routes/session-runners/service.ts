import type { AutomationDesktopRunnerRegistration, DesktopRunnerInventory, RunnerSessionReport } from "@openwork/types/automations"
import { runnerStanding } from "../../computer-disconnect.js"
import { automationRepository } from "../../automations/repository.js"

export type SessionRunnerScope = { organizationId: string; ownerMemberId: string; runnerId: string }

/** Shared runner storage and authority, independent of the scheduler runtime. */
export class SessionRunnerService {
  /** `authSessionId`: the sign-in the registration came with, so disconnecting the computer can end it. */
  registerDesktopRunner(scope: Omit<SessionRunnerScope, "runnerId">, registration: AutomationDesktopRunnerRegistration, authSessionId: string | null = null) {
    return automationRepository.registerDesktopRunner({ ...scope, ...registration, authSessionId, now: Date.now() })
  }

  /** Whether the runner's credential is honoured: its owner is an active member and the computer was not disconnected. */
  runnerStanding(scope: SessionRunnerScope) {
    return runnerStanding(scope)
  }

  touchDesktopRunner(scope: SessionRunnerScope) {
    return automationRepository.touchDesktopRunner({ ...scope, now: Date.now() })
  }

  saveDesktopRunnerInventory(scope: SessionRunnerScope, inventory: DesktopRunnerInventory) {
    return automationRepository.saveDesktopRunnerInventory({ ...scope, inventory, now: Date.now() })
  }

  saveDesktopRunnerSessions(scope: SessionRunnerScope, report: RunnerSessionReport) {
    return automationRepository.saveDesktopRunnerSessions({ ...scope, ...report, now: Date.now() })
  }
}

export const sessionRunnerService = new SessionRunnerService()
