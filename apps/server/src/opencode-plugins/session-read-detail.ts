/**
 * `session.read` with `detail: "full"`: every message and content item the
 * engine stores, mapped from OpenCode v2's native message schema
 * (`Session.Message.Info`, `GET /api/session/:id/message`, engine 2.2.0) and,
 * for sessions still on v1, from the equivalent v1 message parts into the
 * same shape.
 *
 * Kept: every message type (user, assistant, synthetic, system, skill, shell,
 * compaction, idle, agent/model/location switches) and every assistant
 * content item (text, reasoning, tool calls with input, output, files, error,
 * metadata and timing), plus model, agent, finish reason, tokens, cost,
 * retries and changed files.
 *
 * Left out on purpose: provider `native` blobs (opaque, provider-specific,
 * may hold signed reasoning), inline base64 file data (the file's name, type
 * and URI are kept) and raw provider response bodies in errors.
 *
 * Long fields are clipped with a visible marker and the message is flagged
 * `truncated`; reading one message by `messageId` raises the limits.
 *
 * Dependency-free on purpose: the bundled engine plugin imports it.
 */

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
function rec(value: unknown): JsonRecord | undefined {
  return isRecord(value) ? value : undefined;
}
function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
/** Drops undefined fields so the result stays compact. */
function compact<T extends JsonRecord>(value: T): T {
  for (const key of Object.keys(value)) if (value[key] === undefined) delete value[key];
  return value;
}

export type SessionReadLimits = {
  /** Assistant and user text. */
  text: number;
  reasoning: number;
  /** Synthetic, system and skill text. */
  context: number;
  toolInput: number;
  toolOutput: number;
  toolMetadata: number;
  shellOutput: number;
  compactionSummary: number;
  errorMessage: number;
  /** Tool input, output and metadata kept per message; past it, calls are listed without them. */
  toolBudget: number;
};

export const SESSION_READ_LIST_LIMITS: SessionReadLimits = {
  text: 8_000,
  reasoning: 4_000,
  context: 2_000,
  toolInput: 2_000,
  toolOutput: 4_000,
  toolMetadata: 1_000,
  shellOutput: 4_000,
  compactionSummary: 4_000,
  errorMessage: 1_000,
  toolBudget: 64_000,
};

export const SESSION_READ_MESSAGE_LIMITS: SessionReadLimits = {
  text: 100_000,
  reasoning: 50_000,
  context: 50_000,
  toolInput: 50_000,
  toolOutput: 100_000,
  toolMetadata: 20_000,
  shellOutput: 100_000,
  compactionSummary: 50_000,
  errorMessage: 4_000,
  toolBudget: 400_000,
};

/** Whole-result character budget for a list read. One message is always returned. */
export const SESSION_READ_RESULT_BUDGET = 200_000;

class Clipper {
  truncated = false;
  constructor(readonly limits: SessionReadLimits) {}

  text(value: string | undefined, limit: number): string | undefined {
    if (value === undefined) return undefined;
    if (value.length <= limit) return value;
    this.truncated = true;
    return `${value.slice(0, limit)}…[+${value.length - limit} chars; read this message by messageId for more]`;
  }

  /** Small JSON values stay structured; large ones become a clipped JSON string. */
  json(value: unknown, limit: number): unknown {
    if (value === undefined) return undefined;
    if (typeof value === "string") return this.text(value, limit);
    let encoded: string;
    try {
      encoded = JSON.stringify(value) ?? "";
    } catch {
      return "[unserializable]";
    }
    if (encoded.length <= limit) return value;
    return this.text(encoded, limit);
  }
}

export type RichModel = { providerId: string; modelId: string; variant?: string };
export type RichError = { type: string; message?: string; status?: number; retryAfterMs?: number };
export type RichTokens = { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } };
export type RichFile = { name?: string; mime?: string; uri?: string; inline?: true };

