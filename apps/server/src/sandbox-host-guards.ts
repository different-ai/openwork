/** HTTP surfaces that bypass native tool execution. Keep the required-mode
 * supported surface deliberately small: inference/session metadata stay native,
 * alternate execution and host-file transports do not. */
export function sandboxHostRequest(method: string, path: string, engine: boolean): boolean {
  const decoded = decodeURIComponent(path);
  const write = !["GET", "HEAD", "OPTIONS"].includes(method);
  if (engine) {
    const route = decoded.replace(/^\/workspace\/[^/]+\/opencode2?/, "").replace(/^\/opencode2?/, "").replace(/^\/api(?=\/|$)/, "");
    if (/\/(?:shell|pty|persistent-pty|terminal|command|files?|find|lsp|vcs|worktrees?|mcp|plugins?|skills?)(?:\/|$)/.test(route)) return true;
    // Native inference, including Claude Agent's registry tools[], stays on
    // the session API. No blanket provider/agent ban. Unrecognized mutation
    // APIs (RPCs, terminals and extension entry points) are not admitted.
    if (write) {
      const session = /^\/session(?:\/[^/]+(?:\/(?:prompt|model|agent|abort|interrupt|compact|fork))?)?\/?$/.test(route);
      const answer = /^\/(?:session\/[^/]+\/)?(?:permission|form|question)(?:\/[^/]+)?\/(?:reply|answer|reject)\/?$/.test(route);
      // The app refreshes this text-only, in-memory session context before
      // sending a prompt. It is not an execution or host-file transport.
      // assertRequest still rejects file attachments in every session mutation.
      const context = method === "PUT" && /^\/experimental\/session\/[^/]+\/instructions\/entries\/openwork-context\/?$/.test(route);
      if (!session && !answer && !context) return true;
    }
    return false;
  }
  if (/^\/(?:cloud-computer|files)(?:\/|$)/.test(decoded)) return true;
  if (/^\/mcp\/managed(?:\/|$)/.test(decoded)) return true;
  if (/^\/experimental\/(?:extensions|drive-files)\/call\/?$/.test(decoded)) return true;
  if (/^\/workspace\/[^/]+\/(?:files?|inbox|artifacts|operations?|export|mcp-apps|mcp|claude-import|opencode-import|diagnostics)(?:\/|$)/.test(decoded)) return true;
  if (write && /^\/workspace\/[^/]+\/(?:config|opencode-config|runtime-config|plugins?|skills?|commands?)(?:\/|$)/.test(decoded)) return true;
  return false;
}

/** File attachments are read by the engine before a native tool hook runs. */
export function sandboxPromptHasHostFiles(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(sandboxPromptHasHostFiles);
  return Object.entries(value).some(([key, entry]) =>
    (key === "type" && entry === "file") || (key === "url" && typeof entry === "string" && /^file:/i.test(entry)) || sandboxPromptHasHostFiles(entry));
}
