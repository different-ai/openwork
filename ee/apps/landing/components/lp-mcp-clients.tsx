import type { ReactNode } from "react";

import { BrandLogo } from "./lp-brand-logos";
import { OpenCodeMark, TerminalMark, VsCodeMark } from "./lp-service-marks";
import {
  CHATGPT_SETTINGS_URL,
  CLAUDE_CODE_COMMAND,
  CODEX_COMMAND,
  MCP_SERVER_URL,
  VS_CODE_COMMAND
} from "./openwork-connect-installer-config";

export { MCP_SERVER_URL };

// One-click install links, the same ones the docs publish
// (packages/docs/model-context-protocol/cursor.mdx and vs-code.mdx).
export const CURSOR_INSTALL_LINK =
  "cursor://anysphere.cursor-deeplink/mcp/install?name=openwork&config=eyJ1cmwiOiJodHRwczovL2FwaS5vcGVud29ya2xhYnMuY29tL21jcC9hZ2VudCJ9";
export const VS_CODE_INSTALL_LINK =
  "vscode:mcp/install?%7B%22name%22%3A%22openwork%22%2C%22type%22%3A%22http%22%2C%22url%22%3A%22https%3A%2F%2Fapi.openworklabs.com%2Fmcp%2Fagent%22%7D";

export const OPENCODE_ADD_COMMAND = `opencode mcp add openwork --url ${MCP_SERVER_URL}`;
export const GEMINI_ADD_COMMAND = `gemini mcp add --transport http openwork ${MCP_SERVER_URL}`;

export type McpClient = {
  id: string;
  name: string;
  mark: ReactNode;
  /** Shell command to copy, when the client is set up from a terminal. */
  command?: string;
  /** One-click link that opens the client, when it has one. */
  link?: { href: string; label: string };
  /** What to do after the command or link. */
  next: string;
};

const markClass = "h-4 w-4";

export const MCP_CLIENTS: McpClient[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    mark: <BrandLogo name="claude" className={`${markClass} text-[#D97757]`} />,
    command: CLAUDE_CODE_COMMAND,
    next: "Then run /mcp, pick openwork, and sign up in the browser."
  },
  {
    id: "codex",
    name: "Codex",
    mark: <TerminalMark className={markClass} />,
    command: CODEX_COMMAND,
    next: "Then run codex mcp login openwork and sign up in the browser."
  },
  {
    id: "cursor",
    name: "Cursor",
    mark: <BrandLogo name="cursor" className={`${markClass} text-[#111]`} />,
    link: { href: CURSOR_INSTALL_LINK, label: "Add to Cursor" },
    next: "Cursor opens and asks you to sign in to OpenWork."
  },
  {
    id: "vs-code",
    name: "VS Code",
    mark: <VsCodeMark className={markClass} />,
    command: VS_CODE_COMMAND,
    link: { href: VS_CODE_INSTALL_LINK, label: "Add to VS Code" },
    next: "Then open MCP: List Servers, pick openwork, and start it."
  },
  {
    id: "opencode",
    name: "OpenCode",
    mark: <OpenCodeMark className={markClass} />,
    command: OPENCODE_ADD_COMMAND,
    next: "Then run opencode mcp auth openwork."
  },
  {
    id: "gemini",
    name: "Gemini CLI",
    mark: <BrandLogo name="gemini" className={`${markClass} text-[#4285F4]`} />,
    command: GEMINI_ADD_COMMAND,
    next: "Then run /mcp auth openwork."
  },
  {
    id: "chatgpt",
    name: "ChatGPT",
    mark: <BrandLogo name="openai" className={`${markClass} text-[#10A37F]`} />,
    link: { href: CHATGPT_SETTINGS_URL, label: "Open ChatGPT settings" },
    next: "Paste the URL under MCP servers and sign in."
  }
];
