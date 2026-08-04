import { createDenClient } from "@/app/lib/den"

export type AutomationsClient = Pick<
  ReturnType<typeof createDenClient>,
  | "activateAutomation"
  | "archiveAutomation"
  | "cancelAutomationRun"
  | "createAutomation"
  | "deactivateAutomation"
  | "getAutomation"
  | "getAutomationRun"
  | "listAutomationRuns"
  | "listAutomations"
  | "listOrgLlmProviders"
  | "runAutomationNow"
  | "updateAutomation"
>
