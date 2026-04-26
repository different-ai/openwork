export const APP_URL = process.env.NEXT_PUBLIC_APP_URL || "https://openworklabs.com";
export const CHAT_URL = process.env.NEXT_PUBLIC_CHAT_URL || "https://openworklabs.com/download";
export const DOWNLOAD_URL = "/download";
export const GITHUB_URL = "https://github.com/different-ai/openwork";
export const DOCS_URL = "/docs";
export const ENTERPRISE_URL = "/enterprise";
export const CLOUD_URL = "https://app.openworklabs.com";

export const MAIN_ROUTES = [
  { label: "Download", href: "/download" },
  { label: "Cloud", href: CLOUD_URL, external: true },
  { label: "Pricing", href: "/pricing" },
  { label: "Enterprise", href: "/enterprise" },
  { label: "Trust", href: "/trust" },
  { label: "Docs", href: "/docs" }
];

export const ALL_ROUTES = [
  { label: "Download", href: "/download" },
  { label: "Pricing", href: "/pricing" },
  { label: "Enterprise", href: "/enterprise" },
  { label: "Trust", href: "/trust" },
  { label: "Docs", href: "/docs" },
  { label: "Privacy", href: "/privacy" },
  { label: "Terms", href: "/terms" },
  { label: "Feedback", href: "/feedback" }
];

export const LOADER_DELAY = 1.4;
export const INTRO_DURATION = 1.2;
export const INTRO_STAGGER = 0.25;
