/**
 * Logos for the apps Workbot uses, by name: the same choices Den makes (its bundled icons, served from Den's
 * site, then Simple Icons, then the site's favicon). The page tries them in order and falls back to a letter.
 */
type Hint = { slug?: string; site?: string }

const BY_NAME: Record<string, Hint> = {
  asana: { slug: "asana" },
  confluence: { slug: "confluence" },
  exa: { site: "exa.ai" },
  planetscale: { slug: "planetscale" },
  posthog: { slug: "posthog" },
  vercel: { slug: "vercel" },
  render: { slug: "render" },
  outlook: { site: "outlook.com" },
  "outlook calendar": { site: "outlook.com" },
  onedrive: { site: "onedrive.live.com" },
  "microsoft teams": { site: "teams.microsoft.com" },
  atlassian: { slug: "atlassian" },
  figma: { slug: "figma" },
  github: { slug: "github" },
  gmail: { slug: "gmail" },
  "google calendar": { slug: "googlecalendar" },
  "google drive": { slug: "googledrive" },
  "google workspace": { site: "google.com" },
  granola: { slug: "granola" },
  hubspot: { slug: "hubspot" },
  jira: { slug: "jira" },
  linear: { site: "linear.app" },
  "microsoft 365": { site: "microsoft.com" },
  notion: { site: "notion.com" },
  salesforce: { slug: "salesforce", site: "salesforce.com" },
  sentry: { site: "sentry.io" },
  slack: { site: "slack.com" },
  stripe: { site: "stripe.com" },
  zendesk: { slug: "zendesk" },
}

/** Icons Den bundles (no third-party request), by site. */
const DEN_ICONS: Record<string, string> = {
  "notion.com": "/integrations/notion.svg",
  "linear.app": "/integrations/linear.svg",
  "slack.com": "/integrations/slack.svg",
  "stripe.com": "/integrations/stripe.svg",
  "sentry.io": "/integrations/sentry.svg",
  "google.com": "/integrations/google.svg",
}

/** Known names, longest first, so "Google Calendar (team)" is Google Calendar and "Linear Eng" is Linear. */
const KNOWN = Object.keys(BY_NAME).sort((a, b) => b.length - a.length)

function hintFor(name: string): Hint | undefined {
  const plain = name.trim().toLowerCase()
  const exact = BY_NAME[plain]
  if (exact) return exact
  // Whole words only (the keys are plain words), so "Notional" is not Notion.
  const known = KNOWN.find((key) => new RegExp(`(^|[^a-z0-9])${key}($|[^a-z0-9])`).test(plain))
  return known ? BY_NAME[known] : undefined
}

export function appIconCandidates(name: string, denUrl: string | null, site?: string): string[] {
  // A connected app with no hint of its own: its website, when Den gave one ("exa.ai").
  const hint = hintFor(name) ?? (site && /^[a-z0-9.-]{3,80}$/i.test(site) ? { site: site.toLowerCase() } : undefined)
  if (!hint) return []
  const candidates: string[] = []
  const bundled = hint.site ? DEN_ICONS[hint.site] : undefined
  if (bundled && denUrl) candidates.push(`${denUrl}${bundled}`)
  if (hint.slug) candidates.push(`https://cdn.simpleicons.org/${encodeURIComponent(hint.slug)}`)
  if (hint.site) candidates.push(`https://www.google.com/s2/favicons?sz=64&domain=${encodeURIComponent(hint.site)}`)
  return candidates
}
