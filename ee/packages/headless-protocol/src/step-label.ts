/** A short, human label for one agent step, for Slack's task timeline and Workbot's step list. */
export function stepLabel(name: string, input: Record<string, unknown> = {}) {
  const app = typeof input.name === "string" ? APP_NAMES.find(([pattern]) => pattern.test(String(input.name)))?.[1] : undefined
  const path = typeof input.path === "string" ? input.path : undefined
  switch (name) {
    case "search_capabilities":
      return "Finding the right tool"
    case "execute_capability":
      if (typeof input.name === "string" && /createCloudAutomation$/i.test(input.name)) return "Setting up the schedule"
      // Capability names are internal ("getMe"); the person only knows their apps.
      return app ? `Using ${app}` : "Checking your apps"
    case "execute_capability_script":
      return "Running a multi-step action"
    case "list_skills":
    case "get_skill":
      return "Reading skills"
    case "write_file":
    case "edit_file":
      return path ? `Writing ${path}` : "Writing a draft"
    case "read_file":
    case "list_files":
      return path ? `Reading ${path}` : "Reading notes"
    case "bash":
      return typeof input.description === "string" && input.description.trim() ? input.description.trim().slice(0, 80) : "Using my computer"
    case "look":
      return "Looking at the results"
    case "browser_open":
    case "browser_navigate":
      return typeof input.url === "string" ? `Opening ${hostOf(input.url)}` : "Opening the browser"
    case "browser_observe":
      return "Looking at the page"
    case "browser_act":
      return "Working in the browser"
    case "browser_handoff":
      return "Waiting for you to sign in"
    default:
      return name.replaceAll("_", " ")
  }
}

const APP_NAMES: Array<[RegExp, string]> = [
  [/slack/i, "Slack"],
  [/gmail/i, "Gmail"],
  [/calendar/i, "Google Calendar"],
  [/drive|docs|sheets/i, "Google Drive"],
  [/notion/i, "Notion"],
  [/linear/i, "Linear"],
  [/github/i, "GitHub"],
  [/outlook|microsoft|teams|onedrive|sharepoint/i, "Microsoft 365"],
  [/hubspot/i, "HubSpot"],
  [/salesforce/i, "Salesforce"],
  [/jira|confluence|atlassian/i, "Atlassian"],
]

function hostOf(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "")
  } catch {
    return "a page"
  }
}
