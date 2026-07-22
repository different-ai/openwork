export const DEFAULT_OPENWORK_DOWNLOAD_URL = "https://openworklabs.com/download"

export type DesktopCapability = {
  title: string
  description: string
}

export const desktopCapabilities: DesktopCapability[] = [
  {
    title: "Edit spreadsheets",
    description: "Create, clean, and transform CSV and Excel files.",
  },
  {
    title: "Control your browser",
    description: "Automate the built-in browser for repetitive web tasks.",
  },
  {
    title: "Organize files",
    description: "Read, write, and manage files and folders.",
  },
  {
    title: "Automate tasks",
    description: "Build reusable workflows with skills and commands.",
  },
  {
    title: "Generate content",
    description: "Draft documents, emails, and reports.",
  },
  {
    title: "Connect to APIs",
    description: "Plug into external services and tools via MCP.",
  },
]
