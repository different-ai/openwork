import type { WorkbotModelRecovery } from "@openwork/types/den/workbot-settings";

export type WorkbotModelIssue = "free_limit" | "usage_limit" | "payment_required";

/** A Den page this person may open; Den rechecks permissions and selects the conversation's workspace. */
export type RecoveryLink = { kind: "link"; label: string; path: string };
/** Visible but not available to this person: says who can do it (DESIGN P4). Never a dead button. */
export type RecoveryLock = { kind: "locked"; label: string; reason: string };

/**
 * One usage-limit card, the same anatomy as the desktop: what ran out, when it resets, that the message is saved,
 * one primary action for this person's role, and a way to keep working.
 */
export type ModelRecoveryView = {
  title: string;
  resetsAt: string | null;
  note: string | null;
  primary: RecoveryLink | RecoveryLock | null;
  changeModel: RecoveryLink | null;
  check: "check" | "retry";
};

export const MODELS_PAGE = "ai-gateway?tab=openwork-models";
export const WORKBOT_MODEL_PAGE = "workbot-settings";
export const BILLING_PAGE = "billing";

/**
 * Who can buy is decided by Den (`purchaseEligible` needs billing rights and configured billing); Workbot never
 * offers checkout from its own guess. Without options (still loading or unreadable) nothing is offered.
 */
export function modelRecoveryView(issue: WorkbotModelIssue, options: WorkbotModelRecovery | undefined): ModelRecoveryView {
  const changeModel: RecoveryLink | null = options?.canManageModels && !(issue === "free_limit" && options.managedLuna && options.paidContinuation === "authorized")
    ? { kind: "link", label: "Change model", path: WORKBOT_MODEL_PAGE } : null;
  if (issue === "free_limit") {
    const confirmed = options?.freeExhausted === true;
    const paidReady = Boolean(options?.managedLuna && options.paidContinuation === "authorized");
    const offerModels = Boolean(confirmed && options?.purchaseEligible && !options.hasModelsSubscription
      && (options.canUpgrade || options.paidContinuation === "after_upgrade") && options.upgradeBlockedReason === null);
    const billingCapable = Boolean(options?.purchaseEligible || options?.canManageBilling);
    const primary: ModelRecoveryView["primary"] = !options || paidReady ? null
      : offerModels ? { kind: "link", label: "Get OpenWork Models", path: MODELS_PAGE }
        : options.hasModelsSubscription ? null
          : confirmed && options.canManageModels ? { kind: "link", label: "Review OpenWork Models", path: MODELS_PAGE }
          : billingCapable ? null
            : { kind: "locked", label: "Ask an admin for OpenWork Models", reason: "Only people with billing access can get OpenWork Models." };
    const note = !options ? null
      : paidReady ? "Paid Luna is ready. Your next message in this conversation uses your Models subscription. Auto’s free allowance stays separate."
        : options.managedLuna && options.hasModelsSubscription ? "Your Models access isn’t ready yet. Check access again shortly."
          : !confirmed ? "Workbot’s model access needs checking."
            : null;
    return {
      title: confirmed || !options ? "You've used the free model allowance for now" : "Workbot couldn’t use its free model",
      resetsAt: confirmed && options?.freeResetsAt ? options.freeResetsAt : null,
      note, primary, changeModel, check: confirmed ? "check" : "retry",
    };
  }
  if (issue === "usage_limit") {
    return {
      title: "Your workspace reached its model usage limit",
      resetsAt: null, note: null,
      primary: !options || options.canManageModels ? null
        : { kind: "locked", label: "Ask an admin for more", reason: "Workspace admins can raise the limit or choose another model." },
      changeModel, check: "retry",
    };
  }
  return {
    title: "OpenWork Models needs a billing update",
    resetsAt: null, note: null,
    primary: !options ? null
      : options.canManageBilling ? { kind: "link", label: "Manage billing", path: BILLING_PAGE }
        : { kind: "locked", label: "Ask an admin to update billing", reason: "Only people with billing access can update payment details." },
    changeModel, check: "retry",
  };
}
