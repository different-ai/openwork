export const DEFAULT_PREVIEW_ITEMS = [
  { name: "Sales Inbound", kind: "Agent", meta: "Agent · v1.2.0", tone: "agent" },
  { name: "follow-up-reminder", kind: "Skill", meta: "Skill · Trigger", tone: "skill" },
  { name: "crm-sync", kind: "MCP", meta: "MCP · Remote", tone: "mcp" },
  { name: "openwork.json", kind: "Config", meta: "OpenWork config", tone: "config" },
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

export function getPublishWarnings({ generatedUrl, warnings }) {
  if (generatedUrl || !Array.isArray(warnings) || warnings.length === 0) {
    return null;
  }

  return {
    title: "Review before sharing",
    copy: "Some files were skipped or adjusted. Check these before generating a public link.",
    items: warnings,
  };
}

export function getPublishedWarnings({ generatedUrl, warnings }) {
  if (!generatedUrl) {
    return null;
  }

  const items = Array.isArray(warnings) && warnings.length
    ? warnings.map((warning) => ({ text: warning, empty: false }))
    : [{ text: "No warnings. Package is clean.", empty: true }];

  return {
    title: "Warnings",
    copy: "Review any files that were skipped.",
    items,
  };
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
