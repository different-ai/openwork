import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { claudeConfigDir } from "../claude-import.js";
import { listClaudeCodeSessionsEverywhere, readClaudeCodeSessionEverywhere } from "./claude-code.js";
import { listCodexSessionsEverywhere, readCodexSessionEverywhere } from "./codex.js";
import {
  defaultOpenCodeDbPath,
  listOpenCodeSessionsEverywhere,
  readOpenCodeSessionEverywhere,
} from "./opencode.js";
import { listPiSessionsEverywhere, readPiSessionEverywhere } from "./pi.js";
import {
  CodeSessionsError,
  type CodeSessionClient,
  type CodeSessionDetail,
  type CodeSessionSummary,
  type CodeSessionsClientState,
} from "./types.js";

const CLIENT_IDS: readonly CodeSessionClient[] = ["claude-code", "codex", "pi", "opencode"];

/**
 * Machine-wide view of the coding-agent sessions stored on this computer.
 *
 * The service is the only surface the routes talk to. A disabled client is
 * never scanned, so turning one off keeps its transcripts unread by OpenWork,
 * not just hidden in the UI. Availability is probed against each client's
 * data folder and cached for the lifetime of the service.
 */
export type CodeSessionsService = {
  clients(): CodeSessionsClientState[];
  setClientEnabled(client: CodeSessionClient, enabled: boolean): void;
  list(): Promise<CodeSessionSummary[]>;
  read(client: CodeSessionClient, sessionId: string): Promise<CodeSessionDetail>;
};

async function directoryExists(path: string): Promise<boolean> {
  try {
    await readdir(path);
    return true;
  } catch {
    return false;
  }
}

function defaultCodexDir(): string {
  return process.env.CODEX_HOME?.trim() || join(homedir(), ".codex");
}

function defaultPiSessionsDir(): string {
  return process.env.PI_HOME?.trim()
    ? join(process.env.PI_HOME.trim(), "agent", "sessions")
    : join(homedir(), ".pi", "agent", "sessions");
}

export function createCodeSessionsService(options: {
  /** Claude Code's data folder resolver; injectable for tests. */
  claudeConfigDir?: () => string;
  /** Codex's data folder resolver; injectable for tests. */
  codexConfigDir?: () => string;
  /** Pi's sessions root resolver; injectable for tests. */
  piSessionsDir?: () => string;
  /** OpenCode v2 database path resolver; injectable for tests. */
  opencodeDbPath?: () => string;
} = {}): CodeSessionsService {
  const claudeDir = options.claudeConfigDir ?? claudeConfigDir;
  const codexDir = options.codexConfigDir ?? defaultCodexDir;
  const piDir = options.piSessionsDir ?? defaultPiSessionsDir;
  const ocDb = options.opencodeDbPath ?? defaultOpenCodeDbPath;

  const enabled = new Map<CodeSessionClient, boolean>();
  const availability = new Map<CodeSessionClient, boolean>();

  const isEnabled = (client: CodeSessionClient): boolean => enabled.get(client) ?? true;

  const assertKnown = (client: CodeSessionClient): void => {
    if (!CLIENT_IDS.includes(client)) {
      throw new CodeSessionsError("code_session_client_unknown", "This coding agent is not supported yet.");
    }
  };

  const probeAvailability = async (): Promise<void> => {
    if (availability.size === CLIENT_IDS.length) return;
    availability.set("claude-code", await directoryExists(join(claudeDir(), "projects")));
    availability.set("codex", await directoryExists(join(codexDir(), "sessions")));
    availability.set("pi", await directoryExists(piDir()));
    try {
      await stat(ocDb());
      availability.set("opencode", true);
    } catch {
      availability.set("opencode", false);
    }
  };

  return {
    clients(): CodeSessionsClientState[] {
      return CLIENT_IDS.map((id) => ({
        id,
        enabled: isEnabled(id),
        available: availability.get(id) ?? true,
      }));
    },

    setClientEnabled(client: CodeSessionClient, value: boolean): void {
      assertKnown(client);
      enabled.set(client, value);
    },

  async list(): Promise<CodeSessionSummary[]> {
    await probeAvailability();
    const groups = await Promise.all([
      isEnabled("claude-code") && (availability.get("claude-code") ?? true)
        ? listClaudeCodeSessionsEverywhere({ configDir: claudeDir() })
        : Promise.resolve([] as CodeSessionSummary[]),
      isEnabled("codex") && (availability.get("codex") ?? true)
        ? listCodexSessionsEverywhere({ configDir: codexDir() })
        : Promise.resolve([] as CodeSessionSummary[]),
      isEnabled("pi") && (availability.get("pi") ?? true)
        ? listPiSessionsEverywhere({ sessionsDir: piDir() })
        : Promise.resolve([] as CodeSessionSummary[]),
      isEnabled("opencode") && (availability.get("opencode") ?? true)
        ? listOpenCodeSessionsEverywhere({ dbPath: ocDb() })
        : Promise.resolve([] as CodeSessionSummary[]),
    ]);
    return groups.flat().sort((a, b) => b.updatedAt - a.updatedAt);
  },

  async read(client: CodeSessionClient, sessionId: string): Promise<CodeSessionDetail> {
    assertKnown(client);
    if (!isEnabled(client)) {
      throw new CodeSessionsError("code_session_client_disabled", `${client} is turned off in the Code tab.`);
    }
    if (client === "claude-code") {
      return readClaudeCodeSessionEverywhere(sessionId, { configDir: claudeDir() });
    }
    if (client === "codex") {
      return readCodexSessionEverywhere(sessionId, { configDir: codexDir() });
    }
    if (client === "opencode") {
      return readOpenCodeSessionEverywhere(sessionId, { dbPath: ocDb() });
    }
    return readPiSessionEverywhere(sessionId, { sessionsDir: piDir() });
  },
};
}
