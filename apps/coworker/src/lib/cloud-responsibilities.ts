/**
 * Cloud responsibilities are OpenWork Cloud Automations.
 *
 * Den fixes execution placement at creation time: the legacy Desktop body
 * shape (`POST /v1/automations`) yields a desktop-placed Automation that only
 * runs while an OpenWork desktop runner is connected — and Open Coworker hosts
 * no runner. The Cloud shape (`POST /v1/cloud-automations`) yields a
 * cloud-placed Automation that keeps running when this Mac is off, executes in
 * OpenWork Cloud, and therefore cannot read this coworker's local files or
 * memory. This module owns that contract so the UI can only describe what the
 * platform will actually do.
 *
 * Model options mirror the OpenWork desktop's Automation editor: Den's
 * member-scoped `/v1/llm-providers` list plus the free starter model, with
 * submitted ids normalized to the ids Den revalidates (`opencode`, `openwork`,
 * or a concrete `lpr_*` provider record).
 */
import {
  AUTOMATION_FREE_MODEL,
  type AutomationExecutionTarget,
  type AutomationModel,
  type AutomationRun,
  type AutomationSchedule,
} from "@openwork/types/automations";
import { INFERENCE_MODEL_ALIASES } from "@openwork/types/den/inference";

export type DenLlmProviderModel = { id: string; name: string };

export type DenLlmProvider = {
  /** Den record id; for custom providers this is the `lpr_*` id Den expects back. */
  id: string;
  source: "models_dev" | "custom" | "openwork";
  /** Upstream provider key (for example `anthropic`). */
  providerId: string;
  name: string;
  models: DenLlmProviderModel[];
};

export type CloudModelAccess = "free" | "openwork_managed" | "authorized_custom";

export type CloudModelOption = {
  /** `providerId/modelId` in the exact form Den revalidates. */
  id: string;
  providerId: string;
  modelId: string;
  providerName: string;
  modelName: string;
  accessKind: CloudModelAccess;
};

export type CloudModelResolution = "exact" | "mapped" | "default";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function parseProviderModel(value: unknown): DenLlmProviderModel | null {
  if (!isRecord(value)) return null;
  const id = readString(value.id);
  if (!id) return null;
  return { id, name: readString(value.name) || id };
}

function parseProvider(value: unknown): DenLlmProvider | null {
  if (!isRecord(value)) return null;
  const id = readString(value.id);
  const providerId = readString(value.providerId);
  const source = value.source;
  if (!id || !providerId) return null;
  if (source !== "models_dev" && source !== "custom" && source !== "openwork") return null;
  return {
    id,
    source,
    providerId,
    name: readString(value.name) || providerId,
    models: Array.isArray(value.models)
      ? value.models.map(parseProviderModel).filter((model): model is DenLlmProviderModel => model !== null)
      : [],
  };
}

/** Lenient reader for Den's `GET /v1/llm-providers` payload. */
export function parseDenLlmProviders(payload: unknown): DenLlmProvider[] {
  if (!isRecord(payload) || !Array.isArray(payload.llmProviders)) return [];
  return payload.llmProviders.map(parseProvider).filter((provider): provider is DenLlmProvider => provider !== null);
}

const ACCESS_ORDER: CloudModelAccess[] = ["free", "openwork_managed", "authorized_custom"];

const freeStarter: CloudModelOption = {
  id: `${AUTOMATION_FREE_MODEL.providerId}/${AUTOMATION_FREE_MODEL.modelId}`,
  providerId: AUTOMATION_FREE_MODEL.providerId,
  modelId: AUTOMATION_FREE_MODEL.modelId,
  providerName: AUTOMATION_FREE_MODEL.providerName,
  modelName: AUTOMATION_FREE_MODEL.modelName,
  accessKind: "free",
};

function openWorkManagedOptions(provider: DenLlmProvider): CloudModelOption[] {
  return Object.entries(INFERENCE_MODEL_ALIASES)
    .filter(([, alias]) => alias.enabled)
    .map(([modelId, alias]) => ({
      id: `openwork/${modelId}`,
      providerId: "openwork",
      modelId,
      providerName: provider.name,
      modelName: alias.displayName.replace(/^OpenWork:\s*/, ""),
      accessKind: "openwork_managed" as const,
    }));
}

function authorizedCustomOptions(provider: DenLlmProvider): CloudModelOption[] {
  return provider.models.map((model) => ({
    id: `${provider.id}/${model.id}`,
    providerId: provider.id,
    modelId: model.id,
    providerName: provider.name,
    modelName: model.name,
    accessKind: "authorized_custom" as const,
  }));
}

/**
 * The models a Cloud run may use. Den already scopes the provider list to the
 * signed-in member, so nothing here consults the local engine catalog: a model
 * that works on this Mac is not automatically authorized in OpenWork Cloud.
 */
