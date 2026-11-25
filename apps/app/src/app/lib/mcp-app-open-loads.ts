import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { canonicalMcpAppArguments, MCP_APP_CACHED_AT_META } from "./mcp-app-result-cache";

const READ_ONLY_RESULT_META = "openwork/readOnly";
const MAX_KEPT = 200;

type Call = { serverName: string; resourceUri: string; name: string; args: Record<string, unknown> };
type Kept = { at: string; result: CallToolResult };

const kept = new Map<string, Kept>();

export function forgetMcpAppOpenLoads(): void {
  kept.clear();
}

function keep(key: string, result: CallToolResult) {
  kept.delete(key);
  kept.set(key, { at: new Date().toISOString(), result });
  while (kept.size > MAX_KEPT) {
    const oldest = kept.keys().next().value;
    if (oldest === undefined) break;
    kept.delete(oldest);
  }
}

export function createMcpAppOpenLoads(openKey: string | undefined) {
  const current = new Map<string, Promise<{ result: CallToolResult; reused: boolean }>>();
  const settled = new Set<string>();
  const callKey = (call: Call) => JSON.stringify([call.serverName, call.resourceUri, call.name, canonicalMcpAppArguments(call.args)]);
  const keptKey = (key: string) => openKey === undefined ? undefined : JSON.stringify([openKey, key]);
  return {
    refresh() {
      for (const key of settled) {
        current.delete(key);
        const reuseKey = keptKey(key);
        if (reuseKey) kept.delete(reuseKey);
      }
      settled.clear();
    },
    async load(call: Call, run: () => Promise<CallToolResult>, recheck: (result: CallToolResult) => Promise<boolean>) {
      const key = callKey(call);
      const existing = current.get(key);
      if (existing) return await existing;
      const pending = (async () => {
        const reuseKey = keptKey(key);
        const previous = reuseKey ? kept.get(reuseKey) : undefined;
        if (reuseKey && previous) {
          if (await recheck(previous.result).catch(() => false)) {
            return { result: { ...previous.result, _meta: { ...previous.result._meta, [MCP_APP_CACHED_AT_META]: previous.at } }, reused: true };
          }
          kept.delete(reuseKey);
        }
        const result = await run();
        if (reuseKey && !result.isError && result._meta?.[READ_ONLY_RESULT_META] === true) keep(reuseKey, result);
        else if (reuseKey) kept.delete(reuseKey);
        return { result, reused: false };
      })();
      current.set(key, pending);
      const answered = () => { if (current.get(key) === pending) settled.add(key); };
      void pending.then(answered, answered);
      return await pending;
    },
    clicked(call: Call, result: CallToolResult) {
      const key = callKey(call);
      if (result.isError || result._meta?.[READ_ONLY_RESULT_META] !== true) return this.failed(call);
      current.set(key, Promise.resolve({ result, reused: false }));
      settled.add(key);
      const reuseKey = keptKey(key);
      if (reuseKey) keep(reuseKey, result);
    },
    failed(call: Call) {
      const reuseKey = keptKey(callKey(call));
      if (reuseKey) kept.delete(reuseKey);
    },
  };
}
