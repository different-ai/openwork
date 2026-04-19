"use client"

import { useEffect } from "react"

type ModelContext = {
  provideContext: (context: { tools: Tool[] }) => void | Promise<void>
}

type Tool = {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  execute: (args: Record<string, unknown>) => unknown | Promise<unknown>
}

const destinations: Record<string, string> = {
  home: "/",
  download: "/download",
  pricing: "/pricing",
  enterprise: "/enterprise",
  den: "/den",
  docs: "/docs",
  trust: "/trust",
  feedback: "/feedback",
}

const pricingSummary = {
  plans: [
    {
      id: "solo",
      name: "Solo",
      price: "$0",
      cadence: "free forever",
      highlights: [
        "Open-source desktop app",
        "macOS, Windows, Linux downloads",
        "Bring your own provider keys",
      ],
      cta: { label: "Download", href: "/download" },
    },
    {
      id: "team-starter",
      name: "Team Starter",
      price: "$50",
      cadence: "per month",
      highlights: [
        "5 seats included",
        "API access",
        "Skill Hub Manager",
        "Bring your own LLM keys, distributed to your team",
      ],
      cta: { label: "Start team plan", href: "https://app.openworklabs.com/checkout" },
    },
    {
      id: "enterprise",
      name: "Enterprise",
      price: "custom",
      cadence: "contact us",
      highlights: [
        "Enterprise rollout support",
        "Deployment guidance",
        "Custom commercial terms",
      ],
      cta: { label: "Talk to us", href: "/enterprise#book" },
    },
  ],
  notes: "Prices exclude taxes.",
}

const downloadLinks = {
  page: "https://openworklabs.com/download",
  githubReleases: "https://github.com/different-ai/openwork/releases/latest",
  platforms: {
    macos: {
      page: "https://openworklabs.com/download#macos",
      note: "Apple Silicon (.dmg) and Intel (.dmg) builds resolved from the latest GitHub release.",
    },
    windows: {
      page: "https://openworklabs.com/download#windows",
      note: "x64 MSI installer resolved from the latest GitHub release.",
    },
    linux: {
      page: "https://openworklabs.com/download#linux",
      aur: "yay -S openwork",
      note: "AUR plus .deb and .rpm packages for x64 and arm64.",
    },
  },
}

const tools: Tool[] = [
  {
    name: "navigate_to",
    description:
      "Navigate the current tab to a key section of openworklabs.com. Use this when the user expresses intent to view pricing, download, enterprise, den (cloud), docs, trust, or feedback.",
    inputSchema: {
      type: "object",
      properties: {
        destination: {
          type: "string",
          enum: Object.keys(destinations),
          description: "The named section to navigate to.",
        },
      },
      required: ["destination"],
      additionalProperties: false,
    },
    execute: async (args) => {
      const key = String(args.destination ?? "")
      const href = destinations[key]
      if (!href) {
        return { ok: false, error: `unknown destination: ${key}` }
      }
      if (typeof window !== "undefined") {
        window.location.assign(href)
      }
      return { ok: true, href }
    },
  },
  {
    name: "open_enterprise_contact",
    description:
      "Navigate to the Enterprise page and scroll to the book-a-call section. Use this when the user wants to talk to sales or needs SSO, audit, or procurement support.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    execute: async () => {
      if (typeof window !== "undefined") {
        window.location.assign("/enterprise#book")
      }
      return { ok: true, href: "/enterprise#book" }
    },
  },
  {
    name: "get_pricing_summary",
    description:
      "Return OpenWork's pricing tiers, what each includes, and the CTA destination. Read-only; does not navigate.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    execute: async () => pricingSummary,
  },
  {
    name: "get_download_links",
    description:
      "Return the canonical download page URLs per platform plus the GitHub releases URL. Use this to tell the user where to get the desktop app. Read-only; does not navigate.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    execute: async () => downloadLinks,
  },
]

export function WebMcpProvider() {
  useEffect(() => {
    const nav = typeof navigator === "undefined" ? null : (navigator as Navigator & { modelContext?: ModelContext })
    const modelContext = nav?.modelContext
    if (!modelContext || typeof modelContext.provideContext !== "function") return

    try {
      const result = modelContext.provideContext({ tools })
      if (result && typeof (result as Promise<unknown>).catch === "function") {
        ;(result as Promise<unknown>).catch(() => {})
      }
    } catch {
      // Silently ignore: WebMCP is best-effort.
    }
  }, [])

  return null
}
