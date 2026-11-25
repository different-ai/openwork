import { OUTGOING, STORED, createPrivateValueScrubber, plainCopy, redactThrough, scrubPrivateValues } from "./private-values-filter.js";
import { refuseFillOnlyPrograms, terminalBlockReply, type TerminalBlockRequest } from "./private-values-terminal.js";
import { USE_PRIVATE_VALUES, privateValueToolOn, usePrivateValues, usePrivateValuesArgs, usePrivateValuesDescription, type PrivateValuesAsk } from "./private-values-tool.js";
import { addProviderSafeTool } from "./provider-safe-tool-schema.js";
import { approvalLoopbackFetch } from "./approval-loopback-fetch.js";
import { z } from "zod";

type Registration = { dispose(): Promise<void> };
type ModelRequest = { system: unknown; messages: unknown };
type ToolFinished = { readonly status: "completed"; result: unknown } | { readonly status: "error" };
type ToolStarting = { readonly tool: string; readonly input: unknown };
type ToolCall = { signal: AbortSignal; sessionID: string };
type Tool = {
  name: string;
  description: string;
  input: Record<string, unknown>;
  options: { codemode: boolean };
  execute(input: unknown, call: ToolCall): Promise<{ content: { type: "text"; text: string }[] }>;
};
export type PrivateValuesContext = {
  readonly options?: { url?: unknown; token?: unknown };
  readonly location?: { directory?: string };
  readonly session: { hook(name: "context" | "compaction" | "generate" | "title", callback: (event: ModelRequest) => Promise<void>): Promise<Registration> };
  readonly tool: {
    hook(name: "execute.after", callback: (event: ToolFinished) => Promise<void>): Promise<Registration>;
    hook(name: "execute.before", callback: (event: ToolStarting) => Promise<void>): Promise<Registration>;
    transform?(callback: (editor: { add(tool: Tool): void }) => void): Promise<Registration>;
  };
};

export async function registerPrivateValues(context: PrivateValuesContext, scrub = scrubPrivateValues, terminal?: TerminalBlockRequest, ask?: PrivateValuesAsk) {
  const outgoing = async (event: ModelRequest) => {
    await scrub([event.system, event.messages], OUTGOING);
  };
  const registrations = [
    await context.session.hook("context", outgoing),
    await context.session.hook("compaction", outgoing),
    await context.session.hook("generate", outgoing),
    await context.session.hook("title", outgoing),
    await context.tool.hook("execute.before", (event) => refuseFillOnlyPrograms(event.tool, event.input, terminal ?? (async () => null))),
    await context.tool.hook("execute.after", async (event) => {
      if (event.status !== "completed") return;
      const copy = plainCopy(event.result);
      if (await scrub([copy], STORED).catch(() => 0)) event.result = copy;
    }),
  ];
  if (ask && context.tool.transform && await privateValueToolOn(ask)) {
    registrations.push(await context.tool.transform(editor => {
      addProviderSafeTool(editor, {
        name: USE_PRIVATE_VALUES, description: usePrivateValuesDescription,
        input: z.toJSONSchema(z.object(usePrivateValuesArgs)),
        options: { codemode: false },
        execute: async (input, call) => ({ content: [{ type: "text" as const,
          text: await usePrivateValues(input, { sessionId: call.sessionID, directory: context.location?.directory, signal: call.signal }, ask) }] }),
      });
    }));
  }
  return async () => {
    for (const registration of registrations) await registration.dispose();
  };
}

function terminalThrough({ url, token }: { url: string; token: string }): TerminalBlockRequest {
  const terminalUrl = new URL("terminal", url).href;
  return async () => {
    const response = await fetch(terminalUrl, {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ check: true }), signal: AbortSignal.timeout(10_000),
    });
    return response.ok ? terminalBlockReply(await response.json()) : null;
  };
}

function askThrough({ url, token }: { url: string; token: string }): PrivateValuesAsk {
  return async (path, body, signal) => {
    const request = { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) };
    const response = path === "use"
      ? await approvalLoopbackFetch(new URL(path, url).href, { ...request, redirect: "error", signal: signal ?? new AbortController().signal })
      : await fetch(new URL(path, url), { ...request, redirect: "error", signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw new Error(`Private values request failed (${response.status})`);
    return response.json();
  };
}

export default {
  id: "openwork.private-values",
  setup: (context: PrivateValuesContext) => {
    const { url, token } = context.options ?? {};
    return typeof url === "string" && typeof token === "string"
      ? registerPrivateValues(context, createPrivateValueScrubber(redactThrough({ url, token })), terminalThrough({ url, token }), askThrough({ url, token }))
      : registerPrivateValues(context);
  },
};
