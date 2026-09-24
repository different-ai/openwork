// Copy for the model-shortcut notice (DESIGN.md C1, C5, C6): state what
// happened and the one next action. Pure so wording is tested with the rules.
import type { ModelUnavailableReason } from "@/react-app/domains/session/surface/model-availability";

import type { ModelShortcutNoticeTone } from "./model-shortcut-notice";

export type NoticeActionKind = "undo" | "reconnect" | "pick_another";

export type NoticeCopy = {
  tone: ModelShortcutNoticeTone;
  title: string;
  detail?: string;
  fast?: boolean;
  actions: Array<{ kind: NoticeActionKind; label: string; primary?: boolean }>;
};

export function switchedNoticeCopy(input: {
  modelTitle: string;
  effortLabel: string | null;
  fastApplied: boolean;
  fastSkipped: boolean;
  effortSkipped: boolean;
  requestedEffortLabel: string | null;
}): NoticeCopy {
  const undo = { kind: "undo" as const, label: "Undo" };
  if (input.fastSkipped) {
    return {
      tone: "info",
      title: `Switched to ${input.modelTitle}`,
      detail: "at standard speed. Fast isn't offered right now.",
      actions: [undo],
    };
  }
  if (input.effortSkipped) {
    return {
      tone: "info",
      title: `Switched to ${input.modelTitle}`,
      detail: `${input.requestedEffortLabel ?? "That"} reasoning isn't offered, using default.`,
      actions: [undo],
    };
  }
  const parts = [
    input.effortLabel ? `${input.effortLabel.toLowerCase()} reasoning` : null,
    input.fastApplied ? "Fast" : null,
  ].filter((part): part is string => Boolean(part));
  return {
    tone: "success",
    title: `Switched to ${input.modelTitle}`,
    detail: parts.length > 0 ? parts.join(", ") : undefined,
    fast: input.fastApplied,
    actions: [undo],
  };
}

export function unavailableNoticeCopy(input: {
  modelTitle: string;
  providerName: string | null;
  reason: ModelUnavailableReason;
}): NoticeCopy {
  const provider = input.providerName?.trim() || "Its provider";
  switch (input.reason) {
    case "provider_blocked":
      return {
        tone: "blocked",
        title: `${input.modelTitle} is blocked`,
        detail: "by your organization's policy. Ask an admin to allow it.",
        actions: [{ kind: "pick_another", label: "Pick another model" }],
      };
    case "provider_not_connected":
      return {
        tone: "warning",
        title: `${input.modelTitle} isn't available`,
        detail: `${provider} is disconnected.`,
        actions: [
          { kind: "pick_another", label: "Pick another" },
          { kind: "reconnect", label: `Reconnect ${input.providerName?.trim() || "provider"}`, primary: true },
        ],
      };
    case "model_missing":
      return {
        tone: "error",
        title: `${input.modelTitle} isn't available`,
        detail: `${provider} no longer offers it.`,
        actions: [{ kind: "pick_another", label: "Pick another model", primary: true }],
      };
  }
}
