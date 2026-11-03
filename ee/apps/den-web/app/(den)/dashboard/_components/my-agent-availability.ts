import { orgFeatureEnabled, type DenOrgContext } from "../../_lib/den-org"

/**
 * Whether the member's own agent ("My bot") is shown anywhere in the shell.
 *
 * Pure predicate kept separate from the MyAgentScreen UI module so the
 * dashboard shell and command palette can read it without pulling the whole
 * screen (React, hooks, library data, panels) into their module graph. The
 * shell used to import this from my-agent-screen.tsx, which created a fragile
 * import chain that surfaced as a runtime ReferenceError under HMR/cold boot.
 *
 * The deployment must expose Workbot to the member and the Your agent
 * rollout must be on; it includes the member UI and admin health view.
 */
export function myAgentAvailable(orgContext: DenOrgContext | null | undefined): boolean {
  return orgContext?.capabilities.workbot === true
    && orgFeatureEnabled(orgContext, "workbotProactive")
}
