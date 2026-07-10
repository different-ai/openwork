export const OpenWorkConnectInstaller = () => {
  const MCP_SERVER_URL = "https://api.openworklabs.com/mcp/agent";
  const CURSOR_DEEPLINK = "https://cursor.com/en/install-mcp?name=openwork&config=eyJ1cmwiOiJodHRwczovL2FwaS5vcGVud29ya2xhYnMuY29tL21jcC9hZ2VudCJ9";
  const CODEX_CONNECTIONS_DEEPLINK = "codex://settings/connections";
  const installs = [
    {
      id: "cursor",
      label: "Cursor",
      eyebrow: "One-click install or ~/.cursor/mcp.json",
      helper: "Use the one-click button, or paste this into ~/.cursor/mcp.json.",
      copyText: `{
  "mcpServers": {
    "openwork": {
      "url": "${MCP_SERVER_URL}"
    }
  }
}`,
    },
    {
      id: "codex",
      label: "Codex",
      eyebrow: "Codex desktop, CLI, and IDE",
      helper: "Add OpenWork once. Codex desktop, the CLI, and the IDE extension share this MCP configuration.",
      copyText: `codex mcp add openwork --url ${MCP_SERVER_URL}`,
    },
    {
      id: "chatgpt-desktop",
      label: "ChatGPT Desktop",
      eyebrow: "Guided desktop setup",
      helper: "Open MCP connections, then paste the copied OpenWork server URL.",
      copyText: MCP_SERVER_URL,
    },
    {
      id: "claude-code",
      label: "Claude Code",
      eyebrow: "One terminal command",
      helper: "Claude Code opens your browser for OAuth, then stores the remote MCP server.",
      copyText: `claude mcp add --transport http openwork ${MCP_SERVER_URL}`,
    },
    {
      id: "opencode",
      label: "OpenCode",
      eyebrow: "opencode.json MCP config",
      helper: "Add this remote MCP server entry to your OpenCode config.",
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
    },
    {
      id: "vs-code",
      label: "VS Code",
      eyebrow: "VS Code MCP command",
      helper: "Run this from a shell with the VS Code CLI on your path.",
      copyText: `code --add-mcp '{"name":"openwork","type":"http","url":"${MCP_SERVER_URL}"}'`,
    },
    {
      id: "any-client",
      label: "Any client",
      eyebrow: "Universal installer",
      helper: "Use install-mcp for another client, or paste the remote server URL directly.",
      copyText: `npx install-mcp ${MCP_SERVER_URL} --client <your-client>`,
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
          Developers: point your own agent at your org — one click or one command.
        </div>
        <div className="mt-1 text-xs text-gray-400">
          Works with Codex, ChatGPT, Claude Code, Cursor — any MCP agent
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
          {activeInstall.id === "cursor" ? (
            <a href={CURSOR_DEEPLINK} className="shrink-0 rounded-full bg-[#011627] px-5 py-2.5 text-sm font-medium text-white">
              Add to Cursor
            </a>
          ) : activeInstall.id === "codex" || activeInstall.id === "chatgpt-desktop" ? (
            <a href={CODEX_CONNECTIONS_DEEPLINK} onClick={() => void copyText(MCP_SERVER_URL)} className="shrink-0 rounded-full bg-[#011627] px-5 py-2.5 text-sm font-medium text-white">
              Open settings + copy URL
            </a>
          ) : null}
        </div>
        <pre className="m-0 max-h-80 overflow-auto whitespace-pre-wrap rounded-xl bg-[#011627] p-4 text-xs leading-6 text-white"><code>{activeInstall.copyText}</code></pre>
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
