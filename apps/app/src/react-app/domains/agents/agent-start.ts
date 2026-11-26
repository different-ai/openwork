import type { AutomationDetail } from "@openwork/types/automations";
import type {
  CreatePersonalAgent,
  CreatePersonalAgentRoutine,
  PersonalAgentDetail,
  PersonalAgentPendingChange,
  PersonalAgentProposal,
  PersonalAgentRunResponse,
} from "@openwork/types/den/personal-agents";

export type AgentStartApi = {
  createAgent: (input: CreatePersonalAgent) => Promise<PersonalAgentDetail>;
  createRoutine: (agentId: string, input: CreatePersonalAgentRoutine) => Promise<AutomationDetail | PersonalAgentPendingChange>;
  runNow: (agentId: string, routineId: string) => Promise<PersonalAgentRunResponse>;
};

export type AgentStartProgress = {
  agentId: string | null;
  agentName: string | null;
  routineId: string | null;
  routineName: string | null;
  firstRunId: string | null;
};

type AgentStartResult = AgentStartProgress & { pendingChange?: PersonalAgentPendingChange };

const starting = new Map<string, Promise<AgentStartResult>>();

export function startOnce(key: string, start: () => Promise<AgentStartResult>): Promise<AgentStartResult> {
  const running = starting.get(key);
  if (running) return running;
  const started = start().finally(() => starting.delete(key));
  starting.set(key, started);
  return started;
}

export async function agentProposalKey(sessionId: string, toolCallId: string): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify([sessionId, toolCallId]));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return `proposal-${Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export async function startAgentFromProposal(input: {
  api: AgentStartApi;
  proposal: PersonalAgentProposal;
  idempotencyKey?: string;
  linkChat?: (agentId: string) => Promise<unknown>;
  saved: AgentStartProgress;
  save: (progress: Partial<AgentStartProgress>) => void;
}): Promise<AgentStartResult> {
  const { api, proposal, save } = input;
  let progress = input.saved;
  const keep = (next: Partial<AgentStartProgress>) => {
    progress = { ...progress, ...next };
    save(next);
  };
  if (!progress.agentId) {
    const created = await api.createAgent({ name: proposal.name, brief: proposal.brief, never: proposal.never, connectorNames: proposal.connectorNames ?? [], idempotencyKey: input.idempotencyKey });
    keep({ agentId: created.agent.id, agentName: created.agent.name });
  }
  const agentId = progress.agentId;
  if (!agentId) return progress;
  if (!progress.routineId) {
    await input.linkChat?.(agentId);
    const routine = await api.createRoutine(agentId, proposal.routine);
    if ("request" in routine) return { ...progress, pendingChange: routine };
    keep({ routineId: routine.automation.id, routineName: routine.automation.name });
  }
  const routineId = progress.routineId;
  if (!routineId) return progress;
  if (!progress.firstRunId) {
    const started = await api.runNow(agentId, routineId);
    keep({ firstRunId: started.run.id });
  }
  return progress;
}
