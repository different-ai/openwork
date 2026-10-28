import { claudeConfigDir } from "../claude-import.js";
import {
  listClaudeCodeSessionsEverywhere,
  readClaudeCodeSessionEverywhere,
} from "./claude-code.js";
import {
  CodeSessionsError,
  type CodeSessionClient,
  type CodeSessionDetail,
  type CodeSessionSummary,
  type CodeSessionsClientState,
} from "./types.js";

/**
 * Machine-wide view of the coding-agent sessions stored on this computer.
 *
 * The service is the only surface the routes talk to. Adapters are registered
 * per client; a disabled client is never scanned, so turning one off keeps its
 * transcripts unread by OpenWork, not just hidden in the UI.
 */
export type CodeSessionsService = {
  clients(): CodeSessionsClientState[];
  setClientEnabled(client: CodeSessionClient, enabled: boolean): void;
  list(): Promise<CodeSessionSummary[]>;
  read(client: CodeSessionClient, sessionId: string): Promise<CodeSessionDetail>;
};

export function createCodeSessionsService(options: {
  /** Claude Code's data folder resolver; injectable for tests. */
  claudeConfigDir?: () => string;
} = {}): CodeSessionsService {
  const configDir = options.claudeConfigDir ?? claudeConfigDir;
  const enabled = new Map<CodeSessionClient, boolean>();

  const isEnabled = (client: CodeSessionClient): boolean => enabled.get(client) ?? true;

  return {
    clients(): CodeSessionsClientState[] {
      return [{ id: "claude-code", enabled: isEnabled("claude-code"), available: true }];
    },

    setClientEnabled(client: CodeSessionClient, value: boolean): void {
      if (client !== "claude-code") {
        throw new CodeSessionsError("code_session_client_unknown", "This coding agent is not supported yet.");
      }
      enabled.set(client, value);
    },

    async list(): Promise<CodeSessionSummary[]> {
      if (!isEnabled("claude-code")) return [];
      return listClaudeCodeSessionsEverywhere({ configDir: configDir() });
    },

    async read(client: CodeSessionClient, sessionId: string): Promise<CodeSessionDetail> {
      if (client !== "claude-code") {
        throw new CodeSessionsError("code_session_client_unknown", "This coding agent is not supported yet.");
      }
      if (!isEnabled(client)) {
        throw new CodeSessionsError("code_session_client_disabled", "Claude Code is turned off in the Code tab.");
      }
      return readClaudeCodeSessionEverywhere(sessionId, { configDir: configDir() });
    },
  };
}
