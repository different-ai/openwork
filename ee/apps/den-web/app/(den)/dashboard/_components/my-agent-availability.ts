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
 * Preserve the original conditions: the deployment exposes Workbot to the
 * member, and both rollouts that gate the agent UI are on.
 */
export function myAgentAvailable(orgContext: DenOrgContext | null | undefined): boolean {
  return orgContext?.capabilities.workbot === true
    && orgFeatureEnabled(orgContext, "workbotProactive")
    && orgFeatureEnabled(orgContext, "workbotAgentLibrary")
}
