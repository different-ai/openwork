type CompletionStorage = Pick<Storage, "getItem" | "setItem">;
const COMPLETED_RUN_KEY = "openwork.analytics.hasCompletedRun";

type Run = {
  model: { providerId: string; modelId: string } | undefined;
  startedAt: number;
  firstOutputAt: number | null;
  toolIds: Set<string>;
  permissionIds: Set<string>;
};

export function createRunQualityTracker(storage: () => CompletionStorage | undefined, now = () => Date.now()) {
  const runs = new Map<string, Run>();
  const stopping = new Set<string>();
  let completedInMemory = false;
  const isFirstRun = () => {
    try {
      return !completedInMemory && storage()?.getItem(COMPLETED_RUN_KEY) !== "1";
    } catch {
      return !completedInMemory;
    }
  };
  const properties = (sessionId: string) => {
    const run = runs.get(sessionId);
    return {
      is_first_run_on_install: isFirstRun(),
      duration_ms: run ? Math.max(0, now() - run.startedAt) : null,
      time_to_first_output_ms: run?.firstOutputAt == null ? null : Math.max(0, run.firstOutputAt - run.startedAt),
      tool_call_count: run?.toolIds.size ?? 0,
      permission_prompt_count: run?.permissionIds.size ?? 0,
    };
  };
  return {
    isFirstRun,
    isStopping: (sessionId: string) => stopping.has(sessionId),
    stopping(sessionId: string, active: boolean) {
      if (active) stopping.add(sessionId);
      else stopping.delete(sessionId);
    },
    model: (sessionId: string) => runs.get(sessionId)?.model,
    start(sessionId: string, model?: { providerID: string; modelID: string } | null) {
      if (sessionId.trim()) runs.set(sessionId, {
        model: model ? { providerId: model.providerID, modelId: model.modelID } : undefined,
        startedAt: now(), firstOutputAt: null, toolIds: new Set(), permissionIds: new Set(),
      });
    },
    output(sessionId: string) {
      const run = runs.get(sessionId);
      if (!run || run.firstOutputAt !== null) return false;
      run.firstOutputAt = now();
      return true;
    },
    tool(sessionId: string, id: string) { runs.get(sessionId)?.toolIds.add(id); },
    permission(sessionId: string, id: string) { runs.get(sessionId)?.permissionIds.add(id); },
    properties,
    finish(sessionId: string, completed = false) {
      const result = properties(sessionId);
      runs.delete(sessionId);
      stopping.delete(sessionId);
      if (completed) {
        completedInMemory = true;
        try { storage()?.setItem(COMPLETED_RUN_KEY, "1"); } catch {  }
      }
      return result;
    },
  };
}
