import type { BrowserPanelTab } from "./panel-tab-store";

export const browserOperationLabels: Record<string, string> = {
  observe: "Reading this page", site_tools: "Finding website tools", site_tool: "Using a website tool",
  navigate: "Opening a page", click: "Clicking a control", fill: "Entering text", key: "Using the keyboard", scroll: "Scrolling",
  website_blocked: "This website is blocked", browser_disabled: "Browser control is disabled",
  stale_observation: "A fresh page view is needed", stale_tool: "Website tools have changed", user_denied: "The action was declined",
  needs_attention: "Review this page", sign_in_required: "Sign in directly in this browser", timeout: "Check the page before continuing",
  result_withheld: "Website result was kept private",
};

/** The page needs attention or a human handoff. */
export function browserNeedsPerson(tab: BrowserPanelTab | null | undefined): boolean {
  return tab?.browserTask?.status === "needs_attention";
}

export function browserSiteHost(url: string): string {
  if (!url || url === "about:blank") return "New tab";
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

/** One short state line for the browser's header button and floating card. */
export function browserStatusLabel(tab: BrowserPanelTab | null | undefined): string {
  if (!tab) return "No page open";
  if (browserNeedsPerson(tab)) return "Needs you";
  const task = tab.browserTask;
  if (task?.status === "paused") return "You have control";
  if (task?.status === "running") return browserOperationLabels[task.operation ?? ""] ?? "Working on this page";
  if (tab.status === "suspended") return "Suspended";
  if (tab.status === "loading" || tab.status === "restoring") return "Loading";
  if (tab.loadError) return "Page did not load";
  return "Ready";
}
