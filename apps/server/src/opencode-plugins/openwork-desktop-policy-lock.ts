type DesktopPolicyState = {
  allowCreateSkills: boolean;
  allowAddMcpServers: boolean;
};

type ToolExecuteInput = {
  tool: string;
};

type ToolExecuteOutput = {
  args: unknown;
};

type PermissionInput = {
  pattern?: string | string[];
};

type PermissionOutput = {
  status: "ask" | "deny" | "allow";
};

const POLICY_CACHE_MS = 15_000;
const DEFAULT_POLICY_STATE: DesktopPolicyState = {
  allowCreateSkills: true,
  allowAddMcpServers: true,
};
const FILE_WRITE_TOOLS = new Set(["write", "edit", "multi_edit", "multiedit"]);
const SKILL_LOCK_MESSAGE =
  "Your organization administrator has disabled creating skills on this device.";
const MCP_LOCK_MESSAGE =
  "Your organization administrator has disabled adding MCP servers on this device. MCP/connection changes are disabled by your organization, and this file is managed.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePolicyState(value: unknown): DesktopPolicyState | null {
  if (!isRecord(value) || !isRecord(value.state)) return null;
  if (
    typeof value.state.allowCreateSkills !== "boolean"
    || typeof value.state.allowAddMcpServers !== "boolean"
  ) {
    return null;
  }
  return {
    allowCreateSkills: value.state.allowCreateSkills,
    allowAddMcpServers: value.state.allowAddMcpServers,
  };
}

function normalizedPath(value: string): string {
  return `/${value.trim().replace(/\\/g, "/").replace(/^\/+/, "")}`;
}

function restrictionMessage(path: string, state: DesktopPolicyState): string | null {
  const normalized = normalizedPath(path).toLowerCase();
  if (!state.allowCreateSkills && normalized.includes("/.opencode/skills/")) {
    return SKILL_LOCK_MESSAGE;
  }
  const basename = normalized.split("/").filter(Boolean).at(-1);
  if (
    !state.allowAddMcpServers
    && (
      basename === "opencode.json"
      || basename === "opencode.jsonc"
      || normalized.endsWith("/.opencode/openwork.json")
    )
  ) {
    return MCP_LOCK_MESSAGE;
  }
  return null;
}

function filePathFromArgs(args: unknown): string | null {
  if (!isRecord(args)) return null;
  return typeof args.filePath === "string" ? args.filePath : null;
}

export const OpenWorkDesktopPolicyLock = async (_factoryInput?: unknown) => {
  let cachedState: DesktopPolicyState | null = null;
  let cachedAt = 0;

  async function readPolicyState(): Promise<DesktopPolicyState> {
    if (cachedState && Date.now() - cachedAt < POLICY_CACHE_MS) return cachedState;
    const url = String(process.env.OPENWORK_SERVER_URL || "").replace(/\/$/, "");
    const token = String(process.env.OPENWORK_SERVER_TOKEN || "");
    try {
      const response = await fetch(`${url}/experimental/desktop-policy/state`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) throw new Error(`Desktop policy request failed with HTTP ${response.status}`);
      const parsed = parsePolicyState(await response.json());
      cachedState = parsed ?? DEFAULT_POLICY_STATE;
    } catch {
      cachedState = cachedState ?? DEFAULT_POLICY_STATE;
    }
    cachedAt = Date.now();
    return cachedState;
  }

  return {
    "tool.execute.before": async (input: ToolExecuteInput, output: ToolExecuteOutput) => {
      if (!FILE_WRITE_TOOLS.has(input.tool)) return;
      const filePath = filePathFromArgs(output.args);
      if (!filePath) return;
      const message = restrictionMessage(filePath, await readPolicyState());
      if (message) throw new Error(message);
    },
    "permission.ask": async (input: PermissionInput, output: PermissionOutput) => {
      const patterns = typeof input.pattern === "string" ? [input.pattern] : input.pattern;
      if (!patterns?.length) return;
      const state = await readPolicyState();
      if (patterns.some((pattern) => restrictionMessage(pattern, state) !== null)) {
        output.status = "deny";
      }
    },
  };
};
