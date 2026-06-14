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
  download: "https://app.openworklabs.com?mode=sign-up",
  pricing: "/pricing",
  enterprise: "/enterprise",
  cloud: "https://app.openworklabs.com",
  docs: "/docs",
  trust: "/trust",
  feedback: "/feedback",
}

const pricingSummary = {
  plans: [
    {
      id: "solo",
      name: "Solo",
      price: "Free",
      cadence: "free forever",
      highlights: [
        "Open-source desktop app",
        "macOS and Linux downloads",
        "Bring your own provider keys",
      ],
      cta: { label: "Get Started for free", href: "https://app.openworklabs.com?mode=sign-up" },
    },
    {
      id: "team-starter",
      name: "Team Starter",
      price: "$10",
      cadence: "per seat / month",
      highlights: [
        "First 5 seats free",
        "API access",
        "Extension Marketplace",
        "Bring your own LLM keys, distributed to your team",
      ],
      cta: { label: "Start team plan", href: "https://app.openworklabs.com/dashboard/billing" },
    },
    {
      id: "enterprise",
      name: "Enterprise",
      price: "custom",
      cadence: "contact us",
      highlights: [
        "Everything in Team Starter",
        "SSO / SAML and SCIM provisioning",
        "Bring your own inference — self-hosted or private models",
        "Desktop policies and version controls",
        "Managed deployment, self-hosted or hosted",
        "Custom skill development and MCP consulting",
        "Enterprise rollout support and custom commercial terms",
      ],
      cta: { label: "Talk to us", href: "/enterprise#book" },
    },
  ],
  notes: "Prices exclude taxes.",
}

const downloadLinks = {
  page: "https://app.openworklabs.com?mode=sign-up",
  platforms: {
    macos: {
      page: "https://app.openworklabs.com?mode=sign-up",
      note: "Sign up for OpenWork Cloud first, then use the guided desktop app access flow.",
    },
    windows: {
      page: "https://app.openworklabs.com?mode=sign-up",
      note: "Sign up for OpenWork Cloud first, then use the guided desktop app access flow.",
    },
    linux: {
      page: "https://app.openworklabs.com?mode=sign-up",
      note: "Sign up for OpenWork Cloud first, then use the guided desktop app access flow.",
    },
  },
}

const tools: Tool[] = [
  {
    name: "navigate_to",
    description:
      "Navigate the current tab to a key section of openworklabs.com. Use this when the user expresses intent to view pricing, download, enterprise, cloud, docs, trust, or feedback.",
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
      "Return the canonical cloud signup URL users should visit before getting desktop app access. Read-only; does not navigate.",
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
