import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { canonicalMcpAppArguments, MCP_APP_CACHED_AT_META } from "./mcp-app-result-cache";

// Set by the OpenWork server, never by the App or provider.
const READ_ONLY_RESULT_META = "openwork/readOnly";
const MAX_KEPT = 200;

type Call = { serverName: string; resourceUri: string; name: string; args: Record<string, unknown> };
type Kept = { at: string; result: CallToolResult };

// An open's loads that succeeded, for a card that mounts again. Memory only.
const kept = new Map<string, Kept>();

function keep(key: string, result: CallToolResult) {
  kept.delete(key);
  kept.set(key, { at: new Date().toISOString(), result });
  while (kept.size > MAX_KEPT) {
    const oldest = kept.keys().next().value;
    if (oldest === undefined) break;
    kept.delete(oldest);
  }
}

/**
 * An App's loads: the calls it makes without a person's click, such as its
 * read-only data on open. Each runs at most once per open. A repeat from the
 * same App document gets the same answer, failures included, so a render loop
 * never calls the provider again. With an openKey, a card that mounts a new
 * document for the same open (re-rendered, or scrolled back into view) gets
 * the earlier answer too, once `recheck` confirms the call is still allowed.
 * Clicked calls always run.
 */
export function createMcpAppOpenLoads(openKey: string | undefined) {
  const current = new Map<string, Promise<{ result: CallToolResult; reused: boolean }>>();
  // Loads that have answered; a refresh lets these run again.
  const settled = new Set<string>();
  const callKey = (call: Call) => JSON.stringify([call.serverName, call.resourceUri, call.name, canonicalMcpAppArguments(call.args)]);
  const keptKey = (key: string) => openKey === undefined ? undefined : JSON.stringify([openKey, key]);
  return {
    /**
     * The host refreshed the open App, such as a dashboard delivering a new
     * launch result: each load that has answered may run once more. A load
     * still running is that refresh already, so a repeat joins it.
     */
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
    /**
     * A clicked call's answer replaces the open's earlier one, so a later load
     * or mount shows it. A failed one drops it: the provider may no longer
     * allow this person to read it.
     */
    clicked(call: Call, result: CallToolResult) {
      const key = callKey(call);
      if (result.isError || result._meta?.[READ_ONLY_RESULT_META] !== true) return this.failed(call);
      current.set(key, Promise.resolve({ result, reused: false }));
      settled.add(key);
      const reuseKey = keptKey(key);
      if (reuseKey) keep(reuseKey, result);
    },
    /** A call that threw or failed; a later mount of this open calls again. */
    failed(call: Call) {
      const reuseKey = keptKey(callKey(call));
      if (reuseKey) kept.delete(reuseKey);
    },
  };
}
