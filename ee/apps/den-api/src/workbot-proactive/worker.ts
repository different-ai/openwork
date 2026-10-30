import { libraryConnectorLink } from "../agent-links.js"
import { markFeaturesUsed, type MarkFeaturesUsed } from "../feature-usage.js"
import { organizationFeatureEnabled } from "../features.js"
import { appLogger } from "../observability/logger.js"
import { readMemberGoogleCalendar } from "../routes/org/google-workspace.js"
import { organizationCloudModel } from "../workbot/model.js"
import { activeMemberUser, listAgentCandidates, proactiveAllowed, readProactiveSettings } from "./access.js"
import { deliverAgentMessage, destinationBlock } from "./deliver.js"
import {
  agentSentSince,
  recordAgentChecks,
  claimDueAgents,
  ensureAgentInstances,
  finishAgentDelivery,
  holdsAgentLease,
  MEMBER_CHECK_RETENTION_MS,
  pruneAgentDeliveries,
  pruneMemberChecks,
  recordMemberCheck,
  reserveAgentDelivery,
  settleAgent,
  toldAgentItems,
  type AgentInstanceRow,
} from "./repository.js"
import { countConnectedMembers, listMemberConnections } from "./sources-repository.js"
import { readAgentTemplate } from "./template.js"
import { agentMessageId, agentSessionId, defaultAgentTurnDeps, runAgentTurn } from "./turn.js"
import { wakeAgent, type AgentWakeDeps, type AgentWakeOutcome } from "./wake.js"

/**
 * The agents' loop: claims agents whose `next_wake_at` is due (a scheduled pass, or the next calendar look) and
 * wakes each one (wake.ts). Wake sources stay explicit: the schedule and calendar events. Nothing lets a model
 * schedule its own wake-up.
 */

const TICK_MS = 15_000
const MAX_CONCURRENT_WAKES = 4
const DISCOVERY_MS = 10 * 60_000
const LEDGER_RETENTION_MS = 30 * 24 * 3_600_000

export function defaultAgentWakeDeps(): AgentWakeDeps {
  const turnDeps = defaultAgentTurnDeps()
  return {
    now: Date.now,
    allowed: (organizationId, userId) => proactiveAllowed(organizationId, userId),
    settings: readProactiveSettings,
    template: readAgentTemplate,
    user: activeMemberUser,
    calendar: readMemberGoogleCalendar,
    model: (actor) => organizationCloudModel(actor),
    turn: (input) => runAgentTurn(input, turnDeps),
    sessionId: agentSessionId,
    messageId: agentMessageId,
    told: toldAgentItems,
    reserve: reserveAgentDelivery,
    finish: finishAgentDelivery,
    sentSince: agentSentSince,
    holdsLease: (row) => holdsAgentLease(row),
    settle: (row, changes) => settleAgent(row, changes),
    destinationBlock: (input) => destinationBlock(input),
    deliver: (input) => deliverAgentMessage(input),
    recordChecks: recordAgentChecks,
    library: (organizationId, userId) => organizationFeatureEnabled(organizationId, "workbotAgentLibrary", { userId }),
    recordCheck: recordMemberCheck,
    connections: listMemberConnections,
    connectedMembers: countConnectedMembers,
    connectLink: libraryConnectorLink,
  }
}

/**
 * One wake. A pass that ran (the agent looked for the member) is the member using Your agent, for /admin › Features:
 * no request marks background work. Skips (off, snoozed, outside hours, nothing due) are not uses.
 */
export async function wakeAndMarkUse(
  row: AgentInstanceRow,
  wake: (row: AgentInstanceRow) => Promise<AgentWakeOutcome>,
  markUsed: MarkFeaturesUsed = markFeaturesUsed,
): Promise<AgentWakeOutcome> {
  const outcome = await wake(row)
  if (outcome.status === "ran") markUsed({ organizationId: row.organizationId, memberId: row.memberId, keys: ["workbotProactive"] })
  return outcome
}

/** Gives every active member of an organization that turned its agent on an agent row. */
export async function discoverAgents() {
  for (const candidate of await listAgentCandidates()) await ensureAgentInstances(candidate.organizationId, candidate.memberIds)
}

export function startWorkbotProactiveWorker(deps: AgentWakeDeps = defaultAgentWakeDeps()) {
  let stopped = false
  let running = 0
  let claiming = false
  let lastDiscovery = 0
  const tick = async () => {
    if (stopped || claiming) return
    claiming = true
    try {
      const now = deps.now()
      if (now - lastDiscovery >= DISCOVERY_MS) {
        lastDiscovery = now
        await discoverAgents()
        await pruneAgentDeliveries(new Date(now - LEDGER_RETENTION_MS))
        await pruneMemberChecks(new Date(now - MEMBER_CHECK_RETENTION_MS))
      }
      const capacity = MAX_CONCURRENT_WAKES - running
      if (capacity <= 0) return
      for (const row of await claimDueAgents(capacity, new Date(now))) {
        running += 1
        void wakeAndMarkUse(row, (claimed) => wakeAgent(claimed, deps))
          .catch(async () => {
            appLogger.warn("workbot_agent_wake_failed", { member_id: row.memberId })
            await deps.settle(row, { nextWakeAt: new Date(deps.now() + 15 * 60_000), failures: row.failures + 1 }).catch(() => false)
          })
          .finally(() => {
            running -= 1
          })
      }
    } catch {
      appLogger.warn("workbot_agent_queue_unavailable", {})
    } finally {
      claiming = false
    }
  }
  const timer = setInterval(() => void tick(), TICK_MS)
  timer.unref()
  return async () => {
    stopped = true
    clearInterval(timer)
  }
}