export type RichToolCall = {
  type: "tool";
  id: string;
  name: string;
  status: string;
  executed?: boolean;
  input?: unknown;
  output?: string;
  files?: RichFile[];
  error?: RichError;
  metadata?: unknown;
  /** The sub-agent session this call started; read it with session.read. */
  childSessionId?: string;
  time?: { created?: number; ran?: number; completed?: number };
};

export type RichContent =
  | { type: "text"; text: string; synthetic?: true }
  | { type: "reasoning"; text: string; time?: { created?: number; completed?: number } }
  | RichToolCall
  | { type: "file"; file: RichFile };

export type RichMessage = {
  id: string;
  type: string;
  time: { created?: number; streamed?: number; completed?: number };
  truncated?: true;
} & JsonRecord;

function richModel(value: unknown): RichModel | undefined {
  const model = rec(value);
  if (!model) return undefined;
  const modelId = str(model.id) ?? str(model.modelID);
  const providerId = str(model.providerID);
  if (!modelId || !providerId) return undefined;
  return compact({ providerId, modelId, variant: str(model.variant) });
}

function richTokens(value: unknown): RichTokens | undefined {
  const tokens = rec(value);
  if (!tokens) return undefined;
  const cache = rec(tokens.cache);
  return compact({
    input: num(tokens.input),
    output: num(tokens.output),
    reasoning: num(tokens.reasoning),
    cache: cache ? compact({ read: num(cache.read), write: num(cache.write) }) : undefined,
  });
}

/** v2 `Session.StructuredError`; the provider response body is omitted. */
function richV2Error(value: unknown, clip: Clipper): RichError | undefined {
  const error = rec(value);
  if (!error) return undefined;
  return compact({
    type: str(error.type) ?? "UnknownError",
    message: clip.text(str(error.message), clip.limits.errorMessage),
    status: num(error.status),
    retryAfterMs: num(error.retryAfterMs),
  });
}

function richTime(value: unknown): RichMessage["time"] {
  const time = rec(value);
  return compact({ created: num(time?.created), streamed: num(time?.streamed), completed: num(time?.completed) });
}

function childSessionId(tool: string, metadata: JsonRecord | undefined): string | undefined {
  if (!metadata || (tool !== "subagent" && tool !== "task")) return undefined;
  return str(metadata.sessionId)?.trim() || str(metadata.sessionID)?.trim() || undefined;
}

/** A file reference without its bytes: `data:` URLs carry the whole file, so they become `inline`. */
function fileRef(name: string | undefined, mime: string | undefined, uri: string | undefined): RichFile {
  const inline = uri?.startsWith("data:") === true;
  return compact({ name, mime, uri: inline ? undefined : uri, inline: inline ? (true as const) : undefined });
}

function nonEmpty(value: JsonRecord | undefined): JsonRecord | undefined {
  return value && Object.keys(value).length > 0 ? value : undefined;
}

/** Keeps tool input, output and metadata within the message's tool budget. */
function budgetTools(content: RichContent[], clip: Clipper): RichContent[] {
  let budget = clip.limits.toolBudget;
  return content.map((item) => {
    if (item.type !== "tool") return item;
    const size = JSON.stringify(item).length;
    if (size <= budget) {
      budget -= size;
      return item;
    }
    budget = 0;
    if (item.input === undefined && item.output === undefined && item.metadata === undefined) return item;
    clip.truncated = true;
    const { input: _input, output: _output, metadata: _metadata, ...listed } = item;
    return { ...listed, detailOmitted: true };
  });
}

function v2ToolOutput(content: unknown): { output?: string; files?: RichFile[] } {
  const texts: string[] = [];
  const files: RichFile[] = [];
  for (const item of list(content)) {
    if (!isRecord(item)) continue;
    if (item.type === "text" && typeof item.text === "string") texts.push(item.text);
    if (item.type === "file") files.push(fileRef(str(item.name), str(item.mime), str(item.uri)));
  }
  return { ...(texts.length ? { output: texts.join("\n") } : {}), ...(files.length ? { files } : {}) };
}

