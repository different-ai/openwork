/** A short, human label for one agent step, for Slack's task timeline and Workbot's step list. */
export function stepLabel(name: string, input: Record<string, unknown> = {}) {
  const target = typeof input.name === "string" ? input.name.split(/[:/]/).pop()?.replaceAll("_", " ") : undefined
  const path = typeof input.path === "string" ? input.path : undefined
  switch (name) {
    case "search_capabilities":
      return "Finding the right tool"
    case "execute_capability":
      if (typeof input.name === "string" && /createCloudAutomation$/i.test(input.name)) return "Setting up the schedule"
      return target ? `Using ${target}` : "Using your connections"
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

function hostOf(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "")
  } catch {
    return "a page"
  }
}
