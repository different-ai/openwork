import { z } from "zod";
import { HeadlessThreadError } from "./errors.ts";
import { toTranscript } from "./transcript.ts";
import { createNativeV2Client, nativeV2AttachmentsMatch, nativeV2SkillsSchema, type NativeV2Client, type NativeV2Input, type NativeV2Message, type NativeV2Model, type NativeV2Session } from "./v2-client.ts";
import type { CreateThreadInput, HeadlessThreadClient, HeadlessThreadClientOptions, HeadlessThreadMessage, HeadlessThreadModel, HeadlessThreadSnapshot, HeadlessThreadStatus, HeadlessThreadTurnInput, HeadlessThreadWaitInput, HeadlessThreadWaitResult, HeadlessTurnAcceptance } from "./v2-types.ts";

export type HeadlessThreadClientV2Options = HeadlessThreadClientOptions & {
  defaultAgent?: string;
  admissionTimeoutMs?: number;
  /** Persist generated identities before the first native write. Errors retain these IDs too. */
  onIntent?: (intent: { threadId: string; messageId?: string }) => void | Promise<void>;
};

const bindingSchema = z.object({
  version: z.literal(1), messageId: z.string(), contextId: z.string().nullable(),
  previousMessageId: z.string().nullable(), model: z.object({ providerID: z.string(), id: z.string(), variant: z.string().optional() }), agent: z.string(),
  previousIdleAt: z.number().nullable(), previousOutcome: z.enum(["succeeded", "failed", "interrupted"]).nullable(),
  skillIds: z.array(z.string()).max(32).optional(),
});
const bindings = (message: NativeV2Message) => bindingSchema.safeParse(message.metadata?.headlessTurn);
function boundInputSkills(id: string, payload: { metadata?: Record<string, unknown>; skills?: Array<{ id: string }> }) {
  const binding = bindingSchema.safeParse(payload.metadata?.headlessTurn);
  if (!binding.success || binding.data.messageId !== id) return;
  const skills = nativeV2SkillsSchema.safeParse((binding.data.skillIds ?? []).map((id) => ({ id })));
  if (!skills.success || skills.data.length !== (binding.data.skillIds?.length ?? 0) || !nativeV2AttachmentsMatch(payload, skills.data)) return;
  return (payload.skills ?? []).map((skill) => ({ id: skill.id }));
}
/** Selection evidence only, not completion or permission to resend. Missing evidence fails closed. */
export function nativeV2InputSkillsMatch(snapshot: HeadlessThreadSnapshot, messageId: string, skills?: Array<{ id: string }>): boolean {
  const native = snapshot.native;
  const selected = nativeV2SkillsSchema.safeParse(skills === undefined ? [] : skills);
  return selected.success && native !== undefined && !native.ambiguousTurns.includes(messageId)
    && Object.hasOwn(native.inputSkills, messageId) && JSON.stringify(native.inputSkills[messageId]) === JSON.stringify(selected.data);
}
const nativeModel = (value: HeadlessThreadModel): NativeV2Model => ({ providerID: value.providerId, id: value.modelId, ...(value.variant ? { variant: value.variant } : {}) });
const sameModel = (a: NativeV2Model | undefined, b: NativeV2Model) => a?.id === b.id && a.providerID === b.providerID && (a.variant ?? "default") === (b.variant ?? "default");
// Native instruction updates project as system annotations at the next step
// boundary. They are not admitted inputs; a claimed host binding or attachment
// still requires reconciliation under the existing serialized-writer contract.
function isNativeSystemAnnotation(message: NativeV2Message): boolean {
  return message.type === "system" && !Object.hasOwn(message.metadata ?? {}, "headlessTurn") && nativeV2AttachmentsMatch(message, []);
}
function nativeV2IdleBoundary(history: NativeV2Message[]) {
  for (let index = history.length - 1; index >= 0; index--) {
    const item = history[index];
    if (item.type === "idle") return history.slice(index + 1).every((annotation) => annotation.time.created >= item.time.created) ? item : undefined;
    if (!isNativeSystemAnnotation(item) && !((item.type === "agent-switched" || item.type === "model-switched")
      && !Object.hasOwn(item.metadata ?? {}, "headlessTurn") && nativeV2AttachmentsMatch(item, []))) return;
  }
}
const terminalType = z.enum(["succeeded", "failed", "interrupted"]);
type Outcome = z.infer<typeof terminalType>;