function v2Tool(item: JsonRecord, clip: Clipper): RichToolCall | null {
  const id = str(item.id);
  const name = str(item.name);
  const state = rec(item.state);
  if (!id || !name || !state) return null;
  const status = str(state.status) ?? "unknown";
  const metadata = rec(state.metadata);
  const { output, files } = v2ToolOutput(state.content);
  const time = rec(item.time);
  const call: RichToolCall = {
    type: "tool",
    id,
    name,
    status,
    executed: typeof item.executed === "boolean" ? item.executed : undefined,
    // Streaming input is the raw partial JSON text the model is still writing.
    input: clip.json(state.input, clip.limits.toolInput),
    output: clip.text(output, clip.limits.toolOutput),
    files,
    error: status === "error" ? richV2Error(state.error, clip) : undefined,
    metadata: clip.json(nonEmpty(metadata), clip.limits.toolMetadata),
    childSessionId: childSessionId(name, metadata),
    time: time ? compact({ created: num(time.created), ran: num(time.ran), completed: num(time.completed) }) : undefined,
  };
  return compact(call);
}

function v2Content(value: unknown, clip: Clipper): RichContent[] {
  const content: RichContent[] = [];
  for (const item of list(value)) {
    if (!isRecord(item)) continue;
    if (item.type === "text") {
      content.push({ type: "text", text: clip.text(str(item.text) ?? "", clip.limits.text) ?? "" });
    } else if (item.type === "reasoning") {
      const time = rec(item.time);
      content.push(compact({
        type: "reasoning" as const,
        text: clip.text(str(item.text) ?? "", clip.limits.reasoning) ?? "",
        time: time ? compact({ created: num(time.created), completed: num(time.completed) }) : undefined,
      }));
    } else if (item.type === "tool") {
      const tool = v2Tool(item, clip);
      if (tool) content.push(tool);
    }
  }
  return budgetTools(content, clip);
}

function v2File(value: unknown): RichFile | null {
  const file = rec(value);
  if (!file) return null;
  const source = rec(file.source);
  if (source?.type === "uri") return fileRef(str(file.name), str(file.mime), str(source.uri));
  return compact({ name: str(file.name), mime: str(file.mime), inline: true as const });
}

