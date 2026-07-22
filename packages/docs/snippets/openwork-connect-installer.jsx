export const OpenWorkConnectInstaller = () => {
  const MCP_SERVER_URL = "https://api.openworklabs.com/mcp/agent";
  const CODEX_CONNECTIONS_DEEPLINK = "codex://settings/connections";
  const CHATGPT_SETTINGS_URL = "https://chatgpt.com/#settings/Connectors";
  const CODEX_LOGIN_COMMAND = "codex mcp login openwork";
  const CODEX_RECONNECT_COMMAND = `codex mcp logout openwork
codex mcp login openwork`;
  const OPENCODE_AUTH_COMMAND = "opencode mcp auth openwork";
  const OPENCODE_RECONNECT_COMMAND = `opencode mcp logout openwork
opencode mcp auth openwork`;
  const installs = [
    {
      id: "cursor",
      label: "Cursor",
      eyebrow: "Cursor Web/Agents HTTPS callback",
      helper: "Setup-only for Cursor Web/Agents with its HTTPS OAuth callback. Cursor Desktop OAuth uses cursor://anysphere.cursor-mcp/oauth/callback, which OpenWork's MCP profile intentionally rejects.",
      supportStatus: "Setup only",
      supportExplanation: "Setup guide only: use Cursor Web/Agents with its HTTPS OAuth callback. Cursor Desktop OAuth uses cursor://anysphere.cursor-mcp/oauth/callback, which OpenWork's MCP profile intentionally rejects.",
      copyText: MCP_SERVER_URL,
    },
    {
      id: "codex",
      label: "Codex",
      eyebrow: "Codex desktop, CLI, and IDE",
      helper: "Add OpenWork once, then sign in with Codex's MCP login command.",
      supportStatus: "Setup only",
      supportExplanation: "Setup guide only: add OpenWork, run codex mcp login openwork, and reconnect with logout then login. Native proof must be rerun on this exact branch.",
      copyText: `codex mcp add openwork --url ${MCP_SERVER_URL}`,
      authText: CODEX_LOGIN_COMMAND,
      reconnectText: CODEX_RECONNECT_COMMAND,
    },
    {
      id: "chatgpt-desktop",
      label: "ChatGPT Desktop",
      eyebrow: "Guided desktop setup",
      helper: "Open ChatGPT Settings > MCP servers, paste this URL, then start OAuth from ChatGPT's connection prompt.",
      supportStatus: "Setup only",
      supportExplanation: "Setup guide only: paste the URL in ChatGPT Settings > MCP servers and start OAuth there. Native proof is not complete.",
      copyText: MCP_SERVER_URL,
    },
    {
      id: "claude-code",
      label: "Claude Code",
      eyebrow: "One terminal command",
      helper: "Add the remote HTTP server, then use /mcp in Claude Code and follow the client auth flow.",
      supportStatus: "Setup only",
      supportExplanation: "Setup guide only: add the server, then use /mcp in Claude Code to run the client auth flow. Native proof is not complete.",
      copyText: `claude mcp add --transport http openwork ${MCP_SERVER_URL}`,
    },
    {
      id: "opencode",
      label: "OpenCode",
      eyebrow: "opencode.json MCP config",
      helper: "Add this remote MCP server entry to your OpenCode config, then authenticate.",
      supportStatus: "Verified",
      supportExplanation: "Verified with OpenCode native remote MCP OAuth flow.",
      copyText: `{
  "mcp": {
    "openwork": {
      "type": "remote",
      "enabled": true,
      "url": "${MCP_SERVER_URL}",
      "oauth": {}
    }
  }
}`,
      authText: OPENCODE_AUTH_COMMAND,
      reconnectText: OPENCODE_RECONNECT_COMMAND,
    },
    {
      id: "vs-code",
      label: "VS Code",
      eyebrow: "VS Code MCP command",
      helper: "Run this from a shell with the VS Code CLI on your path, then start OAuth from VS Code's MCP server prompt.",
      supportStatus: "Setup only",
      supportExplanation: "Setup guide only: add the server with the VS Code CLI, then start OAuth from VS Code's MCP server prompt. Native proof is not complete.",
      copyText: `code --add-mcp '{"name":"openwork","type":"http","url":"${MCP_SERVER_URL}"}'`,
    },
    {
      id: "any-client",
      label: "Any client",
      eyebrow: "Bring your own MCP client",
      helper: "Paste this URL only into clients that support remote Streamable HTTP MCP servers and OAuth.",
      supportStatus: "Setup only",
      supportExplanation: "Setup guide only: use clients that support remote Streamable HTTP MCP servers and OAuth. Native proof depends on the client.",
      copyText: MCP_SERVER_URL,
    },
  ];
  const clientFromHash = () => {
    if (typeof window === "undefined") return "cursor";
    const requested = window.location.hash.slice(1).replace("connect-mcp-install-", "");
    return installs.some((install) => install.id === requested) ? requested : "cursor";
  };
  const copyText = async (value) => {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {
      const textarea = document.createElement("textarea");
      textarea.value = value;
      textarea.setAttribute("readonly", "");
      textarea.style.cssText = "position:absolute;left:-9999px;top:-9999px";
      document.body.appendChild(textarea);
      textarea.select();
      const didCopy = document.execCommand("copy");
      textarea.remove();
      return didCopy;
    }
  };
  const [activeClient, setActiveClient] = useState(clientFromHash);
  const [copied, setCopied] = useState("");
  const activeInstall = installs.find((install) => install.id === activeClient) || installs[0];

  useEffect(() => {
    const selectHashClient = () => setActiveClient(clientFromHash());
    window.addEventListener("hashchange", selectHashClient);
    selectHashClient();
    return () => window.removeEventListener("hashchange", selectHashClient);
  }, []);

  const copy = async (id, value) => {
    const didCopy = await copyText(value);
    setCopied(didCopy ? id : "error");
    window.setTimeout(() => setCopied(""), 2500);
  };

  return (
    <div id="connect-mcp-install" className="not-prose my-8 overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm dark:border-white/10 dark:bg-gray-950">
      <div className="border-b border-gray-100 px-5 py-5 dark:border-white/10">
        <div className="text-sm text-gray-600 dark:text-gray-300">
          Developers: point your own agent at your org — verified clients and setup guides.
        </div>
        <div className="mt-1 text-xs text-gray-400">
          Verified for OpenCode only; setup guides for Codex, Cursor, ChatGPT, Claude Code, VS Code, and more
        </div>
      </div>

      <div className="overflow-x-auto border-b border-gray-100 px-4 pt-4 dark:border-white/10" role="tablist" aria-label="OpenWork MCP client install options">
        <div className="flex min-w-max gap-1">
          {installs.map((install) => (
            <button
              key={install.id}
              id={`connect-mcp-install-${install.id}`}
              type="button"
              role="tab"
              aria-selected={install.id === activeClient}
              aria-controls={`connect-mcp-panel-${install.id}`}
              onClick={() => {
                setActiveClient(install.id);
                window.history.replaceState(null, "", `#connect-mcp-install-${install.id}`);
              }}
              className={`rounded-t-lg border-b-2 px-3 py-2 text-sm font-medium ${install.id === activeClient ? "border-gray-950 text-gray-950 dark:border-white dark:text-white" : "border-transparent text-gray-500 hover:text-gray-900 dark:hover:text-white"}`}
            >
              {install.label}
            </button>
          ))}
        </div>
      </div>

      <div id={`connect-mcp-panel-${activeInstall.id}`} role="tabpanel" aria-labelledby={`connect-mcp-install-${activeInstall.id}`} className="p-5">
        <p className="m-0 text-xs font-semibold uppercase tracking-wider text-gray-400">{activeInstall.eyebrow}</p>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h3 className="mb-0 mt-2 text-xl font-semibold text-gray-950 dark:text-white">{activeInstall.label}</h3>
            <p className="mb-4 mt-1 text-sm text-gray-500 dark:text-gray-400">{activeInstall.helper}</p>
          </div>
          {activeInstall.id === "codex" ? (
            <a href={CODEX_CONNECTIONS_DEEPLINK} onClick={() => void copyText(MCP_SERVER_URL)} className="shrink-0 rounded-full bg-[#011627] px-5 py-2.5 text-sm font-medium text-white">
              Open settings + copy URL
            </a>
          ) : activeInstall.id === "chatgpt-desktop" ? (
            <a href={CHATGPT_SETTINGS_URL} target="_blank" rel="noreferrer" onClick={() => copy("chatgpt-url", MCP_SERVER_URL)} className="shrink-0 rounded-full bg-[#011627] px-5 py-2.5 text-sm font-medium text-white">
              {copied === "chatgpt-url" ? "Copied URL" : "Open settings + copy URL"}
            </a>
          ) : null}
        </div>
        <div className="mb-4 mt-2 flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-2">
          <span className={`w-fit rounded-full border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wider ${activeInstall.supportStatus === "Verified" ? "border-green-200 bg-green-50 text-green-700" : "border-amber-200 bg-amber-50 text-amber-700"}`}>{activeInstall.supportStatus}</span>
          <span className="text-xs text-gray-500 dark:text-gray-400">{activeInstall.supportExplanation}</span>
        </div>
        <pre className="m-0 max-h-80 overflow-auto whitespace-pre-wrap rounded-xl bg-[#011627] p-4 text-xs leading-6 text-white"><code>{activeInstall.copyText}</code></pre>
        {activeInstall.id === "any-client" ? (
          <p className="mb-0 mt-3 text-sm text-gray-500 dark:text-gray-400">Use this URL only with MCP clients that support remote Streamable HTTP servers with OAuth.</p>
        ) : null}
        {activeInstall.authText ? (
          <div className="mt-3">
            <p className="mb-1.5 mt-0 text-xs font-semibold uppercase tracking-wider text-gray-400">Authenticate</p>
            <pre className="m-0 overflow-auto whitespace-pre-wrap rounded-xl bg-[#011627] p-4 text-xs leading-6 text-white"><code>{activeInstall.authText}</code></pre>
          </div>
        ) : null}
        {activeInstall.reconnectText ? (
          <div className="mt-3">
            <p className="mb-1.5 mt-0 text-xs font-semibold uppercase tracking-wider text-gray-400">Reconnect or switch org</p>
            <pre className="m-0 overflow-auto whitespace-pre-wrap rounded-xl bg-[#011627] p-4 text-xs leading-6 text-white"><code>{activeInstall.reconnectText}</code></pre>
          </div>
        ) : null}
        <div className="mt-4 flex items-center justify-between gap-3">
          <p className="m-0 text-xs text-gray-500">Works with your OpenWork account — <a href="https://app.openworklabs.com?mode=sign-up" className="font-medium underline">create one free</a>.</p>
          <button type="button" aria-label="Copy the OpenWork MCP install command" onClick={() => copy(activeInstall.id, activeInstall.copyText)} className="shrink-0 rounded-lg bg-[#011627] px-4 py-2 text-xs font-medium text-white">
            {copied === activeInstall.id ? "Copied" : copied === "error" ? "Couldn't copy" : "Copy"}
          </button>
        </div>
      </div>

      <div className="flex flex-col gap-2 border-t border-gray-100 px-5 py-4 text-xs sm:flex-row sm:items-center sm:justify-between dark:border-white/10">
        <span className="font-semibold uppercase tracking-wider text-gray-400">Server URL</span>
        <div className="flex min-w-0 items-center gap-2">
          <code className="break-all text-gray-950 dark:text-white">{MCP_SERVER_URL}</code>
          <button type="button" aria-label="Copy the OpenWork MCP server URL" onClick={() => copy("server-url", MCP_SERVER_URL)} className="shrink-0 font-medium underline">
            {copied === "server-url" ? "Copied" : "Copy URL"}
          </button>
        </div>
      </div>
    </div>
  );
};
