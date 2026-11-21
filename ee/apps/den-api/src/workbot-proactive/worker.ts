import { libraryConnectorLink, myAgentLink } from "../agent-links.js"
import { markFeaturesUsed } from "../feature-usage.js"
import { env } from "../env.js"
import { appLogger } from "../observability/logger.js"
import { readMemberGmailArrivals, readMemberGoogleCalendar } from "../routes/org/google-workspace.js"
import { organizationCloudModel } from "../workbot/model.js"
import { resolveMemberTeamAgent, teamAgentPolicy } from "../workbot/team-settings.js"
import { readWorkbotDirectMessages } from "../slack-assistant/direct-message.js"
import { activeMemberUser, agentBriefAllowed, agentCheckGateAllowed, agentSendCheckAllowed, agentStoppedSourcesAllowed, listAgentCandidates, memberFirstName, proactiveAllowed, readProactiveSettings } from "./access.js"
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
  readAgentCheckRequests,
  recordMemberCheck,
  reserveAgentDelivery,
  settleAgent,
  toldAgentItems,
  type AgentInstanceRow,
} from "./repository.js"
import { countConnectedMembers, listConnectionToolsForMember, listMemberConnections } from "./sources-repository.js"
import { createCheckGateModel } from "./check-gate.js"
import { createEvaluationModel } from "./evaluation-model.js"
import { createAgentSendCheck } from "./send-check.js"
import { readAgentTemplate } from "./template.js"
import { agentMessageId, agentMessageSessionId, agentSessionId, defaultAgentTurnDeps, endAgentMessageSession, runAgentSessionTurn, runAgentTurn } from "./turn.js"
import { wakeAgent, type AgentWakeOutcome } from "./wake.js"
import { AGENT_MESSAGE_SCOPES, wakeAgentBrief, type AgentBriefWakeDeps } from "./wake-brief.js"

const TICK_MS = 15_000
const MAX_CONCURRENT_WAKES = 4
const DISCOVERY_MS = 10 * 60_000
const LEDGER_RETENTION_MS = 30 * 24 * 3_600_000

export function defaultAgentWakeDeps(): AgentBriefWakeDeps {
  const turnDeps = defaultAgentTurnDeps()
  const evaluationModel = env.agentEvaluationApiKey ? createEvaluationModel({ apiKey: env.agentEvaluationApiKey }) : null
  const checkGateModel = evaluationModel ? createCheckGateModel(evaluationModel) : null
  const sendCheck = evaluationModel ? createAgentSendCheck(evaluationModel) : null
  return {
    now: Date.now,
    allowed: (organizationId, userId) => proactiveAllowed(organizationId, userId),
    settings: readProactiveSettings,
    template: readAgentTemplate,
    teamPolicy: async (member) => teamAgentPolicy(await resolveMemberTeamAgent(member)),
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
    recordCheck: recordMemberCheck,
    connections: listMemberConnections,
    connectedMembers: countConnectedMembers,
    connectLink: libraryConnectorLink,
    stoppedSources: async ({ organizationId, memberId, userId }) => {
      if (!(await agentStoppedSourcesAllowed(organizationId, userId))) return null
      markFeaturesUsed({ organizationId, memberId, keys: ["workbotAgentStoppedSources"] })
      return { link: myAgentLink() }
    },
    briefOn: (organizationId, userId) => agentBriefAllowed(organizationId, userId),
    person: memberFirstName,
    check: (input) => runAgentSessionTurn(input, turnDeps),
    message: (input) => runAgentSessionTurn({ ...input, title: "Your agent: message", readOnly: true, scopes: AGENT_MESSAGE_SCOPES }, turnDeps),
    messageSessionId: agentMessageSessionId,
    endMessageSession: (sessionId) => endAgentMessageSession(sessionId, turnDeps),
    conversation: (input) => readWorkbotDirectMessages({ organizationId: input.organizationId, userId: input.userId, since: input.since }),
    requestedChecks: readAgentCheckRequests,
    checkGate: async ({ organizationId, memberId, userId }) => {
      if (!(await agentCheckGateAllowed(organizationId, userId))) return null
      markFeaturesUsed({ organizationId, memberId, keys: ["workbotAgentCheckGate"] })
      return {
        mail: (input) => readMemberGmailArrivals({ organizationId, orgMembershipId: memberId, ...input }),
        model: checkGateModel,
      }
    },
    sendCheck: async ({ organizationId, memberId, userId }) => {
      if (!sendCheck || !(await agentSendCheckAllowed(organizationId, userId))) return null
      markFeaturesUsed({ organizationId, memberId, keys: ["workbotAgentSendCheck"] })
      return sendCheck
    },
    readTools: (input) => listConnectionToolsForMember({ organizationId: input.organizationId, memberId: input.memberId, connectionId: input.connection.id }),
  }
}

export async function wakeMemberAgent(row: AgentInstanceRow, deps: AgentBriefWakeDeps): Promise<AgentWakeOutcome> {
  const userId = await deps.user(row.organizationId, row.memberId).catch(() => null)
  const brief = userId ? await deps.briefOn(row.organizationId, userId).catch(() => false) : false
  return brief ? wakeAgentBrief(row, deps) : wakeAgent(row, deps)
}

export async function discoverAgents() {
  for (const candidate of await listAgentCandidates()) await ensureAgentInstances(candidate.organizationId, candidate.memberIds)
}

export function startWorkbotProactiveWorker(deps: AgentBriefWakeDeps = defaultAgentWakeDeps()) {
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
        void wakeMemberAgent(row, deps)
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
