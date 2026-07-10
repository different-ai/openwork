export const MCP_SERVER_URL = "https://api.openworklabs.com/mcp/agent";
export const CURSOR_DEEPLINK = "https://cursor.com/en/install-mcp?name=openwork&config=eyJ1cmwiOiJodHRwczovL2FwaS5vcGVud29ya2xhYnMuY29tL21jcC9hZ2VudCJ9";
export const CODEX_CONNECTIONS_DEEPLINK = "codex://settings/connections";
export type OpenWorkConnectClientId =
  | "cursor"
  | "codex"
  | "chatgpt-desktop"
  | "claude-code"
  | "opencode"
  | "vs-code"
  | "any-client";

export const CURSOR_SNIPPET = `{
  "mcpServers": {
    "openwork": {
      "url": "${MCP_SERVER_URL}"
    }
  }
}`;

export const CLAUDE_CODE_COMMAND = `claude mcp add --transport http openwork ${MCP_SERVER_URL}`;
export const CODEX_COMMAND = `codex mcp add openwork --url ${MCP_SERVER_URL}`;

export const OPENCODE_SNIPPET = `{
  "mcp": {
    "openwork": {
      "type": "remote",
      "enabled": true,
      "url": "${MCP_SERVER_URL}",
      "oauth": {}
    }
  }
}`;

export const VS_CODE_COMMAND = `code --add-mcp '{"name":"openwork","type":"http","url":"${MCP_SERVER_URL}"}'`;
export const ANY_CLIENT_COMMAND = `npx install-mcp ${MCP_SERVER_URL} --client <your-client>`;

export const CONNECT_CLIENTS: OpenWorkConnectClientId[] = [
  "cursor",
  "codex",
  "chatgpt-desktop",
  "claude-code",
  "opencode",
  "vs-code",
  "any-client"
];
