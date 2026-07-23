import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";

import {
  type PromptContributorProvenance,
  promptTraceId,
  resolvePromptDebugSetting,
  takePromptContributorProvenance,
} from "./openwork-debug-log.js";
import { readNestedString } from "./lib/records.js";

/**
 * Internal debug plugin: captures OpenCode's live system-array reference in
 * system.transform, then snapshots it from chat.params after every system
 * transform and OpenCode's post-hook normalization have completed.
 *
 * This intentionally does not rely on plugin order. Later project/account
 * plugins mutate the same array reference before chat.params runs. Provider
 * serialization after request preparation remains outside this no-fork seam.
 *
 * Exact prompt output is disabled by default. Desktop Developer Mode enables
 * metadata only; exact content requires OPENWORK_OBSERVABILITY=exact, the
 * legacy OPENWORK_PROMPT_LOG opt-in, or the separate desktop exact switch.
 */

const MAX_TRACKED_SESSIONS = 128;

type PromptContext = {
  agentKey: string;
  description: string;
  fingerprintKey: string;
  modelKey: string;
  sessionKey: string;
};

type PendingObservation = {
  blocks: string[];
  context: PromptContext;
  trace: string;
};

type PromptFingerprint = {
  hash: string;
  blocks: Array<{ chars: number; hash: string }>;
};

type ObservationContext = {
  pending?: PendingObservation;
};

type PromptObserverInput = {
  client?: {
    mcp?: {
      status?: (options?: unknown) => Promise<unknown>;
    };
  };
  directory?: string;
};

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function shortHash(value: string): string {
  return sha256(value).slice(0, 12);
}

/**
 * Preserve exact block text without allowing prompt-controlled terminal or log
 * framing bytes to execute. JSON handles C0 controls/newlines; escape the C1
 * range and Unicode line separators that JSON.stringify may leave literal.
 */