export async function cancelNativeV2TurnContext(native: NativeV2Client, threadId: string, input: HeadlessThreadTurnInput & { messageId: string }): Promise<boolean> {
  if (!input.agent || !input.model) return false;
  const signal = AbortSignal.any([AbortSignal.timeout(15_000), ...(input.signal ? [input.signal] : [])]);
  const [session, history, inbox, active] = await Promise.all([
    native.getSession(threadId, signal), native.readHistory(threadId, signal), native.readInbox(threadId, signal), native.readActive(signal),
  ]);
  const contextId = `${input.messageId}_context`;
  const context = inbox.length === 1 ? inbox[0] : undefined;
  if (Object.hasOwn(active, threadId) || session.revert || session.parentID || context?.id !== contextId || context.type !== "synthetic" || context.delivery !== "steer") return false;
  const binding = bindingSchema.safeParse(context.payload.metadata?.headlessTurn);
  if (!binding.success || binding.data.messageId !== input.messageId || binding.data.contextId !== contextId
    || binding.data.agent !== input.agent || session.agent !== input.agent
    || !sameModel(binding.data.model, nativeModel(input.model)) || !sameModel(session.model, binding.data.model)
    || binding.data.previousMessageId !== (history.at(-1)?.id ?? null)
    || binding.data.previousIdleAt !== (session.time.idle ?? null) || binding.data.previousOutcome !== (session.outcome ?? null)
    || history.some((item) => item.id === input.messageId || item.id === contextId)
    || JSON.stringify(binding.data.skillIds ?? []) !== JSON.stringify(nativeV2SkillsSchema.parse(input.skills ?? []).map((skill) => skill.id))
    || !nativeV2AttachmentsMatch(context.payload, []) || (input.context !== undefined && input.context !== context.payload.text)) return false;
  const expected: NativeV2Input = { id: contextId, type: "synthetic", text: context.payload.text, metadata: context.payload.metadata };
  if ((await native.reconcileInput(threadId, expected, signal)).state !== "queued" || Object.hasOwn(await native.readActive(signal), threadId)) return false;
  await native.cancelInput(threadId, contextId, signal);
  if ((await native.reconcileInput(threadId, expected, signal)).state !== "unobserved") throw new HeadlessThreadError({ code: "stop_unconfirmed", method: "DELETE", path: `/session/${threadId}/inbox/${contextId}`, message: "Native input or execution remains after Stop." });
  return true;
}

/** One process-wide admission barrier across renderer/helper client instances. The host must also serialize across processes. */
const admissions = new Map<string, { messageId: string; uncertain: boolean; uncertainInput?: NativeV2Input }>();
const operations = new Set<string>();
const stops = new Map<string, Promise<{ threadId: string; accepted: boolean }>>();
const submittedInputs = new Set<string>();
let idTime = 0;
let idCount = 0;
export function createNativeV2Id(prefix: "ses" | "msg"): string {
  const now = Math.max(Date.now(), idTime);
  idCount = now === idTime ? idCount + 1 : 0;
  idTime = now;
  return `${prefix}_${now.toString(16).padStart(12, "0")}${idCount.toString(16).padStart(6, "0")}${crypto.randomUUID().replaceAll("-", "")}`;
}
export function nativeV2PartId(messageId: string, ordinal: number, type = "text"): string {
  return `${messageId}:${ordinal.toString().padStart(8, "0")}:${type}`;
}

/**
 * Beta19086 has no assistant parentID. A host admission records the preceding
 * native history tail and observed idle boundary, then admits only its context
 * and user input. Validate the complete ordered interval, model/agent binding,
 * and the next admission's idle boundary before attributing any assistant.
 * The host must serialize writers to the session. Unmarked users, overlapping
 * inputs, reverts, missing history and unknown synthetic input confer no authority.
 */
