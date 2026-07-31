import type { AppPermission, InstalledAppRecord } from "@openwork/app-contract";

import type { AppPreview } from "./apps-client";

// The install flow, as a state machine rather than a pile of component state.
//
// Trust review is the step this exists to protect. Getting it right means the
// permissions the user approves are exactly the ones that were on screen, that
// approval cannot be carried over from a previous preview, and that a stale
// review cannot be submitted after the candidate behind it expired.
//
// Keeping it out of the component makes all of that testable without rendering.

export type InstallStep =
  | { step: "idle" }
  | { step: "resolving"; repositoryUrl: string }
  | { step: "review"; preview: AppPreview }
  | { step: "installing"; preview: AppPreview }
  | { step: "setup"; record: InstalledAppRecord; preview: AppPreview }
  | { step: "installed"; record: InstalledAppRecord }
  | { step: "failed"; message: string; diagnostics: string[] };

export type InstallEvent =
  | { type: "submit"; repositoryUrl: string }
  | { type: "resolved"; preview: AppPreview }
  | { type: "confirm" }
  | { type: "installed"; record: InstalledAppRecord }
  | { type: "enabled"; record: InstalledAppRecord }
  | { type: "cancel" }
  | { type: "failed"; message: string; diagnostics?: string[] };

export function initialInstallState(): InstallStep {
  return { step: "idle" };
}

export function reduceInstall(state: InstallStep, event: InstallEvent, now: number): InstallStep {
  switch (event.type) {
    case "submit":
      return { step: "resolving", repositoryUrl: event.repositoryUrl };

    case "resolved":
      // A resolve that lands after the user cancelled must not reopen the
      // review; the only way into review is from an active resolve.
      return state.step === "resolving" ? { step: "review", preview: event.preview } : state;

    case "confirm": {
      if (state.step !== "review") return state;
      if (!state.preview.compatible) {
        return {
          step: "failed",
          message: "This app cannot run on this version of OpenWork.",
          diagnostics: state.preview.warnings,
        };
      }
      if (state.preview.expiresAt <= now) {
        return {
          step: "failed",
          message:
            "This review expired. Look at the app again so you can see what it currently asks for.",
          diagnostics: [],
        };
      }
      return { step: "installing", preview: state.preview };
    }

    case "installed": {
      if (state.step !== "installing") return state;
      const outstanding = state.preview.environment.some(
        (entry) => entry.required && !entry.configured,
      );
      // Setup and enablement are separate steps on purpose: an app is never
      // switched on as a side effect of installing it.
      return outstanding
        ? { step: "setup", record: event.record, preview: state.preview }
        : { step: "installed", record: event.record };
    }

    case "enabled":
      return { step: "installed", record: event.record };

    case "failed":
      return { step: "failed", message: event.message, diagnostics: event.diagnostics ?? [] };

    case "cancel":
      return { step: "idle" };
  }
}

/**
 * The permission set to submit with an installation.
 *
 * Taken from the preview being displayed, never assembled from component state,
 * so what is sent is necessarily what was shown. The server checks this again;
 * the point here is that the client cannot get it wrong in the first place.
 */
export function approvedPermissions(preview: AppPreview): AppPermission[] {
  return preview.permissions.map((entry) => entry.permission);
}

/** Whether the review still has time left, for the countdown and the button. */
export function reviewIsLive(preview: AppPreview, now: number): boolean {
  return preview.expiresAt > now;
}

export type PermissionGroup = {
  risk: "critical" | "high" | "moderate" | "low";
  heading: string;
  items: AppPreview["permissions"];
};

const HEADINGS: Record<PermissionGroup["risk"], string> = {
  critical: "Sensitive access",
  high: "Significant access",
  moderate: "Ordinary access",
  low: "Minor access",
};

/** Group for display, critical first, dropping empty bands. */
export function groupPermissions(preview: AppPreview): PermissionGroup[] {
  const order: PermissionGroup["risk"][] = ["critical", "high", "moderate", "low"];
  return order
    .map((risk) => ({
      risk,
      heading: HEADINGS[risk],
      items: preview.permissions.filter((entry) => entry.risk === risk),
    }))
    .filter((group) => group.items.length > 0);
}

/**
 * A one-line summary of the update, for the pending-review banner.
 *
 * Says what is being *added*, because that is the part the user has not already
 * agreed to. Removals are mentioned only when there is nothing added.
 */
export function describeDelta(delta: {
  entries: Array<{ change: string; permission: { id: string } }>;
}): string {
  const added = delta.entries
    .filter((entry) => entry.change === "added" || entry.change === "widened")
    .map((entry) => entry.permission.id);
  if (added.length > 0) {
    return `This update also wants: ${added.join(", ")}.`;
  }
  const removed = delta.entries
    .filter((entry) => entry.change === "removed" || entry.change === "narrowed")
    .map((entry) => entry.permission.id);
  return removed.length > 0
    ? `This update gives up: ${removed.join(", ")}.`
    : "This update asks for nothing new.";
}
