import { Globe, Monitor, Plug, Route, type LucideIcon } from "lucide-react";

export type LpProductKey = "mcp-gateway" | "ai-gateway" | "desktop-app" | "cloud-app";

export type LpProduct = {
  key: LpProductKey;
  name: string;
  href: string;
  /** Short fact shown on the right of the header menu row. */
  fact: string;
  /** One line shown under the name in the homepage product tabs. */
  line: string;
  icon: LucideIcon;
};

/** Header menu order. */
export const LP_PRODUCTS: LpProduct[] = [
  {
    key: "mcp-gateway",
    name: "MCP Gateway",
    href: "/connect",
    fact: "Any MCP client",
    line: "Your team's skills and tools in any agent.",
    icon: Plug
  },
  {
    key: "ai-gateway",
    name: "AI Gateway",
    href: "/docs/ai-gateway/overview",
    fact: "50+ providers",
    line: "Every model, one set of keys and limits.",
    icon: Route
  },
  {
    key: "desktop-app",
    name: "Desktop App",
    href: "/download",
    fact: "Free, open source",
    line: "The full app on Mac, Windows and Linux. Free.",
    icon: Monitor
  },
  {
    key: "cloud-app",
    name: "Cloud App",
    href: "/cloud",
    fact: "OpenWork Web",
    line: "OpenWork Web, with admin controls in one place.",
    icon: Globe
  }
];

/** Homepage tab order: the app first, then the gateways, then Cloud. */
export const LP_PRODUCT_TAB_ORDER: LpProductKey[] = ["desktop-app", "mcp-gateway", "ai-gateway", "cloud-app"];
