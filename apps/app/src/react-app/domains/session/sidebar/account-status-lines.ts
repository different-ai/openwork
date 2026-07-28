import { t } from "@/i18n";
import type { OpenWorkConnectStatus } from "../../connections/openwork-connect-status";

export type StatusDotVariant = "connected" | "loading" | "partial" | "disconnected";

export type RuntimeStatus = {
  variant: StatusDotVariant;
  label: string;
  detail: string | null;
};

export type AccountStatusLine = {
  testId?: string;
  variant: StatusDotVariant;
  label: string;
  detail: string | null;
};

export function connectDotVariant(status: OpenWorkConnectStatus): StatusDotVariant {
  if (status.state === "ready") return "connected";
  if (status.state === "checking") return "loading";
  return "disconnected";
}

/**
 * What the account menu shows for live status.
 *
 * Everyone gets one summary line ("Ready", or the one problem that matters).
 * Developer mode keeps the old granular breakdown so Connect and the workspace
 * can be inspected separately.
 */
export function resolveAccountStatusLines(input: {
  runtime: RuntimeStatus | null;
  connect: OpenWorkConnectStatus | null;
  developerMode: boolean;
}): AccountStatusLine[] {
  const { runtime, connect, developerMode } = input;
  if (!runtime && !connect) return [];

  if (developerMode) {
    const lines: AccountStatusLine[] = [];
    if (runtime) {
      lines.push({
        variant: runtime.variant,
        label: runtime.label,
        detail: runtime.detail,
      });
    }
    if (connect) {
      lines.push({
        testId: "openwork-connect-status",
        variant: connectDotVariant(connect),
        label: `OpenWork Connect: ${connect.label}`,
        detail: connect.description,
      });
    }
    return lines;
  }

  if (connect?.state === "needs_attention") {
    return [{
      testId: "openwork-connect-status",
      variant: "disconnected",
      label: connect.label,
      detail: connect.description,
    }];
  }

  if (runtime && runtime.variant !== "connected") {
    return [{
      variant: runtime.variant,
      label: runtime.label,
      detail: runtime.detail,
    }];
  }

  // Workspace is fine; Connect is still checking in the background — do not
  // surface that as a second status for non-developers.
  if (runtime?.variant === "connected" || connect?.state === "ready" || connect?.state === "checking") {
    return [{
      variant: "connected",
      label: t("status.ready"),
      detail: null,
    }];
  }

  if (connect) {
    return [{
      testId: "openwork-connect-status",
      variant: connectDotVariant(connect),
      label: connect.label,
      detail: connect.description,
    }];
  }

  return [];
}
