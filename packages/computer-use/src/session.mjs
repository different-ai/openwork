import { randomUUID } from "node:crypto";

export class ComputerUseError extends Error {
  constructor(result) {
    super(typeof result.message === "string" ? result.message : "Computer Use could not finish the operation.");
    this.name = "ComputerUseError";
    this.code = result.code;
    this.next = result.next;
    this.result = result;
  }
}

/**
 * Small, provider-independent client for a persistent code-execution context.
 * callTool must use one dedicated MCP connection for this session. The native
 * helper owns consent and dispatch; this client has no OS or approval bypass.
 * No inference, API credentials, arbitrary evaluation or network access here.
 */
export async function openComputerSession({ callTool, appId, pid, purpose, mode = "observe", signal }) {
  if (typeof callTool !== "function") throw new TypeError("callTool is required.");
  let sessionId;
  let observation;
  let closed = false;
  let busy = false;
  const check = () => {
    signal?.throwIfAborted();
    if (closed) throw new Error("Computer Use session is closed.");
  };
  const invoke = async (name, args) => {
    check();
    const reply = await callTool(name, args, { signal });
    const content = reply?.content;
    if (!Array.isArray(content)) throw new Error("Computer Use returned no MCP content.");
    const item = content.find((part) => part.type === "text" && typeof part.text === "string");
    if (!item) throw new Error("Computer Use returned no state.");
    const state = JSON.parse(item.text);
    if (!state || typeof state !== "object" || reply.isError === true || state.ok !== true) {
      throw new ComputerUseError(state ?? {});
    }
    return { state, images: content.filter((part) => part.type === "image") };
  };
  const exclusive = async (work) => {
    check();
    if (busy) throw new Error("Computer Use operations must be sequential.");
    busy = true;
    try { return await work(); } finally { busy = false; }
  };
  const observe = async (includeImage = true) => {
    observation = undefined;
    const result = await invoke("computer_observe", { session_id: sessionId, include_image: includeImage });
    if (typeof result.state.observation_id !== "string") throw new Error("Computer Use returned no observation ID.");
    observation = result.state.observation_id;
    return result;
  };
  const close = async () => {
    if (closed) return;
    closed = true; observation = undefined;
    signal?.removeEventListener("abort", onAbort);
    // Cleanup deliberately does not inherit an already-aborted operation signal.
    await callTool("computer_close_session", { session_id: sessionId });
  };
  const onAbort = () => { void close().catch(() => {}); };
  const opened = await invoke("computer_open_session", {
    app_id: appId, mode, purpose, ...(pid === undefined ? {} : { pid }),
  });
  sessionId = opened.state.session_id;
  if (typeof sessionId !== "string") throw new Error("Computer Use returned no session ID.");
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) { await close(); signal.throwIfAborted(); }
  return {
    id: sessionId,
    state: opened.state,
    observe: (options = {}) => exclusive(() => observe(options.includeImage ?? true)),
    /** Dispatch once, then observe. Inspect the returned state to verify the intended outcome. */
    act: (action, options = {}) => exclusive(async () => {
      if (!observation) throw new Error("Observe before acting, including after any failed or interrupted action.");
      const observed = observation;
      observation = undefined;
      const receipt = await invoke("computer_act", {
        session_id: sessionId, observation_id: observed, request_id: randomUUID(), action,
      });
      try {
        return { receipt: receipt.state, ...await observe(options.includeImage ?? true) };
      } catch (error) {
        // Preserve the dispatch receipt when the subsequent observation fails.
        // Never repeat an action just because its follow-up image is unavailable.
        throw new ComputerUseError({ code: "observation_after_action_failed", message: "The action was dispatched, but its result could not be observed. Observe again; do not repeat it.", next: "observe", receipt: receipt.state, cause: error instanceof Error ? error.message : "Observation failed" });
      }
    }),
    status: () => exclusive(() => invoke("computer_session_status", { session_id: sessionId })),
    close,
    [Symbol.asyncDispose]: close,
  };
}
