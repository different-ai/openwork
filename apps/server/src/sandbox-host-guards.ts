export function sandboxHostRequest(method: string, path: string, engine: boolean): boolean {
  const decoded = decodeURIComponent(path);
  const write = !["GET", "HEAD", "OPTIONS"].includes(method);
  if (engine) {
    const route = decoded.replace(/^\/workspace\/[^/]+\/opencode2?/, "").replace(/^\/opencode2?/, "").replace(/^\/api(?=\/|$)/, "");
    if (/\/(?:shell|pty|persistent-pty|terminal|command|files?|find|lsp|vcs|worktrees?|mcp|plugins?|skills?)(?:\/|$)/.test(route)) return true;
    if (write) {
      const session = /^\/session(?:\/[^/]+(?:\/(?:prompt|model|agent|abort|interrupt|compact|fork))?)?\/?$/.test(route);
      const answer = /^\/(?:session\/[^/]+\/)?(?:permission|form|question)(?:\/[^/]+)?\/(?:reply|answer|reject)\/?$/.test(route);
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

export function sandboxPromptHasHostFiles(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(sandboxPromptHasHostFiles);
  return Object.entries(value).some(([key, entry]) =>
    (key === "type" && entry === "file") || (key === "url" && typeof entry === "string" && /^file:/i.test(entry)) || sandboxPromptHasHostFiles(entry));
}