export function projectNativeV2History(history: NativeV2Message[], session: NativeV2Session, idle: boolean, apiContract: "beta19271" | "native-2" = "beta19271") {
  const parents = new Map<string, string>();
  const turnOutcomes: Record<string, Outcome> = {};
  const turnErrors: Record<string, string> = {};
  const inputSkills: Record<string, Array<{ id: string }>> = {};
  const ambiguousTurns = new Set<string>();
  const users = history.filter((item) => item.type === "user");
  for (const [userIndex, user] of users.entries()) {
    const binding = bindings(user);
    if (!binding.success || binding.data.messageId !== user.id) { ambiguousTurns.add(user.id); continue; }
    const skills = boundInputSkills(user.id, user);
    const nextUser = users[userIndex + 1];
    const next = nextUser ? bindings(nextUser) : undefined;
    const index = history.indexOf(user);
    const previousIndex = binding.data.previousMessageId === null ? -1 : history.findIndex((item) => item.id === binding.data.previousMessageId);
    const between = history.slice(previousIndex + 1, index).filter((item) => !isNativeSystemAnnotation(item));
    const nextTail = next?.success ? history.findIndex((item) => item.id === next.data.previousMessageId) : -1;
    const end = nextUser ? nextTail + 1 : history.length;
    const interval = history.slice(index + 1, end);
    const nativeIdle = apiContract === "native-2" ? nativeV2IdleBoundary(interval) : undefined;
    const replies = interval.filter((item) => item.type === "assistant");
    const idleAt = nextUser ? next?.success ? next.data.previousIdleAt : null : idle ? session.time.idle : null;
    const outcome = nextUser ? next?.success ? next.data.previousOutcome : null : idle ? session.outcome : null;
    const terminal = typeof idleAt === "number" && idleAt >= user.time.created && idleAt > (binding.data.previousIdleAt ?? -1) && outcome
      && replies.every((reply) => reply.time.created <= idleAt && (reply.time.completed === undefined || reply.time.completed <= idleAt));
    const previousUsers = history.slice(0, index).filter((item) => item.type === "user");
    const previousUser = previousUsers.at(-1);
    const priorAssistant = history.slice(0, previousIndex + 1).filter((item) => item.type === "assistant").at(-1);
    const valid = !session.revert && !session.parentID && (binding.data.previousMessageId === null || previousIndex >= 0) && previousIndex < index
      && nativeV2AttachmentsMatch(user, (binding.data.skillIds ?? []).map((id) => ({ id })))
      && (binding.data.contextId === null ? between.length === 0 : between.length === 1 && between[0]?.id === binding.data.contextId && between[0].type === "synthetic" && nativeV2AttachmentsMatch(between[0], []) && JSON.stringify(between[0].metadata?.headlessTurn) === JSON.stringify(user.metadata?.headlessTurn))
      && (!previousUser || (binding.data.previousIdleAt !== null && binding.data.previousOutcome !== null && history.indexOf(previousUser) <= previousIndex && (!priorAssistant || priorAssistant.time.created <= binding.data.previousIdleAt)))
      && (!nextUser || (next?.success && nextTail >= index && terminal))
      && interval.every((item) => ["assistant", "system", "agent-switched", "model-switched"].includes(item.type) || (item.type === "compaction" && item.reason === "auto")
        || (apiContract === "native-2" && item.type === "idle" && terminal && item === nativeIdle && item.time.created === idleAt && item.outcome === outcome))
      && replies.every((item) => item.type === "assistant" && item.agent === binding.data.agent && sameModel(item.model, binding.data.model) && item.time.created >= user.time.created)
      && (!nextUser || replies.length > 0 || outcome === "failed" || outcome === "interrupted");
    if (!valid) {
      ambiguousTurns.add(user.id);
      continue;
    }
    if (skills !== undefined) inputSkills[user.id] = skills;
    for (const reply of replies) parents.set(reply.id, user.id);
    if (terminal) turnOutcomes[user.id] = outcome;
    const lastReply = replies.at(-1);
    if (lastReply?.type === "assistant" && lastReply.error) turnErrors[user.id] = lastReply.error.message;
  }
  const messages: HeadlessThreadMessage[] = history.map((item) => ({
    id: item.id, role: item.type, parentId: parents.get(item.id) ?? null,
    createdAt: item.time.created, completedAt: item.time.completed ?? null,
    error: item.type === "assistant" && item.error ? { name: item.error.type, message: item.error.message, retryable: null, providerError: item.error.type } : null,
    model: item.type === "assistant" ? { providerId: item.model.providerID, modelId: item.model.id } : null,
    usage: item.type === "assistant" && item.tokens ? {
      inputTokens: item.tokens.input, outputTokens: item.tokens.output, reasoningTokens: item.tokens.reasoning,
      cacheReadTokens: item.tokens.cache.read, cacheWriteTokens: item.tokens.cache.write, cost: item.cost ?? 0,
    } : null,
    parts: item.type === "assistant" ? item.content.map((part, ordinal) => part.type === "tool" ? {
      id: part.id, type: "tool", callId: part.id, tool: part.name, toolStatus: part.state.status,
      ...(part.state.status === "streaming" ? {} : { toolInput: part.state.input }),
      ...(part.state.status === "completed" || part.state.status === "error" ? { toolOutput: part.state.content, toolMetadata: part.state.metadata } : part.state.status === "running" ? { toolMetadata: part.state.metadata } : {}),
      ...(part.state.status === "error" ? { toolError: part.state.error.message } : {}),
      toolStartedAt: part.time.ran ?? part.time.created, toolCompletedAt: part.time.completed,
    } : { id: nativeV2PartId(item.id, item.content.slice(0, ordinal).filter((value) => value.type === part.type).length, part.type), type: part.type, text: part.text })
      : "text" in item && typeof item.text === "string" ? [{ id: nativeV2PartId(item.id, 0), type: "text", text: item.text, synthetic: item.type !== "user" }] : [],
  }));
  return { messages, turnOutcomes, turnErrors, inputSkills, ambiguousTurns: [...ambiguousTurns] };
}

