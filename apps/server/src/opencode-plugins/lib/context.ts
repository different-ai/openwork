import {
  getRecordProperty,
  isRecord,
  optionalStringProperty,
  readNestedString,
} from "./records.js";

export type OpenCodeContext = {
  agent?: string;
  sessionID?: string;
  messageID?: string;
  directory?: string;
  worktree?: string;
  workspaceId?: string;
  workspaceID?: string;
};

type ProviderModel = {
  provider: string;
  model: string;
};

type EngineMcpStatusRequest = {
  query?: {
    directory?: string;
  };
};

export type OpenWorkEngineMcpStatusClient = {
  mcp: {
    status: (request?: EngineMcpStatusRequest) => Promise<unknown>;
  };
};

type OpenWorkEngineMcpStatusFunction = OpenWorkEngineMcpStatusClient["mcp"]["status"];

function isOpenWorkEngineMcpStatusFunction(value: unknown): value is OpenWorkEngineMcpStatusFunction {
  return typeof value === "function";
}

export function normalizeOpenCodeContext(value: unknown): OpenCodeContext {
  const nested = isRecord(value) && isRecord(value.context) ? value.context : value;
  const agent = optionalStringProperty(nested, "agent");
  const sessionID = optionalStringProperty(nested, "sessionID");
  const messageID = optionalStringProperty(nested, "messageID");
  const directory = optionalStringProperty(nested, "directory");
  const worktree = optionalStringProperty(nested, "worktree");
  const workspaceId = optionalStringProperty(nested, "workspaceId");
  const workspaceID = optionalStringProperty(nested, "workspaceID");
  return {
    ...(agent ? { agent } : {}),
    ...(sessionID ? { sessionID } : {}),
    ...(messageID ? { messageID } : {}),
    ...(directory ? { directory } : {}),
    ...(worktree ? { worktree } : {}),
    ...(workspaceId ? { workspaceId } : {}),
    ...(workspaceID ? { workspaceID } : {}),
  };
}

export function mergeTransformInputWithFactoryContext(input: unknown, factoryContext: OpenCodeContext): unknown {
  if (Object.keys(factoryContext).length === 0) return input;
  const inputRecord = isRecord(input) ? input : {};
  const inputContext = isRecord(inputRecord.context) ? inputRecord.context : {};
  return {
    ...inputRecord,
    context: {
      ...factoryContext,
      ...inputContext,
    },
  };
}

export function readContext(input: unknown): OpenCodeContext {
  const context = getRecordProperty(input, "context");
  const session = getRecordProperty(input, "session");
  const directory = readNestedString(input, ["directory"])
    ?? readNestedString(context, ["directory"])
    ?? readNestedString(session, ["directory"]);
  const worktree = readNestedString(input, ["worktree"])
    ?? readNestedString(context, ["worktree"])
    ?? readNestedString(session, ["worktree"]);
  const workspaceId = readNestedString(input, ["workspaceId"])
    ?? readNestedString(input, ["workspaceID"])
    ?? readNestedString(context, ["workspaceId"])
    ?? readNestedString(context, ["workspaceID"]);
  return {
    ...(directory ? { directory } : {}),
    ...(worktree ? { worktree } : {}),
    ...(workspaceId ? { workspaceId } : {}),
  };
}

export function readProviderModel(input: unknown): ProviderModel | undefined {
  const model = getRecordProperty(input, "model");
  const provider = readNestedString(model, ["providerID"])
    ?? readNestedString(model, ["provider"])
    ?? readNestedString(input, ["provider"]);
  const modelId = readNestedString(model, ["modelID"])
    ?? readNestedString(model, ["id"])
    ?? readNestedString(input, ["modelID"]);
  if (provider && modelId) return { provider, model: modelId };
  const combined = modelId?.includes("/")
    ? modelId
    : readNestedString(input, ["model"]) ?? readNestedString(model, ["name"]);
  if (combined?.includes("/")) {
    const [providerPart, ...modelParts] = combined.split("/");
    const joinedModel = modelParts.join("/").trim();
    if (providerPart?.trim() && joinedModel) return { provider: providerPart.trim(), model: joinedModel };
  }
  return undefined;
}

export function readEngineMcpStatusClient(value: unknown): OpenWorkEngineMcpStatusClient | undefined {
  const client = isRecord(value) ? value.client : undefined;
  const mcp = isRecord(client) ? client.mcp : undefined;
  const status = isRecord(mcp) ? mcp.status : undefined;
  if (!isOpenWorkEngineMcpStatusFunction(status)) return undefined;
  return { mcp: { status: (request) => status.call(mcp, request) } };
}
