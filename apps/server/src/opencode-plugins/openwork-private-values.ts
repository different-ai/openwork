import { z } from "zod";
import { refuseFillOnlyPrograms } from "./private-values-terminal.js";
import { OUTGOING, STORED, scrubPrivateValues } from "./private-values-filter.js";
import { privateValueToolOn, usePrivateValues, usePrivateValuesArgs, usePrivateValuesDescription, type PrivateValuesAsk } from "./private-values-tool.js";
import { uiBridgeRequest } from "./openwork-ui-bridge.js";

const callSchema = z.object({ sessionID: z.string().min(1), abort: z.instanceof(AbortSignal).optional(), directory: z.string().optional() });

const askDesktop: PrivateValuesAsk = (path, body, signal) => path === "use"
  ? uiBridgeRequest("/private/use", { method: "POST", body, signal, timeoutMs: null })
  : uiBridgeRequest("/private/state", { method: "POST", body, timeoutMs: 3_000 });

export const OpenWorkPrivateValues = async () => ({
  "experimental.chat.messages.transform": async (_input: unknown, output: { messages: unknown[] }) => {
    await scrubPrivateValues([output.messages], OUTGOING);
  },
  "experimental.chat.system.transform": async (_input: unknown, output: { system: string[] }) => {
    await scrubPrivateValues([output.system], OUTGOING);
  },
  "tool.execute.before": async (input: { tool: string }, output: { args: unknown }) => {
    await refuseFillOnlyPrograms(input.tool, output.args);
  },
  "tool.execute.after": async (_input: unknown, output: unknown) => {
    await scrubPrivateValues([output], STORED).catch(() => 0);
  },
  ...(await privateValueToolOn(askDesktop) ? { tool: { use_private_values: {
    description: usePrivateValuesDescription,
    args: usePrivateValuesArgs,
    async execute(raw: unknown, context: unknown) {
      const call = callSchema.safeParse(context);
      if (!call.success) return JSON.stringify({ ok: false, code: "missing_session", error: "Using a private value requires a requesting conversation." });
      return usePrivateValues(raw, { sessionId: call.data.sessionID, directory: call.data.directory, signal: call.data.abort }, askDesktop);
    },
  } } } : {}),
});
