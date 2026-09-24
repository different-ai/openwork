import type { UIMessage } from "ai";
import { AUTO_MODEL_ID } from "@/react-app/domains/models/model-catalog";

function field(value: unknown, key: string): unknown {
  return value && typeof value === "object" ? Reflect.get(value, key) : undefined;
}
function text(value: unknown) { return typeof value === "string" && value.trim() ? value.trim() : undefined; }

export function replyModelFromInfo(info: unknown) {
  if (field(info, "role") !== "assistant") return undefined;
  const resolved = field(info, "resolvedModel");
  const model = field(info, "model");
  const resolvedModelID = text(field(resolved, "modelID")) ?? text(field(resolved, "id")) ?? text(field(info, "resolvedModelID"));
  const requestedModelID = text(field(info, "modelID")) ?? text(field(model, "id"));
  const requestedProviderID = text(field(info, "providerID")) ?? text(field(model, "providerID"));
  const modelID = resolvedModelID ?? requestedModelID;
  const providerID = text(field(resolved, "providerID")) ?? text(field(info, "resolvedProviderID")) ?? requestedProviderID;
  const name = text(field(resolved, "name"));
  if (!modelID) return undefined;
  return { modelID, ...(providerID ? { providerID } : {}),
    ...(requestedModelID ? { requestedModelID } : {}),
    ...(requestedProviderID ? { requestedProviderID } : {}),
    ...(resolvedModelID ? { resolved: true, ...(name ? { name } : {}) } : {}),
  };
}

export function mergeReplyMetadata(previous: unknown, next: unknown) {
  const record = (value: unknown): object => value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const previousModel = field(field(previous, "opencode"), "replyModel");
  const nextModel = field(field(next, "opencode"), "replyModel");
  return { ...record(previous), ...record(next), opencode: {
    ...record(field(previous, "opencode")), ...record(field(next, "opencode")),
    ...(previousModel || nextModel ? { replyModel: field(previousModel, "resolved") === true && field(nextModel, "resolved") !== true
      ? { ...record(nextModel), ...record(previousModel) }
      : { ...record(previousModel), ...record(nextModel) } } : {}),
  } };
}

export function replyModelLabel(message: UIMessage) {
  const model = field(field(message.metadata, "opencode"), "replyModel");
  const modelID = text(field(model, "modelID"));
  const providerID = text(field(model, "providerID")) ?? "";
  if (!modelID || field(model, "resolved") !== true || (providerID.startsWith("ipr_") && modelID.startsWith("gwm_"))) return null;
  if (modelID === AUTO_MODEL_ID) return "GPT-5.6 Luna";
  return text(field(model, "name")) ?? modelID;
}