/** Maps one native v2 `Session.Message.Info`. Unknown future types keep id, type and time. */
export function richV2Message(row: unknown, limits: SessionReadLimits, options: { includeMetadata?: boolean } = {}): RichMessage | null {
  if (!isRecord(row)) return null;
  const id = str(row.id);
  const type = str(row.type);
  if (!id || !type) return null;
  const clip = new Clipper(limits);
  const base = { id, type, time: richTime(row.time) };
  let fields: JsonRecord = {};
  switch (type) {
    case "user": {
      const files = list(row.files).map(v2File).filter((file): file is RichFile => file !== null);
      const agents = list(row.agents).flatMap((agent) => (isRecord(agent) && typeof agent.name === "string" ? [agent.name] : []));
      const skills = list(row.skills).flatMap((skill) =>
        isRecord(skill) && typeof skill.name === "string" ? [compact({ id: str(skill.id), name: skill.name })] : []);
      fields = {
        text: clip.text(str(row.text) ?? "", limits.text),
        files: files.length ? files : undefined,
        agents: agents.length ? agents : undefined,
        skills: skills.length ? skills : undefined,
      };
      break;
    }
    case "synthetic":
    case "system":
      fields = { text: clip.text(str(row.text) ?? "", limits.context) };
      break;
    case "skill":
      fields = { skill: str(row.skill), name: str(row.name), text: clip.text(str(row.text) ?? "", limits.context) };
      break;
    case "shell": {
      const output = rec(row.output);
      fields = {
        shellId: str(row.shellID),
        command: str(row.command),
        status: str(row.status),
        exit: num(row.exit) ?? str(row.exit),
        output: clip.text(str(output?.output), limits.shellOutput),
        outputTruncatedByEngine: output?.truncated === true ? true : undefined,
      };
      break;
    }
    case "assistant": {
      const snapshot = rec(row.snapshot);
      const retry = rec(row.retry);
      const changed = list(snapshot?.files).filter((file): file is string => typeof file === "string");
      fields = {
        agent: str(row.agent),
        model: richModel(row.model),
        finish: str(row.finish),
        cost: num(row.cost),
        tokens: richTokens(row.tokens),
        error: richV2Error(row.error, clip),
        retry: retry ? compact({ attempt: num(retry.attempt), at: num(retry.at), error: richV2Error(retry.error, clip) }) : undefined,
        changedFiles: changed.length ? changed : undefined,
        content: v2Content(row.content, clip),
      };
      break;
    }
    case "compaction":
      fields = {
        status: str(row.status),
        reason: str(row.reason),
        summary: clip.text(str(row.summary), limits.compactionSummary),
        model: richModel(row.model),
        error: richV2Error(row.error, clip),
        cost: num(row.cost),
        tokens: richTokens(row.tokens),
      };
      break;
    case "idle":
      fields = { outcome: str(row.outcome), error: richV2Error(row.error, clip) };
      break;
    case "agent-switched":
      fields = { agent: str(row.agent), previous: str(row.previous) };
      break;
    case "model-switched":
      fields = { model: richModel(row.model), previous: richModel(row.previous) };
      break;
    case "location-switched": {
      const previous = rec(row.previous);
      fields = {
        directory: str(rec(row.location)?.directory),
        subpath: str(row.subpath),
        previousDirectory: str(rec(previous?.location)?.directory),
      };
      break;
    }
    default:
      break;
  }
  const metadata = options.includeMetadata ? clip.json(nonEmpty(rec(row.metadata)), limits.toolMetadata) : undefined;
  return compact({ ...base, ...fields, metadata, truncated: clip.truncated ? (true as const) : undefined });
}

/** v1 errors are `{ name, data: { message } }`. */
function richV1Error(value: unknown, clip: Clipper): RichError | undefined {
  const error = rec(value);
  if (!error) return undefined;
  const data = rec(error.data);
  return compact({
    type: str(error.name) ?? "UnknownError",
    message: clip.text(str(data?.message) ?? str(error.message), clip.limits.errorMessage),
    status: num(data?.statusCode),
  });
}

function v1Tool(part: JsonRecord, clip: Clipper): RichToolCall | null {
  const id = str(part.callID) ?? str(part.id);
  const name = str(part.tool);
  const state = rec(part.state);
  if (!id || !name || !state) return null;
  const rawStatus = str(state.status) ?? "unknown";
  const status = rawStatus === "pending" ? "streaming" : rawStatus;
  const metadata = rec(state.metadata);
  const time = rec(state.time);
  const files = list(state.attachments).flatMap((file) =>
    isRecord(file) ? [fileRef(str(file.filename), str(file.mime), str(file.url))] : []);
  const errorText = str(state.error);
  const call: RichToolCall = {
    type: "tool",
    id,
    name,
    status,
    input: clip.json(rawStatus === "pending" && str(state.raw) ? state.raw : state.input, clip.limits.toolInput),
    output: clip.text(str(state.output), clip.limits.toolOutput),
    files: files.length ? files : undefined,
    error: errorText !== undefined ? { type: "ToolError", message: clip.text(errorText, clip.limits.errorMessage) } : undefined,
    metadata: clip.json(nonEmpty(metadata), clip.limits.toolMetadata),
    childSessionId: childSessionId(name, metadata),
    time: time ? compact({ ran: num(time.start), completed: num(time.end) }) : undefined,
  };
  return compact(call);
}

