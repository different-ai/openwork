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

export function promptShowReasoning(metadata: unknown): boolean | undefined {
  const openwork = isRecord(metadata) ? metadata.openwork : undefined;
  const value = isRecord(openwork) ? openwork.showReasoning : undefined;
  return typeof value === "boolean" ? value : undefined;
}

function record(value: unknown): JsonRecord | undefined {
  return isRecord(value) ? value : undefined;
}

export function visibleReasoningOptions(model: ModelInfo, variantID: string | undefined): JsonRecord | null {
  const variant = variantID && variantID !== "default" ? model.variants?.find((item) => item.id === variantID) : undefined;
  const base = model.settings ?? {};
  const selected = variant?.settings ?? {};
  const overlays = [base, ...(model.variants ?? []).map((item) => item.settings ?? {})];

  const thinking = { ...record(base.thinking), ...record(selected.thinking) };
  const adaptiveCapable = overlays.some((settings) => record(settings.thinking)?.type === "adaptive");
  if (thinking.type === "adaptive" && thinking.display !== "summarized") {
    return { thinking: { display: "summarized" } };
  }
  if (thinking.type === undefined && adaptiveCapable) {
    return { thinking: { type: "adaptive", display: "summarized" } };
  }
  if (thinking.type !== undefined) return null;

  if (model.package && OPENAI_SUMMARY_PACKAGES.has(model.package)) {
    const effort = selected.reasoningEffort ?? base.reasoningEffort;
    const summary = selected.reasoningSummary ?? base.reasoningSummary;
    const reasons = effort !== undefined || overlays.some((settings) => settings.reasoningEffort !== undefined);
    if (reasons && effort !== "none" && summary === undefined) return { reasoningSummary: "auto" };
    return null;
  }

  const thinkingConfig = { ...record(base.thinkingConfig), ...record(selected.thinkingConfig) };
  const thinks = overlays.some((settings) => record(settings.thinkingConfig) !== undefined);
  if (thinks && thinkingConfig.includeThoughts !== true && thinkingConfig.thinkingBudget !== 0) {
    return { thinkingConfig: { includeThoughts: true } };
  }
  return null;
}

function apply(options: JsonRecord, patch: JsonRecord) {
  for (const [key, value] of Object.entries(patch)) {
    const current = options[key];
    options[key] = isRecord(current) && isRecord(value) ? { ...current, ...value } : value;
  }
}

export async function registerVisibleReasoning(context: VisibleReasoningContext): Promise<() => Promise<void>> {
  const choices = new Map<string, boolean>();

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
