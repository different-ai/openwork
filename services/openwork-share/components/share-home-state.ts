import type { PreviewItem, PackageStatusInput, PackageStatus, CopyState, ShareFeedback } from "./share-home-types";

const DEFAULT_PREVIEW_ITEMS: PreviewItem[] = [
  {
    name: "Sales Inbound",
    kind: "Agent",
    meta: "Agent · v1.2.0",
    tone: "agent",
    example: `# Sales Inbound Agent\n\nIdentity: Sales Inbound v1.2.0\n\nScope: handle inbound sales leads, qualify prospects, and route to the right team member.\n\nDefault behaviors:\n\n1) Lead qualification\n- Score inbound leads based on company size, role, and intent signals.\n- Route high-intent leads to the closer queue immediately.\n\n2) Follow-up cadence\n- If no response after 24h, send a personalized follow-up.\n- Escalate to manager after 3 unanswered follow-ups.\n`,
  },
  {
    name: "meeting-reminder",
    kind: "Skill",
    meta: "Skill · Trigger",
    tone: "skill",
    example: `# meeting-reminder\n\nA skill that sends a follow-up reminder after a configurable delay.\n\n## Trigger\n\nRuns automatically when a conversation has been idle for the configured duration.\n\n## Parameters\n\n- delay: Duration before triggering (default: "24h")\n- channel: Where to send the reminder ("email" | "slack" | "in-app")\n- message_template: Handlebars template for the reminder body\n`,
  },
  {
    name: "crm-sync",
    kind: "MCP",
    meta: "MCP · Remote",
    tone: "mcp",
    example: JSON.stringify({
      mcpServers: {
        "crm-sync": {
          url: "https://mcp.example.com/crm-sync",
          transport: "sse",
          description: "Syncs contacts, deals, and activities with the CRM.",
        },
      },
    }, null, 2),
  },
  {
    name: "openwork.json",
    kind: "Config",
    meta: "OpenWork config",
    tone: "config",
    example: JSON.stringify({
      name: "my-workspace",
      version: "0.1.0",
      agents: ["sales-inbound"],
      skills: ["meeting-reminder"],
      mcpServers: {
        "crm-sync": {
          url: "https://mcp.example.com/crm-sync",
        },
      },
    }, null, 2),
  },
];

export function getPreviewItems(preview: { items?: PreviewItem[] } | null): PreviewItem[] {
  const items = Array.isArray(preview?.items) && preview!.items!.length ? preview!.items! : DEFAULT_PREVIEW_ITEMS;
  return items.slice(0, 4);
}

export function getSelectionLabel(hasSelection: boolean): string {
  return hasSelection ? "File ready to share" : "Drop files or paste content";
}

export function getPreviewFilename(input: {
  selectedEntryCount: number;
  selectedEntryName?: string | null;
  hasPastedContent: boolean;
}): string {
  const { selectedEntryCount, selectedEntryName, hasPastedContent } = input;

  if (selectedEntryCount === 1 && selectedEntryName) return selectedEntryName;
  if (selectedEntryCount > 1) return `${selectedEntryCount} files`;
  if (hasPastedContent) return "clipboard";
  return "untitled";
}

export function getPackageStatus({ generatedUrl, warnings, effectiveEntryCount }: PackageStatusInput): PackageStatus {
  const hasWarnings = Array.isArray(warnings) && warnings.length > 0;
  const hasSecretWarning = hasWarnings && warnings.some((w) => /redacted|secret/i.test(w));

  if (generatedUrl) {
    if (hasWarnings) {
      return {
        severity: hasSecretWarning ? "warn" : "info",
        label: hasSecretWarning ? "Published with redactions" : "Published with notes",
        items: warnings,
      };
    }
    return { severity: "success", label: "Clean — no issues detected", items: [] };
  }

  if (!effectiveEntryCount) {
    return { severity: "neutral", label: "Drop files or pick an example to get started", items: [] };
  }

  if (hasWarnings) {
    return {
      severity: hasSecretWarning ? "warn" : "info",
      label: hasSecretWarning
        ? `${warnings.length} item${warnings.length === 1 ? "" : "s"} redacted — review before sharing`
        : `${warnings.length} note${warnings.length === 1 ? "" : "s"} — review before sharing`,
      items: warnings,
    };
  }

  return { severity: "success", label: "Ready — no issues detected", items: [] };
}

export function getShareFeedback(copyState: CopyState): ShareFeedback {
  if (copyState === "copied") {
    return {
      badge: "Copied to clipboard",
      detail: "Share it now or copy it again if you need another pass.",
      copyLabel: "Copy again",
      isSuccess: true,
    };
  }

  if (copyState === "copy-failed") {
    return {
      badge: "Clipboard blocked",
      detail: "The link is ready, but your browser blocked clipboard access. Copy it manually.",
      copyLabel: "Copy link",
      isSuccess: false,
    };
  }

  return {
    badge: "Link ready",
    detail: "Share it now or copy it manually if you need another pass.",
    copyLabel: "Copy link",
    isSuccess: false,
  };
}