export function isNativeV2ObservationError(error: unknown): boolean {
  return error instanceof HeadlessThreadError && error.method === "GET" && (
    error.code === "observation_unavailable" || error.code === "snapshot_unconfirmed"
    || (error.code === "request_failed" && (error.status === null || error.status === 408 || error.status === 429 || error.status >= 500))
  );
}

export function createHeadlessThreadClientV2(options: HeadlessThreadClientV2Options): HeadlessThreadClient {
  const native = createNativeV2Client(options);
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const key = (id: string) => `${options.baseUrl.replace(/\/+$/, "")}/${options.workspaceId}/${id}`;
  const fail = (code: string, threadId: string, message: string, messageId?: string): never => {
    throw new HeadlessThreadError({ code, method: "POST", path: `/workspace/${encodeURIComponent(options.workspaceId)}/opencode2/api/session/${encodeURIComponent(threadId)}`, message, body: { threadId, messageId } });
  };

  async function getThreadSnapshot(threadId: string, input?: { signal?: AbortSignal; limit?: number }): Promise<HeadlessThreadSnapshot> {
    const signal = AbortSignal.any([AbortSignal.timeout(options.requestTimeoutMs ?? 15_000), ...[input?.signal, options.signal].filter((value): value is AbortSignal => value !== undefined)]);
    const read = () => Promise.all([
      native.getSession(threadId, signal), native.readHistory(threadId, signal), native.readInbox(threadId, signal), native.readActive(signal),
    ]);
    let [session, history, pending, active] = await read();
    const sourceOverlap = () => {
      if (options.apiContract !== "native-2") return false;
      const last = nativeV2IdleBoundary(history);
      if (!last) return false;
      return Object.hasOwn(active, threadId) || session.time.idle !== last.time.created || session.outcome !== last.outcome
        || history.some((message) => message.type === "assistant" && (message.time.completed === undefined || message.content.some((part) => part.type === "tool" && ["running", "streaming"].includes(part.state.status))));
    };
    for (let retry = 0; pending.some((item) => history.some((message) => message.id === item.id)) || sourceOverlap(); retry++) {
      if (retry === 2) throw new HeadlessThreadError({ code: "snapshot_unconfirmed", method: "GET", path: `/session/${threadId}`, message: "Native history and inbox did not reach a consistent observation. Earlier work will not be replayed." });
      [session, history, pending, active] = await read();
    }
    const projection = projectNativeV2History(history, session, !Object.hasOwn(active, threadId) && pending.length === 0, options.apiContract);
    const inputSkills = { ...projection.inputSkills };
    // The host admits one user input, optionally paired with one synthetic
    // context. Validate that boundary directly; never fabricate history for inbox items.
    const users = pending.filter((item) => item.type === "user");
    const user = users.length === 1 ? users[0] : undefined;
    const binding = bindingSchema.safeParse(user?.payload.metadata?.headlessTurn);
    if (user && binding.success && !session.revert && !session.parentID) {
      const skills = boundInputSkills(user.id, user.payload);
      const contextId = binding.data.contextId;
      const previousIndex = binding.data.previousMessageId === null ? -1 : history.findIndex((item) => item.id === binding.data.previousMessageId);
      const between = history.slice(previousIndex + 1).filter((item) => !isNativeSystemAnnotation(item));
      const deliveredContext = contextId !== null && between.length === 1 && between[0]?.id === contextId && between[0].type === "synthetic" ? between[0] : undefined;
      const queuedContext = pending.filter((item) => item.type === "synthetic").find((item) => item.id === contextId);
      const context = deliveredContext ?? queuedContext?.payload;
      const previousUser = history.slice(0, previousIndex + 1).filter((item) => item.type === "user").at(-1);
      const contextMatches = contextId === null ? !context : context !== undefined && !(deliveredContext && queuedContext)
        && nativeV2AttachmentsMatch(context, []) && JSON.stringify(context.metadata?.headlessTurn) === JSON.stringify(user.payload.metadata?.headlessTurn);
      if (skills !== undefined && contextMatches && pending.length === (queuedContext ? 2 : 1)
        && (binding.data.previousMessageId === null || previousIndex >= 0) && between.length === (deliveredContext ? 1 : 0)
        && binding.data.previousIdleAt === (session.time.idle ?? null) && binding.data.previousOutcome === (session.outcome ?? null)
        && binding.data.agent === session.agent && sameModel(session.model, binding.data.model)
        && (!previousUser || Object.hasOwn(projection.inputSkills, previousUser.id))) inputSkills[user.id] = skills;
    }
    const latest = history.filter((item) => item.type === "assistant").at(-1);
    const running = Object.hasOwn(active, threadId);
    const retry = latest?.type === "assistant" && latest.time.completed === undefined ? latest.retry : undefined;
    const status: HeadlessThreadStatus = running ? retry ? { type: "retry", attempt: retry.attempt, next: retry.at, message: retry.error.message, reason: retry.error.type } : { type: "busy" } : { type: "idle" };
    return {
      threadId, title: session.title ?? null, directory: session.location.directory, status, messages: projection.messages, todos: null,
      native: { engine: "v2", pendingInputIds: pending.map((item) => item.id), inputSkills, turnOutcomes: projection.turnOutcomes, turnErrors: projection.turnErrors, ambiguousTurns: projection.ambiguousTurns, todos: "unavailable" },
    };
  }

  async function selection(value: HeadlessThreadModel | undefined, agentId: string, signal?: AbortSignal) {
    const [agent, catalog] = await Promise.all([native.getAgent(agentId, signal), native.readCatalog(signal)]);
    if (agent.id !== agentId) fail("binding_unconfirmed", "", "Native agent identity did not match.");
    const model = value ? nativeModel(value) : agent.model ?? await native.defaultModel(signal);
    if (!model) return fail("model_unavailable", "", "No native model is available. Choose a connected model.");
    if (!catalog.connectedProviderIds.includes(model.providerID) || !catalog.models.some((item) => item.providerID === model.providerID && item.id === model.id && item.enabled && (!model.variant || model.variant === "default" || item.variants.some((variant) => variant.id === model.variant)))) fail("model_unavailable", "", "The selected native model or variant is not connected and available.");
    return { model: { providerID: model.providerID, id: model.id, ...(model.variant ? { variant: model.variant } : {}) }, agent: agent.id };
  }

  async function createThread(input: CreateThreadInput) {
    if ("noReply" in input && input.noReply === true) fail("unsupported_no_reply", input.threadId ?? "", "Native resume:false only parks input in the inbox. Create the thread without a prompt for no-model setup.");
    const title = z.string().trim().min(1).max(120).parse(input.title);
    const prompt = input.prompt ? z.string().trim().min(1).max(100_000).parse(input.prompt) : undefined;
    const skills = nativeV2SkillsSchema.parse(input.skills === undefined ? [] : input.skills);
    if (skills.length && prompt === undefined) fail("prompt_required", input.threadId ?? "", "Selected skills require an initial prompt.");
    if ("files" in input || "agents" in input) fail("unsupported_attachments", input.threadId ?? "", "Native file and agent attachments are not supported by this client.");
    const threadId = input.threadId ?? createNativeV2Id("ses");
    const chosen = await selection(input.model ?? options.defaultModel, input.agent ?? options.defaultAgent ?? "build", input.signal);
    await options.onIntent?.({ threadId });
    let session;
    try { session = await native.createSession({ id: threadId, title, ...chosen, ...(input.metadata ? { metadata: input.metadata } : {}) }, input.signal); }
    catch (error) { return fail("creation_unknown", threadId, `Session creation could not be confirmed. Reconcile this exact thread ID; do not create another.${error instanceof HeadlessThreadError ? ` ${error.message}` : ""}`); }
    if (prompt !== undefined) await sendTurn(threadId, { prompt, skills, model: input.model, agent: input.agent, signal: input.signal });
    return { id: threadId, workspaceId: options.workspaceId, title: session.title ?? null, directory: session.location.directory, createdAt: session.time.created, started: prompt !== undefined };
  }

  async function sendTurn(threadId: string, input: HeadlessThreadTurnInput): Promise<HeadlessTurnAcceptance> {
    if ("noReply" in input && input.noReply === true) fail("unsupported_no_reply", threadId, "Native resume:false does not materialize a no-reply message. Use explicit inbox admission only when parked input is intended.", input.messageId);
    const messageId = input.messageId ?? createNativeV2Id("msg");
    z.string().startsWith("msg_").parse(messageId);
    z.string().trim().min(1).max(100_000).parse(input.prompt);
    const skills = nativeV2SkillsSchema.parse(input.skills === undefined ? [] : input.skills);
    const skillIds = skills.map((skill) => skill.id);
    if ("files" in input || "agents" in input) fail("unsupported_attachments", threadId, "Native file and agent attachments are not supported by this client.", messageId);
    if (input.tools && Object.keys(input.tools).length) fail("unsupported_tool_mask", threadId, "Native v2 has no per-turn tool mask. Use a registered native agent with enforced permissions.", messageId);
    const scope = key(threadId);
    if (operations.has(scope)) fail("session_busy", threadId, "Another native admission or stop owns this session.", messageId);
    operations.add(scope);
    try {
      const observed = await native.reconcileAdmission(threadId, messageId, input.signal);
      if (observed.state !== "unobserved") {
        const item = observed.state === "delivered" ? observed.message : observed.receipt.payload;
        const type = observed.state === "delivered" ? observed.message.type : observed.receipt.type;
        const metadata = z.object({ metadata: z.object({ headlessTurn: bindingSchema }) }).safeParse(item);
        const binding = metadata.success ? metadata.data.metadata.headlessTurn : undefined;
        if (type !== "user" || !("text" in item) || item.text !== input.prompt || !binding || binding.messageId !== messageId
          || JSON.stringify(binding.skillIds ?? []) !== JSON.stringify(skillIds) || !nativeV2AttachmentsMatch(item, skills)
          || (input.agent !== undefined && binding.agent !== input.agent)
          || (input.model !== undefined && !sameModel(binding.model, nativeModel(input.model)))) return fail("input_conflict", threadId, "This native input ID belongs to different content or selection.", messageId);
        const contextId = binding.contextId;
        if (Boolean(contextId) !== Boolean(input.context)) fail("input_conflict", threadId, "The admitted context differs.", messageId);
        if (contextId) {
          const context = await native.reconcileAdmission(threadId, contextId, input.signal);
          const payload = context.state === "delivered" ? context.message : context.state === "queued" ? context.receipt.payload : null;
          const type = context.state === "delivered" ? context.message.type : context.state === "queued" ? context.receipt.type : null;
          const contextBinding = z.object({ metadata: z.object({ headlessTurn: bindingSchema }) }).safeParse(payload);
          if (type !== "synthetic" || !payload || !("text" in payload) || payload.text !== input.context || !contextBinding.success || JSON.stringify(contextBinding.data.metadata.headlessTurn) !== JSON.stringify(binding)) fail("input_conflict", threadId, "The admitted context could not be verified.", messageId);
        }
        if (admissions.get(scope)?.messageId === messageId) admissions.set(scope, { messageId, uncertain: false });
        return { threadId, messageId, acceptedAt: now(), messageCountBefore: 0, alreadyPresent: true };
      }
      const prior = admissions.get(scope);
      if (submittedInputs.has(`${scope}/${messageId}`)) fail("admission_unknown", threadId, "This input was already submitted. Reconcile it; do not replay cancelled or uncertain work.", messageId);
      if (prior?.uncertain) fail("admission_unknown", threadId, "A previous native write remains uncertain. Reconcile or stop before another admission.", prior.messageId);
      const snapshot = await getThreadSnapshot(threadId, { signal: input.signal });
      if (snapshot.status.type !== "idle" || snapshot.native?.pendingInputIds.length) fail("session_busy", threadId, "Native execution or pending input already owns this session.", messageId);
      const lastUser = snapshot.messages.filter((item) => item.role === "user").at(-1);
      if (lastUser && !snapshot.native?.turnOutcomes[lastUser.id]) fail("boundary_unconfirmed", threadId, "The previous native turn has no unambiguous terminal boundary.", messageId);
      let session = await native.getSession(threadId, input.signal);
      const chosen = await selection(input.model ?? options.defaultModel ?? (session.model ? { providerId: session.model.providerID, modelId: session.model.id, variant: session.model.variant } : undefined), input.agent ?? options.defaultAgent ?? session.agent ?? "build", input.signal);
      const switchModel = !sameModel(session.model, chosen.model);
      const switchAgent = session.agent !== chosen.agent;
      if (switchModel) await native.switchModel(threadId, chosen.model, input.signal);
      if (switchAgent) await native.switchAgent(threadId, chosen.agent, input.signal);
      if (switchModel || switchAgent) session = await native.getSession(threadId, input.signal);
      if (!sameModel(session.model, chosen.model) || session.agent !== chosen.agent) fail("binding_unconfirmed", threadId, "Native model/agent binding was not applied.", messageId);
      // Switches are native history entries, so capture the tail after binding.
      const before = await native.readHistory(threadId, input.signal);
      if ((await native.readInbox(threadId, input.signal)).length || Object.hasOwn(await native.readActive(input.signal), threadId)) fail("session_busy", threadId, "Native execution changed during admission.", messageId);
      const contextId = input.context ? `${messageId}_context` : null;
      // Reject unavailable/denied/ask before parking paired context. The native
      // client checks again immediately before the user POST, including direct callers.
      if (skills.length) await native.checkSkills(threadId, skills, input.signal);
      const metadata = { headlessTurn: { version: 1, messageId, contextId, skillIds, previousMessageId: before.at(-1)?.id ?? null, previousIdleAt: session.time.idle ?? null, previousOutcome: session.outcome ?? null, ...chosen } };
      let marked = false;
      const admit = async (value: NativeV2Input) => {
        await native.admitInput(threadId, value, input.signal, async () => {
          input.signal?.throwIfAborted(); options.signal?.throwIfAborted();
          if (!marked) {
            await options.onIntent?.({ threadId, messageId });
            input.signal?.throwIfAborted(); options.signal?.throwIfAborted();
          }
          await input.beforeInput?.();
          marked = true;
          admissions.set(scope, { messageId, uncertain: true, uncertainInput: value });
          submittedInputs.add(`${scope}/${messageId}`);
        });
        admissions.set(scope, { messageId, uncertain: false });
      };
      // Both inputs steer an idle session. With no earlier pending work, native
      // promotion delivers both before the first step. Queueing context would
      // incorrectly start a separate provider turn before the user's prompt.
      if (contextId) {
        input.signal?.throwIfAborted(); options.signal?.throwIfAborted();
        const contextInput: NativeV2Input = { id: contextId, type: "synthetic", text: input.context ?? "", metadata, delivery: "steer", resume: false };
        await admit(contextInput);
        if (Object.hasOwn(await native.readActive(input.signal), threadId)) fail("session_busy", threadId, "Execution started before the paired prompt was admitted. Stop and reconcile the context.", messageId);
      }
      input.signal?.throwIfAborted(); options.signal?.throwIfAborted();
      const promptInput: NativeV2Input = { id: messageId, type: "user", text: input.prompt, ...(skills.length ? { skills } : {}), metadata, delivery: "steer", resume: true };
      await admit(promptInput);
      return { threadId, messageId, acceptedAt: now(), messageCountBefore: before.length, alreadyPresent: false };
    } catch (error) {
      if (error instanceof HeadlessThreadError && error.method === "POST" && /\/(prompt|synthetic)$/.test(error.path) && [400, 401, 403, 404, 422].includes(error.status ?? 0) && admissions.get(scope)?.messageId === messageId) admissions.set(scope, { messageId, uncertain: false });
      if (error instanceof HeadlessThreadError && !z.object({ threadId: z.string(), messageId: z.string() }).safeParse(error.body).success) throw new HeadlessThreadError({ code: error.code, message: error.message, method: error.method, path: error.path, ...(error.status === null ? {} : { status: error.status }), body: { threadId, messageId } });
      throw error;
    } finally { operations.delete(scope); }
  }

  async function retryTurn(threadId: string, input: HeadlessThreadTurnInput & { messageId: string }): Promise<HeadlessTurnAcceptance> {
    const scope = key(threadId);
    if (operations.has(scope)) fail("session_busy", threadId, "Another admission or stop owns this session.", input.messageId);
    const previous = admissions.get(scope);
    if (previous?.uncertain && previous.messageId !== input.messageId) fail("admission_unknown", threadId, "Reconcile the earlier uncertain input before recovering another turn.", previous.messageId);
    // Restore the host's saved uncertainty before reading. A failed recovery
    // read after restart is not evidence that the earlier write was rejected.
    if (!previous?.uncertain) admissions.set(scope, { messageId: input.messageId, uncertain: true, uncertainInput: { id: input.messageId, type: "user", text: input.prompt, skills: nativeV2SkillsSchema.parse(input.skills === undefined ? [] : input.skills) } });
    const observed = await native.reconcileAdmission(threadId, input.messageId, input.signal);
    if (observed.state === "unobserved") {
      fail("admission_unknown", threadId, "No authoritative admission is visible. Retry does not resubmit uncertain work.", input.messageId);
    }
    const result = await sendTurn(threadId, input);
    const snapshot = await getThreadSnapshot(threadId, { signal: input.signal });
    const outcome = snapshot.native?.turnOutcomes[input.messageId];
    if (outcome === "failed" || outcome === "interrupted") fail("continuation_required", threadId, "Earlier work is preserved. Continue with a new message ID in this session; do not replay the original prompt.", input.messageId);
    return { ...result, retried: false };
  }

  async function wait(threadId: string, input: HeadlessThreadWaitInput, idleOnly: boolean): Promise<HeadlessThreadWaitResult> {
    const start = now();
    let polls = 0, observedRunning = false;
    const timeoutMs = z.number().nonnegative().parse(input.timeoutMs);
    const deadline = AbortSignal.timeout(Math.max(1, timeoutMs));
    const signal = AbortSignal.any([deadline, ...[input.signal, options.signal].filter((value): value is AbortSignal => value !== undefined)]);
    let snapshot: HeadlessThreadSnapshot | undefined;
    const finish = (outcome: HeadlessThreadWaitResult["outcome"], value: HeadlessThreadSnapshot, messageId?: string): HeadlessThreadWaitResult => ({
      outcome, snapshot: value, waitedMs: now() - start, polls, observedRunning,
      terminalError: outcome === "failed" ? value.messages.filter((item) => item.parentId === messageId).at(-1)?.error ?? { name: "native_execution_failed", message: value.native?.turnErrors[messageId ?? ""] ?? "Native execution failed or its turn boundary is ambiguous.", retryable: null, providerError: null } : null,
    });
    for (;;) {
      if (snapshot && (deadline.aborted || now() - start >= timeoutMs)) return finish(input.signal?.aborted || options.signal?.aborted ? "aborted" : "timeout", snapshot);
      try { snapshot = await getThreadSnapshot(threadId, { signal }); }
      catch (error) {
        if (input.signal?.aborted || options.signal?.aborted) {
          if (!snapshot) throw error;
          return finish("aborted", snapshot);
        }
        if (!isNativeV2ObservationError(error) && !(deadline.aborted && error instanceof DOMException && error.name === "TimeoutError")) throw error;
        const remaining = timeoutMs - (now() - start);
        if (remaining <= 0 || deadline.aborted) {
          if (snapshot) return finish("timeout", snapshot);
          throw new HeadlessThreadError({
            code: "observation_unavailable", method: "GET", path: `/session/${threadId}`,
            message: "The local AI service has not returned a status yet. Your message is kept; checking can resume without sending it again.",
          });
        }
        await sleep(Math.min(input.pollIntervalMs ?? options.pollIntervalMs ?? 500, remaining));
        continue;
      }
      polls++;
      const idle = snapshot.status.type === "idle" && snapshot.native?.pendingInputIds.length === 0;
      observedRunning ||= snapshot.status.type !== "idle";
      const messageId = input.since?.messageId ?? snapshot.messages.find((item) => item.role === "user")?.id;
      if (idleOnly && idle) return finish("settled", snapshot);
      if (!idleOnly && messageId) {
        if (snapshot.native?.ambiguousTurns.includes(messageId)) return finish("failed", snapshot, messageId);
        const outcome = snapshot.native?.turnOutcomes[messageId];
        const reply = snapshot.messages.filter((item) => item.role === "assistant" && item.parentId === messageId).at(-1);
        if (idle && outcome === "interrupted") return finish("aborted", snapshot, messageId);
        if (idle && outcome === "failed") return finish("failed", snapshot, messageId);
        if (idle && outcome === "succeeded" && reply?.completedAt !== null && reply !== undefined) return finish(reply.error ? "failed" : "settled", snapshot, messageId);
      }
      if (input.signal?.aborted || options.signal?.aborted) return finish("aborted", snapshot);
      const remaining = timeoutMs - (now() - start);
      if (remaining <= 0 || deadline.aborted) return finish("timeout", snapshot);
      await sleep(Math.min(input.pollIntervalMs ?? options.pollIntervalMs ?? 500, remaining));
    }
  }

  async function abortThread(threadId: string, input?: { signal?: AbortSignal }) {
    const scope = key(threadId);
    const existing = stops.get(scope);
    if (existing) return existing;
    const stopping = stopThread(threadId, input);
    stops.set(scope, stopping);
    try { return await stopping; }
    finally { if (stops.get(scope) === stopping) stops.delete(scope); }
  }
  async function stopThread(threadId: string, input?: { signal?: AbortSignal }) {
    const scope = key(threadId);
    if (operations.has(scope)) fail("session_busy", threadId, "Admission is still in progress. Cancel its signal and retry Stop.");
    operations.add(scope);
    try {
      const admission = admissions.get(scope);
      if (admission?.uncertain && admission.uncertainInput) {
        const found = await native.reconcileInput(threadId, admission.uncertainInput, input?.signal);
        if (found.state !== "unobserved") admissions.set(scope, { messageId: admission.messageId, uncertain: false });
      }
      const stopped = await native.stop(threadId, input?.signal);
      // Only pending inbox entries are cancelled. No transcript deletion or revert.
      for (const item of stopped.pending) await native.cancelInput(threadId, item.id, input?.signal);
      if ((await native.readInbox(threadId, input?.signal)).length || Object.hasOwn(await native.readActive(input?.signal), threadId)) fail("stop_unconfirmed", threadId, "Native input or execution remains after Stop.");
      if (admissions.get(scope)?.uncertain) fail("stop_unconfirmed", threadId, "An earlier write is still uncertain. Keep the admission barrier and reconcile its ID.");
      admissions.delete(scope);
      return { threadId, accepted: true };
    } finally { operations.delete(scope); }
  }
  return { createThread, sendTurn, retryTurn, getThreadSnapshot, abortThread, waitForThread: (id, input) => wait(id, input, false), waitUntilIdle: (id, input) => wait(id, input, true), exportTranscript: async (id, input) => toTranscript(await getThreadSnapshot(id, input)) };
}