function terminalSafeJsonString(value: string): string {
  return JSON.stringify(value).replace(
    /[\u007f-\u009f\u200e\u200f\u2028-\u202e\u2066-\u2069]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

type PromptTextLocation = {
  finalBlock: number;
  start: number;
  end: number;
};

function locatePromptText(
  blocks: readonly string[],
  text: string,
  limit: number,
): { locations: PromptTextLocation[]; truncated: boolean } {
  const locations: PromptTextLocation[] = [];
  for (let blockIndex = 0; blockIndex < blocks.length; blockIndex += 1) {
    const block = blocks[blockIndex] ?? "";
    let offset = 0;
    while (offset <= block.length - text.length) {
      const start = block.indexOf(text, offset);
      if (start < 0) break;
      locations.push({
        finalBlock: blockIndex + 1,
        start,
        end: start + text.length,
      });
      if (locations.length >= limit) {
        return { locations, truncated: true };
      }
      offset = start + Math.max(text.length, 1);
    }
  }
  return { locations, truncated: false };
}

/**
 * Compare pre-normalization contributor strings with the final prepared
 * blocks. This proves textual correspondence only, not causal ownership: a
 * later plugin could replace text with an identical string. True origin tags
 * require an upstream request-scoped prepared-prompt hook.
 */
function logContributorProvenance(
  trace: string,
  blocks: readonly string[],
  provenance: readonly PromptContributorProvenance[],
): PromptTextLocation[] {
  const attributed: PromptTextLocation[] = [];
  if (!provenance.length) {
    console.error(
      `[openwork][agent-prompt] provenance trace=${trace} contributors=0 match=none`,
    );
    return attributed;
  }

  const byText = new Map<string, PromptContributorProvenance[]>();
  for (const entry of provenance) {
    const entries = byText.get(entry.text) ?? [];
    entries.push(entry);
    byText.set(entry.text, entries);
  }

  for (const [text, entries] of byText) {
    const located = locatePromptText(blocks, text, entries.length + 1);
    const exact = !located.truncated && located.locations.length === entries.length;
    entries.forEach((entry, index) => {
      const prefix = `[openwork][agent-prompt] provenance trace=${trace} contributor=${entry.contributorId} contributorHash=${entry.hash} chars=${entry.chars}`;
      if (exact) {
        const location = located.locations[index];
        if (location) {
          console.error(
            `${prefix} match=text-correspondence causalOrigin=unproven finalBlock=${location.finalBlock} start=${location.start} end=${location.end}`,
          );
          attributed.push(location);
          return;
        }
      }
      const match = located.locations.length === 0 ? "missing" : "ambiguous";
      console.error(
        `${prefix} match=${match} occurrences=${located.locations.length}${located.truncated ? " truncated=true" : ""}`,
      );
    });
  }
  return attributed;
}

function logUnattributedProvenance(
  trace: string,
  blocks: readonly string[],
  attributed: readonly PromptTextLocation[],
): void {
  for (let blockIndex = 0; blockIndex < blocks.length; blockIndex += 1) {
    const blockLength = blocks[blockIndex]?.length ?? 0;
    const spans = attributed
      .filter((location) => location.finalBlock === blockIndex + 1)
      .map((location) => ({ start: location.start, end: location.end }))
      .sort((left, right) => left.start - right.start || left.end - right.end);
    const merged: Array<{ start: number; end: number }> = [];
    for (const span of spans) {
      const previous = merged[merged.length - 1];
      if (previous && span.start <= previous.end) previous.end = Math.max(previous.end, span.end);
      else merged.push({ ...span });
    }
    let cursor = 0;
    for (const span of merged) {
      if (span.start > cursor) {
        console.error(
          `[openwork][agent-prompt] provenance trace=${trace} origin=unattributed classification=open-code-or-external-plugin finalBlock=${blockIndex + 1} start=${cursor} end=${span.start}`,
        );
      }
      cursor = Math.max(cursor, span.end);
    }
    if (cursor < blockLength || blockLength === 0) {
      console.error(
        `[openwork][agent-prompt] provenance trace=${trace} origin=unattributed classification=open-code-or-external-plugin finalBlock=${blockIndex + 1} start=${cursor} end=${blockLength}`,
      );
    }
  }
}

function describeFingerprintDelta(
  previous: PromptFingerprint | undefined,
  current: PromptFingerprint,
): string {
  if (!previous) return "previousHash=none delta=initial";
  if (previous.hash === current.hash) return `previousHash=${previous.hash} delta=none`;
  const shared = Math.min(previous.blocks.length, current.blocks.length);
  const changed: number[] = [];
  for (let index = 0; index < shared; index += 1) {
    if (previous.blocks[index]?.hash !== current.blocks[index]?.hash) changed.push(index + 1);
  }
  const rendered = changed.slice(0, 64).join(",") || "none";
  return `previousHash=${previous.hash} delta=changed addedBlocks=${Math.max(0, current.blocks.length - previous.blocks.length)} removedBlocks=${Math.max(0, previous.blocks.length - current.blocks.length)} changedBlocks=${rendered}${changed.length > 64 ? " changedBlocksTruncated=true" : ""}`;
}

function describeContext(input: unknown): PromptContext {
  const agent = readNestedString(input, ["agent"]) ?? readNestedString(input, ["context", "agent"]);
  const sessionID =
    readNestedString(input, ["sessionID"])
    ?? readNestedString(input, ["session", "id"])
    ?? readNestedString(input, ["context", "sessionID"]);
  const provider = readNestedString(input, ["model", "providerID"])
    ?? readNestedString(input, ["provider"]);
  const model = readNestedString(input, ["model", "modelID"])
    ?? readNestedString(input, ["model", "id"])
    ?? readNestedString(input, ["modelID"]);
  const parts = [
    agent ? `agentHash=${shortHash(agent)}` : null,
    model ? `modelHash=${shortHash(provider ? `${provider}/${model}` : model)}` : null,
    sessionID ? `sessionHash=${shortHash(sessionID)}` : null,
  ].filter((part): part is string => part !== null);
  return {
    agentKey: agent ? shortHash(agent) : "unscoped",
    description: parts.length ? ` (${parts.join(", ")})` : "",
    fingerprintKey: [
      sessionID ? shortHash(sessionID) : "unscoped",
      agent ? shortHash(agent) : "unscoped",
      model ? shortHash(provider ? `${provider}/${model}` : model) : "unscoped",
    ].join(":"),
    modelKey: model ? shortHash(provider ? `${provider}/${model}` : model) : "unscoped",
    sessionKey: sessionID ? shortHash(sessionID) : "unscoped",
  };
}

function contextsAgree(pending: PromptContext, current: PromptContext): boolean {
  const sameWhenScoped = (left: string, right: string) =>
    left === "unscoped" || right === "unscoped" || left === right;
  return sameWhenScoped(pending.sessionKey, current.sessionKey)
    && sameWhenScoped(pending.agentKey, current.agentKey)
    && sameWhenScoped(pending.modelKey, current.modelKey);
}

function readMcpStatuses(response: unknown): Record<string, unknown> | null {
  if (!response || typeof response !== "object") return null;
  const record = response as Record<string, unknown>;
  const data = record.data;
  if (data && typeof data === "object" && !Array.isArray(data)) {
    return data as Record<string, unknown>;
  }
  // Test/adaptor clients may already unwrap the SDK response.
  if (!("error" in record) && !("response" in record)) return record;
  return null;
}

function mcpStatusName(value: unknown): string {
  if (!value || typeof value !== "object") return "unknown";
  const status = (value as Record<string, unknown>).status;
  return typeof status === "string" && /^[a-z_]{1,32}$/.test(status)
    ? status
    : "unknown";
}

function mcpServerLabel(value: string): string {
  const bounded = value.length <= 128 ? value : `${value.slice(0, 127)}…`;
  return terminalSafeJsonString(bounded);
}

function mcpFailureClass(value: unknown): "auth" | "timeout" | "transport" | "protocol" | "unknown" | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const nestedError = record.error;
  const raw = typeof nestedError === "string"
    ? nestedError
    : nestedError && typeof nestedError === "object" && typeof (nestedError as Record<string, unknown>).message === "string"
      ? String((nestedError as Record<string, unknown>).message)
      : typeof record.message === "string"
        ? record.message
        : "";
  if (!raw) return null;
  const normalized = raw.toLowerCase();
  if (/auth|oauth|unauthor|forbidden|credential|token|sign.?in/.test(normalized)) return "auth";
  if (/timeout|timed out|deadline|abort/.test(normalized)) return "timeout";
  if (/tls|certificate|cert\b|network|fetch|socket|connect|dns|econn/.test(normalized)) return "transport";
  if (/json.?rpc|protocol|parse|schema|invalid response/.test(normalized)) return "protocol";
  return "unknown";
}

export const OpenWorkPromptLog = async (pluginInput: PromptObserverInput = {}) => {
  const setting = resolvePromptDebugSetting();
  const sessionFingerprints = new Map<string, PromptFingerprint>();
  const observationContext = new AsyncLocalStorage<ObservationContext>();
  const mcpStatuses = new Map<string, { status: string; failureClass: string | null }>();
  let mcpProbeInFlight: Promise<void> | null = null;
  let mcpProbeUnavailable = false;

  const observeMcpStatuses = (trigger: "prompt" | "event"): Promise<void> => {
    if (!setting.enabled) return Promise.resolve();
    if (typeof pluginInput.client?.mcp?.status !== "function") {
      if (!mcpProbeUnavailable) {
        console.error(
          `[openwork][mcp-status] trigger=${trigger} status=unavailable reason=client-status-method-missing`,
        );
      }
      mcpProbeUnavailable = true;
      return Promise.resolve();
    }
    if (mcpProbeInFlight) {
      // Prompt-time sampling may already be running when an MCP lifecycle
      // event arrives. Queue one fresh event sample after it so a close/fail
      // transition is not hidden by the earlier snapshot.
      return trigger === "event"
        ? mcpProbeInFlight.then(() => observeMcpStatuses("event"))
        : mcpProbeInFlight;
    }
    mcpProbeInFlight = (async () => {
      try {
        const directory = typeof pluginInput.directory === "string" && pluginInput.directory.trim()
          ? pluginInput.directory.trim()
          : undefined;
        const response = await pluginInput.client!.mcp!.status!(
          directory ? { query: { directory } } : undefined,
        );
        const statuses = readMcpStatuses(response);
        if (!statuses) throw new Error("unavailable");
        const next = new Map<string, { status: string; failureClass: string | null }>();
        const entries = Object.entries(statuses)
          .map(([name, value]) => {
            const status = mcpStatusName(value);
            return {
              name,
              server: mcpServerLabel(name),
              serverHash: shortHash(name),
              status,
              failureClass: status === "needs_auth" || status === "needs_client_registration"
                ? "auth" as const
                : status === "failed" ? mcpFailureClass(value) : null,
            };
          })
          .sort((left, right) => left.name.localeCompare(right.name))
          .slice(0, 128);
        for (const entry of entries) {
          next.set(entry.name, { status: entry.status, failureClass: entry.failureClass });
          const previous = mcpStatuses.get(entry.name);
          if (
            previous?.status === entry.status
            && previous.failureClass === entry.failureClass
            && !mcpProbeUnavailable
          ) continue;
          console.error(
            `[openwork][mcp-status] trigger=${trigger} server=${entry.server} serverHash=${entry.serverHash} previous=${previous?.status ?? "unobserved"}${previous?.failureClass ? ` previousFailureClass=${previous.failureClass}` : ""} status=${entry.status}${entry.failureClass ? ` failureClass=${entry.failureClass}` : ""}`,
          );
        }
        for (const [name, previous] of mcpStatuses) {
          if (next.has(name)) continue;
          console.error(
            `[openwork][mcp-status] trigger=${trigger} server=${mcpServerLabel(name)} serverHash=${shortHash(name)} previous=${previous.status}${previous.failureClass ? ` previousFailureClass=${previous.failureClass}` : ""} status=removed`,
          );
        }
        if (Object.keys(statuses).length > entries.length) {
          console.error(
            `[openwork][mcp-status] trigger=${trigger} status=truncated observed=${entries.length} total=${Object.keys(statuses).length}`,
          );
        }
        mcpStatuses.clear();
        for (const [name, status] of next) mcpStatuses.set(name, status);
        mcpProbeUnavailable = false;
      } catch {
        if (!mcpProbeUnavailable) {
          console.error(
            `[openwork][mcp-status] trigger=${trigger} status=unavailable reason=status-request-failed`,
          );
        }
        mcpProbeUnavailable = true;
      } finally {
        mcpProbeInFlight = null;
      }
    })();
    return mcpProbeInFlight;
  };

  // This record intentionally contains no environment values, session IDs, or
  // prompt content. It proves that the observer plugin was instantiated even
  // when raw prompt logging is off.
  console.error(
    `[openwork][agent-prompt] observer initialized: at=${new Date().toISOString()}, level=${setting.level}, enabled=${setting.enabled}, exact=${setting.exact}, source=${setting.source}`,
  );

  return {
    "experimental.chat.system.transform": async (input: unknown, output: { system: string[] }) => {
      if (!setting.enabled) return;
      observeMcpStatuses("prompt");
      const context = describeContext(input);
      // OpenCode can prepare more than one model request for the same session
      // at once (for example, first-turn title generation and the main chat).
      // Request-local async context is therefore the only safe correlation
      // seam between system.transform and chat.params; a session-keyed queue
      // can cross-pair those two requests under interleaving.
      observationContext.enterWith({
        pending: {
          // Keep the exact array reference: later system hooks and OpenCode's
          // post-hook normalization mutate this object before chat.params.
          blocks: output.system,
          context,
          trace: promptTraceId(input),
        },
      });
    },
    "chat.params": async (input: unknown) => {
      if (!setting.enabled) return;
      const paramsContext = describeContext(input);
      const store = observationContext.getStore();
      const pending = store?.pending;
      // Release the exact array reference as soon as it has been consumed. The
      // async store itself may live until request completion, but no prompt
      // content remains reachable from it after this point.
      if (store) delete store.pending;
      if (!pending) {
        console.error(
          `[openwork][agent-prompt] observed system array unavailable${paramsContext.description}: reason=missing-system-transform-correlation`,
        );
        return;
      }
      if (!contextsAgree(pending.context, paramsContext)) {
        takePromptContributorProvenance(pending.trace);
        console.error(
          `[openwork][agent-prompt] observed system array unavailable${paramsContext.description}: trace=${pending.trace}, reason=request-context-mismatch`,
        );
        return;
      }

      const blocks = [...pending.blocks];
      const fingerprint: PromptFingerprint = {
        hash: sha256(JSON.stringify(blocks)),
        blocks: blocks.map((block) => ({ chars: block.length, hash: sha256(block) })),
      };
      const hash = fingerprint.hash;
      const context = paramsContext.sessionKey === "unscoped" ? pending.context : paramsContext;
      const previous = sessionFingerprints.get(context.fingerprintKey);

      // Refresh insertion order on every observation so the bound behaves as a
      // small LRU and active sessions remain attributable.
      if (previous !== undefined) sessionFingerprints.delete(context.fingerprintKey);
      sessionFingerprints.set(context.fingerprintKey, fingerprint);
      while (sessionFingerprints.size > MAX_TRACKED_SESSIONS) {
        const oldest = sessionFingerprints.keys().next().value;
        if (oldest === undefined) break;
        sessionFingerprints.delete(oldest);
      }

      const status = previous?.hash === hash ? "unchanged" : "changed";
      const observedAt = new Date().toISOString();
      const requestID = readNestedString(input, ["message", "id"]);
      const request = requestID ? shortHash(requestID) : "unknown";
      const chars = blocks.reduce((total, block) => total + block.length, 0);
      console.error(
        `[openwork][agent-prompt] observed system array ${status}${context.description}: trace=${pending.trace}, request=${request}, baselineScope=${shortHash(context.fingerprintKey)}, at=${observedAt}, boundary=post-system-hooks, blocks=${blocks.length}, chars=${chars}, hash=${hash}, ${describeFingerprintDelta(previous, fingerprint)}`,
      );
      const provenance = takePromptContributorProvenance(pending.trace);
      if (!setting.exact) {
        console.error(
          `[openwork][agent-prompt] provenance trace=${pending.trace} match=unavailable reason=exact-provenance-disabled`,
        );
        return;
      }
      const attributed = logContributorProvenance(pending.trace, blocks, provenance);
      logUnattributedProvenance(pending.trace, blocks, attributed);

      const lines: string[] = [
        `[openwork][agent-prompt] ===== BEGIN OBSERVED SYSTEM ARRAY (trace ${pending.trace}, hash ${hash}, boundary post-system-hooks) =====`,
      ];
      blocks.forEach((block, index) => {
        lines.push(
          `[openwork][agent-prompt] ----- block ${index + 1}/${blocks.length} (${block.length} chars, sha256 ${sha256(block)}, encoding json-string) -----`,
        );
        lines.push(terminalSafeJsonString(block));
      });
      lines.push(`[openwork][agent-prompt] ===== END OBSERVED SYSTEM ARRAY (trace ${pending.trace}, hash ${hash}) =====`);
      console.error(lines.join("\n"));
    },
    "event": async (input: unknown) => {
      const type = readNestedString(input, ["event", "type"]);
      if (!setting.enabled) return;
      if (type === "mcp.tools.changed") {
        const name = readNestedString(input, ["event", "properties", "server"]);
        if (name) {
          console.error(
            `[openwork][mcp-status] trigger=event server=${mcpServerLabel(name)} serverHash=${shortHash(name)} status=tools-changed`,
          );
        }
        // OpenCode publishes this after MCP state already exists (including
        // connection-close failures), so this is a passive state read rather
        // than startup/background polling.
        await observeMcpStatuses("event");
      }
      if (type === "mcp.browser.open.failed") {
        const name = readNestedString(input, ["event", "properties", "mcpName"]);
        if (name) {
          console.error(
            `[openwork][mcp-status] trigger=event server=${mcpServerLabel(name)} serverHash=${shortHash(name)} status=failed failureClass=unknown`,
          );
        }
        await observeMcpStatuses("event");
      }
    },
  };
};
