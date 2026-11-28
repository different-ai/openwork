import { ComputerDenRequestError, ComputerQueueOff, computersConnecting } from "../den.js";
import { computerOutcomeUnknown, computerSendOutcomeUnknown, computerUnreachable } from "../messages.js";
import type { ComputerExecutor } from "./index.js";

export const queueExecutor: ComputerExecutor = {
  async run({ id, label, call, signal }, { queue }) {
    if (!queue) throw new Error(computersConnecting);
    if (signal.aborted) throw new Error(computerUnreachable(label));
    let outcome;
    try {
      outcome = await queue.enqueue(id, call, signal);
    } catch (error) {
      if (error instanceof ComputerQueueOff) throw error;
      if (error instanceof ComputerDenRequestError && !error.mayHaveQueued) throw new Error(computerUnreachable(label));
      throw new Error(computerSendOutcomeUnknown(label));
    }
    if (outcome.state === "running") {
      const deadline = Date.parse(outcome.expiresAt) + 15_000;
      const commandId = outcome.id;
      try {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error();
        const wait = AbortSignal.any([signal, AbortSignal.timeout(Math.min(remaining, 2_147_483_647))]);
        while (outcome.state === "running") {
          wait.throwIfAborted();
          outcome = await queue.follow(commandId, wait);
        }
      } catch { throw new Error(computerOutcomeUnknown(label, signal.aborted)); }
    }
    if (outcome.state === "failed") throw new Error(outcome.error.message);
    if (outcome.state !== "done") throw new Error(outcome.message);
    return { content: [{ type: "text", text: outcome.output }], metadata: { sandbox: true, truncated: outcome.truncated, exitCode: outcome.exitCode } };
  },
};