/** Maps one v1 `{ info, parts }` message into the same shape as v2. */
export function richV1Message(message: unknown, limits: SessionReadLimits, options: { includeMetadata?: boolean } = {}): RichMessage | null {
  if (!isRecord(message)) return null;
  const info = rec(message.info);
  const id = str(info?.id);
  const role = str(info?.role);
  if (!info || !id || !role) return null;
  const clip = new Clipper(limits);
  const parts = list(message.parts).filter(isRecord);
  const base = { id, type: role, time: richTime(info.time) };
  if (role === "user") {
    const text = parts
      .filter((part) => part.type === "text" && part.ignored !== true && typeof part.text === "string")
      .map((part) => str(part.text) ?? "")
      .join("\n\n");
    const files = parts.flatMap((part) =>
      part.type === "file" ? [fileRef(str(part.filename), str(part.mime), str(part.url))] : []);
    const agents = parts.flatMap((part) => (part.type === "agent" && typeof part.name === "string" ? [part.name] : []));
    return compact({
      ...base,
      text: clip.text(text, limits.text),
      files: files.length ? files : undefined,
      agents: agents.length ? agents : undefined,
      truncated: clip.truncated ? (true as const) : undefined,
    });
  }
  const content: RichContent[] = [];
  const changed = new Set<string>();
  for (const part of parts) {
    if (part.type === "text" && part.ignored !== true) {
      content.push(compact({
        type: "text" as const,
        text: clip.text(str(part.text) ?? "", limits.text) ?? "",
        synthetic: part.synthetic === true ? (true as const) : undefined,
      }));
    } else if (part.type === "reasoning") {
      const time = rec(part.time);
      content.push(compact({
        type: "reasoning" as const,
        text: clip.text(str(part.text) ?? "", limits.reasoning) ?? "",
        time: time ? compact({ created: num(time.start), completed: num(time.end) }) : undefined,
      }));
    } else if (part.type === "tool") {
      const tool = v1Tool(part, clip);
      if (tool) content.push(tool);
    } else if (part.type === "file") {
      content.push({ type: "file", file: fileRef(str(part.filename), str(part.mime), str(part.url)) });
    } else if (part.type === "patch") {
      for (const file of list(part.files)) if (typeof file === "string") changed.add(file);
    }
  }
  const model = str(info.modelID) && str(info.providerID)
    ? compact({ providerId: str(info.providerID) ?? "", modelId: str(info.modelID) ?? "", variant: str(info.variant) })
    : undefined;
  return compact({
    ...base,
    agent: str(info.agent) ?? str(info.mode),
    model,
    finish: str(info.finish),
    cost: num(info.cost),
    tokens: richTokens(info.tokens),
    error: richV1Error(info.error, clip),
    changedFiles: changed.size ? [...changed] : undefined,
    content: budgetTools(content, clip),
    metadata: options.includeMetadata ? clip.json(nonEmpty(rec(info.metadata)), limits.toolMetadata) : undefined,
    truncated: clip.truncated ? (true as const) : undefined,
  });
}

/**
 * The newest (from end) or oldest (from start) messages that fit the result
 * budget, in chronological order. Always keeps at least one message.
 */
export function fitSessionReadBudget(
  messages: RichMessage[],
  from: "start" | "end",
  budget = SESSION_READ_RESULT_BUDGET,
): { messages: RichMessage[]; omittedForSize: number } {
  const ordered = from === "end" ? [...messages].reverse() : messages;
  const kept: RichMessage[] = [];
  let used = 0;
  for (const message of ordered) {
    const size = JSON.stringify(message).length;
    if (used + size > budget) {
      if (kept.length > 0) break;
      const minimal: RichMessage = { id: message.id, type: message.type, time: message.time, truncated: true };
      kept.push(minimal);
      used += JSON.stringify(minimal).length;
      break;
    }
    kept.push(message);
    used += size;
  }
  return {
    messages: from === "end" ? kept.reverse() : kept,
    omittedForSize: messages.length - kept.length,
  };
}
