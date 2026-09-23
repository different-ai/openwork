import { create } from "zustand";
import type { ModelOption, ModelRef } from "@/app/types";
import { gatewayConnectProviderKey, type GatewayConnectProvider } from "./cloud-provider-config";

/**
 * First chat: the model the company picked for this person needs their own
 * sign-in. Instead of opening the picker by itself, OpenWork starts them on a
 * model that works and offers the sign-in in a notice above the composer.
 */

export type ModelSignInNotice = {
  /** The model the organization picked, waiting on this person's sign-in. */
  wanted: ModelRef;
  modelName: string;
  organizationName: string | null;
  provider: GatewayConnectProvider;
  dismissKey: string;
};

type NoticeStore = {
  notice: ModelSignInNotice | null;
  setNotice: (notice: ModelSignInNotice | null) => void;
};

export const useModelSignInNoticeStore = create<NoticeStore>((set) => ({
  notice: null,
  setNotice: (notice) => set({ notice }),
}));

const DISMISSED_KEY = "openwork.modelSignInNotice.dismissed";

export function modelSignInNoticeDismissKey(organizationId: string, model: ModelRef) {
  return `${organizationId}:${model.providerID}/${model.modelID}`;
}

export function readDismissedModelSignInNotices(storage: Pick<Storage, "getItem"> | null = safeStorage()): Set<string> {
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(DISMISSED_KEY) ?? "[]");
    return new Set(Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : []);
  } catch {
    return new Set();
  }
}

/** Dismissing is remembered per organization and default model, so it doesn't return in every new session. */
export function dismissModelSignInNotice(key: string, storage: Pick<Storage, "getItem" | "setItem"> | null = safeStorage()) {
  const next = readDismissedModelSignInNotices(storage);
  next.add(key);
  try {
    storage?.setItem(DISMISSED_KEY, JSON.stringify([...next].slice(-50)));
  } catch {
    // Storage is best effort; the notice simply shows again next time.
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export type FirstChatModelDecision =
  | { kind: "none" }
  /** Use a model that works now and offer sign-in for the one the organization picked. */
  | { kind: "fallback"; fallback: ModelRef; wanted: ModelRef; modelName: string; provider: GatewayConnectProvider }
  /** The organization's model is ready now; switch back to it. */
  | { kind: "restore"; wanted: ModelRef };

/**
 * Decide the composer's model when the default needs the person's sign-in.
 * Pure so the rule is testable: fall back to the first ready OpenWork Models
 * model (any ready model if there is none), and switch back once the wanted
 * model is ready.
 */
export function decideFirstChatModel(input: {
  currentDefault: ModelRef | null;
  /** The organization's model this person is waiting to use, if any. */
  wanted: ModelRef | null;
  pendingOptions: readonly ModelOption[];
  providers: readonly GatewayConnectProvider[];
  readyOptions: readonly Pick<ModelOption, "providerID" | "modelID">[];
}): FirstChatModelDecision {
  const same = (left: ModelRef, right: Pick<ModelOption, "providerID" | "modelID">) => left.providerID === right.providerID && left.modelID === right.modelID;
  if (input.wanted) {
    const wanted = input.wanted;
    const stillPending = input.pendingOptions.some((option) => same(wanted, option));
    if (!stillPending && input.readyOptions.some((option) => same(wanted, option))) return { kind: "restore", wanted };
    return { kind: "none" };
  }
  const current = input.currentDefault;
  if (!current) return { kind: "none" };
  const pending = input.pendingOptions.find((option) => same(current, option));
  if (!pending?.gatewayAuthorization) return { kind: "none" };
  const key = gatewayConnectProviderKey(pending.gatewayAuthorization);
  const provider = input.providers.find((entry) => gatewayConnectProviderKey(entry) === key);
  const ready = input.readyOptions.filter((option) => !input.pendingOptions.some((entry) => same(entry, option)));
  const fallback = ready.find((option) => option.providerID === "openwork") ?? ready[0];
  if (!provider || !fallback) return { kind: "none" };
  return {
    kind: "fallback",
    fallback: { providerID: fallback.providerID, modelID: fallback.modelID },
    wanted: current,
    modelName: pending.title,
    provider,
  };
}
