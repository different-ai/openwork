/**
 * Settings › Show model reasoning, applied to the model request.
 *
 * The desktop sends the person's current choice with every prompt as
 * `metadata.openwork.showReasoning`. When it is on, each agent turn asks the
 * provider to return readable reasoning (Anthropic `display: "summarized"`,
 * OpenAI `reasoningSummary: "auto"`, Google `includeThoughts`). When it is off,
 * or unknown (for example after an engine restart before the next prompt), the
 * request is left exactly as the model and its variant define it.
 *
 * Without this, a model's default variant thinks but returns only an encrypted
 * signature, so the setting had nothing to show.
 */

type JsonRecord = Record<string, unknown>;
type Overlay = { readonly settings?: JsonRecord };
type ModelInfo = Overlay & {
  readonly id: string;
  readonly providerID: string;
  readonly package?: string;
  readonly capabilities?: { readonly output?: readonly string[] };
  readonly variants?: readonly (Overlay & { readonly id: string })[];
};
type ModelRef = { readonly id: string; readonly providerID: string; readonly variant?: string };
type PromptEvent = { readonly sessionID: string; readonly metadata?: JsonRecord };
type ContextEvent = { readonly sessionID: string; readonly model: ModelRef; options: JsonRecord };
type Registration = { readonly dispose: () => Promise<void> };

export type VisibleReasoningContext = {
  readonly session: {
    readonly get: (input: { sessionID: string }) => Promise<{ readonly parentID?: string }>;
    readonly hook: {
      (name: "prompt", callback: (event: PromptEvent) => Promise<void> | void): Promise<Registration>;
      (name: "context", callback: (event: ContextEvent) => Promise<void> | void): Promise<Registration>;
    };
  };
  readonly model: { readonly list: () => Promise<{ readonly data: readonly ModelInfo[] }> };
};

const OPENAI_SUMMARY_PACKAGES = new Set([
  "@opencode/ai/providers/openai",
  "@opencode/ai/providers/openai/responses",
  "@opencode/ai/providers/azure",
  "@opencode/ai/providers/azure/responses",
  "@opencode/ai/providers/xai",
]);
const MAX_PARENT_DEPTH = 8;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The person's choice carried by one prompt, or undefined when the prompt says nothing. */
export function promptShowReasoning(metadata: unknown): boolean | undefined {
  const openwork = isRecord(metadata) ? metadata.openwork : undefined;
  const value = isRecord(openwork) ? openwork.showReasoning : undefined;
  return typeof value === "boolean" ? value : undefined;
}

function record(value: unknown): JsonRecord | undefined {
  return isRecord(value) ? value : undefined;
}

/**
 * Provider options that make `model` (with the selected variant) return
 * readable reasoning. Only adds what is missing, never switches thinking on
 * for a variant that turned it off, and returns null when nothing applies.
 */
export function visibleReasoningOptions(model: ModelInfo, variantID: string | undefined): JsonRecord | null {
  const variant = variantID && variantID !== "default" ? model.variants?.find((item) => item.id === variantID) : undefined;
  const base = model.settings ?? {};
  const selected = variant?.settings ?? {};
  const overlays = [base, ...(model.variants ?? []).map((item) => item.settings ?? {})];

  // Anthropic Messages (direct, Vertex, Bedrock and gateway aliases).
  const thinking = { ...record(base.thinking), ...record(selected.thinking) };
  const adaptiveCapable = overlays.some((settings) => record(settings.thinking)?.type === "adaptive");
  if (thinking.type === "adaptive" && thinking.display !== "summarized") {
    return { thinking: { display: "summarized" } };
  }
  // No thinking configured: these models think adaptively on their own but
  // omit the text. Ask for the same adaptive thinking, with a summary.
  if (thinking.type === undefined && adaptiveCapable) {
    return { thinking: { type: "adaptive", display: "summarized" } };
  }
  if (thinking.type !== undefined) return null;

  // OpenAI Responses-style reasoning summaries.
  if (model.package && OPENAI_SUMMARY_PACKAGES.has(model.package)) {
    const effort = selected.reasoningEffort ?? base.reasoningEffort;
    const summary = selected.reasoningSummary ?? base.reasoningSummary;
    const reasons = effort !== undefined || overlays.some((settings) => settings.reasoningEffort !== undefined);
    if (reasons && effort !== "none" && summary === undefined) return { reasoningSummary: "auto" };
    return null;
  }

  // Google Gemini thought summaries.
  const thinkingConfig = { ...record(base.thinkingConfig), ...record(selected.thinkingConfig) };
  const thinks = overlays.some((settings) => record(settings.thinkingConfig) !== undefined);
  if (thinks && thinkingConfig.includeThoughts !== true && thinkingConfig.thinkingBudget !== 0) {
    return { thinkingConfig: { includeThoughts: true } };
  }
  return null;
}

/** Deep-merges `patch` into the request options the engine is about to send. */
function apply(options: JsonRecord, patch: JsonRecord) {
  for (const [key, value] of Object.entries(patch)) {
    const current = options[key];
    options[key] = isRecord(current) && isRecord(value) ? { ...current, ...value } : value;
  }
}

export async function registerVisibleReasoning(context: VisibleReasoningContext): Promise<() => Promise<void>> {
  const choices = new Map<string, boolean>();

  // Child sessions (background agents) follow the conversation that started them.
  const choiceFor = async (sessionID: string): Promise<boolean> => {
    let id: string | undefined = sessionID;
    for (let depth = 0; id && depth < MAX_PARENT_DEPTH; depth += 1) {
      const known = choices.get(id);
      if (known !== undefined) return known;
      const session: { readonly parentID?: string } | undefined = await context.session.get({ sessionID: id }).catch(() => undefined);
      id = session?.parentID;
    }
    return false;
  };

  const registrations = [
    await context.session.hook("prompt", (event) => {
      const choice = promptShowReasoning(event.metadata);
      if (choice !== undefined) choices.set(event.sessionID, choice);
    }),
    await context.session.hook("context", async (event) => {
      try {
        if (!(await choiceFor(event.sessionID))) return;
        const models = await context.model.list();
        const model = models.data.find((item) => item.providerID === event.model.providerID && item.id === event.model.id);
        if (!model) return;
        const patch = visibleReasoningOptions(model, event.model.variant);
        if (patch) apply(event.options, patch);
      } catch {
        // A display preference must never fail the turn; send the model's defaults.
      }
    }),
  ];
  return async () => {
    for (const registration of registrations) await registration.dispose();
  };
}

export default {
  id: "openwork.visible-reasoning",
  setup: (context: VisibleReasoningContext) => registerVisibleReasoning(context),
};