export function cloudModelOptions(
  providers: readonly DenLlmProvider[],
  options: { includeFreeStarter?: boolean } = {},
): CloudModelOption[] {
  const managed = providers.flatMap((provider) =>
    provider.source === "openwork" ? openWorkManagedOptions(provider) : authorizedCustomOptions(provider),
  );
  const all = options.includeFreeStarter === false ? managed : [freeStarter, ...managed];
  return all.sort(
    (left, right) =>
      ACCESS_ORDER.indexOf(left.accessKind) - ACCESS_ORDER.indexOf(right.accessKind) ||
      left.providerName.localeCompare(right.providerName) ||
      left.modelName.localeCompare(right.modelName),
  );
}

export function findCloudModelOption(
  options: readonly CloudModelOption[],
  model: Pick<AutomationModel, "providerId" | "modelId">,
): CloudModelOption | null {
  return options.find((option) => option.providerId === model.providerId && option.modelId === model.modelId) ?? null;
}

/**
 * Turn a coworker's local model preference (`providerId/modelId` against the
 * local engine) into a Cloud-authorized model. Exact ids win; a local
 * `anthropic/...` preference maps onto the organization's `lpr_*` record for
 * the same upstream provider and model; anything else falls back to the free
 * starter (or the first authorized option when the starter is excluded).
 */
export function resolveCloudModel(
  preferred: { model: string; modelVariant?: string } | undefined,
  providers: readonly DenLlmProvider[],
  options: readonly CloudModelOption[] = cloudModelOptions(providers),
): { model: AutomationModel; resolution: CloudModelResolution } {
  const fallbackOption = options.find((option) => option.accessKind === "free") ?? options[0];
  const fallback: AutomationModel = fallbackOption
    ? { providerId: fallbackOption.providerId, modelId: fallbackOption.modelId, variant: null }
    : { providerId: AUTOMATION_FREE_MODEL.providerId, modelId: AUTOMATION_FREE_MODEL.modelId, variant: null };

  const raw = preferred?.model.trim() ?? "";
  const separator = raw.indexOf("/");
  if (separator <= 0 || separator === raw.length - 1) return { model: fallback, resolution: "default" };
  const providerId = raw.slice(0, separator);
  const modelId = raw.slice(separator + 1);
  const variant = preferred?.modelVariant?.trim() || null;

  if (findCloudModelOption(options, { providerId, modelId })) {
    return { model: { providerId, modelId, variant }, resolution: "exact" };
  }

  const mapped = providers.find(
    (provider) =>
      provider.source !== "openwork" &&
      provider.providerId === providerId &&
      provider.models.some((model) => model.id === modelId),
  );
  if (mapped) {
    return { model: { providerId: mapped.id, modelId, variant }, resolution: "mapped" };
  }

  return { model: fallback, resolution: "default" };
}

export type CloudResponsibilityDraft = {
  name: string;
  instructions: string;
  schedule: AutomationSchedule;
  model: AutomationModel;
};

/** Exact `POST /v1/cloud-automations` body: placement is fixed to OpenWork Cloud by Den. */
export function cloudResponsibilityBody(draft: CloudResponsibilityDraft) {
  return {
    name: draft.name.trim(),
    schedule: draft.schedule,
    action: {
      kind: "agent" as const,
      instructions: draft.instructions.trim(),
      model: {
        providerId: draft.model.providerId,
        modelId: draft.model.modelId,
        variant: draft.model.variant?.trim() || null,
      },
    },
  };
}

export type ResponsibilityPlacement = {
  target: AutomationExecutionTarget | "unknown";
  label: string;
  detail: string;
};

/**
 * What a Den Automation's recorded placement means for this coworker. Only
 * `cloud` keeps running with this Mac off; `desktop` depends on an OpenWork
 * desktop runner that Open Coworker does not host.
 */
export function describePlacement(target: AutomationExecutionTarget | null | undefined): ResponsibilityPlacement {
  if (target === "cloud") {
    return {
      target,
      label: "OpenWork Cloud",
      detail:
        "Runs in OpenWork Cloud even when this Mac is off. Cloud runs cannot read this coworker's local files or memory.",
    };
  }
  if (target === "desktop") {
    return {
      target,
      label: "OpenWork desktop",
      detail:
        "Runs only while the OpenWork desktop app is open for your account. Open Coworker does not run these; occurrences are recorded as missed otherwise.",
    };
  }
  return {
    target: "unknown",
    label: "Placement unknown",
    detail: "OpenWork did not report where this Automation runs.",
  };
}

function humanizeStatus(status: string): string {
  const readable = status.replaceAll("_", " ");
  return readable.slice(0, 1).toUpperCase() + readable.slice(1);
}

/** One line for a run: status, then Den's own reason when the run did not succeed. */
export function describeRunOutcome(run: Pick<AutomationRun, "status" | "error"> | null | undefined): string {
  if (!run) return "Never";
  const status = humanizeStatus(run.status);
  const reason = run.error?.message?.trim();
  return reason && run.status !== "succeeded" ? `${status} · ${reason}` : status;
}
