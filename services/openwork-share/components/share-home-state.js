export const DEFAULT_PREVIEW_ITEMS = [
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
    example: `{\n  "mcpServers": {\n    "crm-sync": {\n      "url": "https://mcp.example.com/crm-sync",\n      "transport": "sse",\n      "description": "Syncs contacts, deals, and activities with the CRM."\n    }\n  }\n}`,
  },
  {
    name: "openwork.json",
    kind: "Config",
    meta: "OpenWork config",
    tone: "config",
    example: `{\n  "name": "my-workspace",\n  "version": "0.1.0",\n  "agents": ["sales-inbound"],\n  "skills": ["meeting-reminder"],\n  "mcpServers": {\n    "crm-sync": {\n      "url": "https://mcp.example.com/crm-sync"\n    }\n  }\n}`,
  },
];

export function getPreviewItems(preview) {
  const items = Array.isArray(preview?.items) && preview.items.length ? preview.items : DEFAULT_PREVIEW_ITEMS;
  return items.slice(0, 4);
}

export function getSummaryCards(preview) {
  return [
    { label: "Skills", value: preview?.summary?.skills ?? 1 },
    { label: "Agents", value: preview?.summary?.agents ?? 1 },
    { label: "MCPs", value: preview?.summary?.mcpServers ?? 1 },
    { label: "Commands", value: preview?.summary?.commands ?? 0 },
    { label: "Configs", value: preview?.summary?.configs ?? 1 },
  ];
}

export function getPreviewPanelState({ generatedUrl, preview, effectiveEntryCount }) {
  if (generatedUrl) {
    return {
      chipLabel: "Published link",
      stateLabel: "Published",
      isReady: true,
      title: "Share link ready",
      copy: "Your worker package is published. Anyone with this link can import it directly into OpenWork.",
      mode: "published",
    };
  }

  return {
    chipLabel: "Preview",
    stateLabel: preview ? "Ready to publish" : effectiveEntryCount ? "Previewing" : "Landing sample",
    isReady: Boolean(preview),
    title: "Worker package",
    copy: "Review the inferred package before publishing a public import page.",
    mode: "preview",
  };
}

export function getPackageStatus({ generatedUrl, warnings, preview, effectiveEntryCount, busy }) {
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

  if (busy) {
    return { severity: "neutral", label: "Processing...", items: [] };
  }

  if (!effectiveEntryCount) {
    return { severity: "neutral", label: "Drop files or pick an example to get started", items: [] };
  }

  if (!preview) {
    return { severity: "neutral", label: "Analyzing contents...", items: [] };
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

export function getShareFeedback(copyState) {
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
