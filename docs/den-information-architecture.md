# Den information architecture

Status: proposal. Nothing here is built yet. Each step below ships as its own
PR, behind a flag in `packages/features/src/registry.ts` when people would
notice the change.

This is about how Den is organized: where each thing lives, how you get to it,
and how pages relate. It is not a visual redesign. Visual rules stay in
`DESIGN.md`.

## Why

Admins find things in Den by remembering which sidebar group a feature fell
into. The sidebar groups features (Work, Manage, Observability, Team), not the
things an admin owns (a plugin, a connection, a team), so the same object can
show up in several places, and opening one drops you onto a page with no
navigation of its own.

PlanetScale's dashboard is a good reference for a dense admin product that
stays easy to find your way around. The patterns below are what we would copy,
mapped to our own rules.

## Patterns to copy

| # | Pattern | What PlanetScale does | Our rule |
|---|---------|-----------------------|----------|
| 1 | The URL is the location | `/{org}/{database}/{branch}`, shown in the top bar as `org ▾ / database ▾`. Every part opens a switcher. | S6 |
| 2 | Navigation changes by level | The org sidebar is short (Databases, Settings). Inside a database the sidebar becomes that database's: Dashboard, Deploy requests, Branches, Connections, Insights, Settings. | P3, P7 |
| 3 | Two levels at most | A sidebar item may have one sub-list (Insights › Overview, Errors, …). Deeper pages use a small in-page breadcrumb (`Branches › Schema`). | S3 |
| 4 | A page-wide focus picker | The page header carries a **Branch: main ▾** picker that re-scopes the whole page. | P1 |
| 5 | The overview is a hub of links | Every count on the dashboard links to where it lives (Branches 3, Deploy requests 0 open, Next backup in 12 hours). Recent activity links to each change. | P1, P6 |
| 6 | One list template | Search first, then the main action, then rows: name, state, relative time, `⋯`. | S2 |
| 7 | Unavailable actions stay visible | The `⋯` menu on `main` greys out Delete and Set as default instead of hiding them. | P4 |
| 8 | Two-step protection for destructive actions | Each object's settings page ends with a "Prevent deletion" switch. Deleting needs the switch off, then the name typed. | P8 |
| 9 | The page teaches the next step | A production branch says "create a branch of `main`, then open a deploy request", with the button right there. | C6 |
| 10 | Ids on hand | Object ids are shown in mono with copy-on-click. | V1 |

## Den today

Sources: `ee/apps/den-web/app/(den)/dashboard/**/page.tsx` (86 dashboard
routes) and `_lib/dashboard-navigation.ts`.

What already works and should stay:

- The command palette, with good search keywords (`flattenNavigationForSearch`, `PAGE_KEYWORDS`).
- Locked entries that stay visible with a reason (Audit logs, Permissions marked Enterprise).
- Old URLs redirect to their new homes: `skills/*` → `plugins`, `workflow-runs` and
  `script-runs` → analytics runs, `manage-members` → `members`,
  `agent-permissions` → Members › Teams › Everyone, `advanced` → `marketplaces`,
  `gateway-providers` and `inference` → AI Gateway, `integrations` → plugin sources.

The gaps:

1. **The org isn't in the URL.** `getOrgDashboardRoute(_orgSlug)` ignores the
   slug and always returns `/dashboard`. You can't share a link to one org's
   page, and the top bar can't show where you are as an `org / object` chain.
2. **The same object has two homes.**
   - Plugins: `plugins/[pluginId]` (admin) vs `library/plugins/[pluginId]`
     (member) vs `plugins/[pluginId]/details`.
   - Connections: `mcp-connections/[connectorId]` (admin) vs
     `library/connectors/[connectionId]` (member) vs `your-connections`.
   - Models: `ai-gateway/providers/*`, `custom-llm-providers/*` (legacy BYOK)
     and `library/models/[providerId]`.
3. **Detail pages have no navigation of their own.** Plugin, connection, team
   and provider pages fill the content area, but the sidebar stays at org level,
   and sub-pages (`plugins/[id]/skills/[skillId]/edit`) go three levels deep.
4. **Settings is a catch-all.** It holds General, Diagnostics, Billing, API
   Keys, Permissions, SSO, SCIM, Advanced (marketplaces) and Tool Tester: org
   settings, developer tools and a whole product area all in one list.
   Brand appearance is reachable only from inside Advanced.
5. **Some labels describe how it's built** (C3): "Connectors" with an "MCPs"
   badge, "Advanced" for marketplaces, "AI Gateway" next to Models.
6. **The dashboard is not a hub.** `/dashboard` doesn't summarize state with links into it.

## Proposed sitemap

URLs gain the org slug. Every object gets one URL, and the member and admin
views are the same page with different controls (P4), not two routes.

```
/{org}                                   Overview: counts and states that link into each area, recent activity
/{org}/library                           What I can use: plugins, connections, models (member view)
/{org}/automations
/{org}/plugins                           List (one template)
/{org}/plugins/{plugin}                  Tabs: Overview · Skills · Access · Activity · Settings
/{org}/plugins/{plugin}/skills/{skill}   In-page breadcrumb, edit in place
/{org}/connections                       List: org connections plus "needs your sign-in"
/{org}/connections/{connection}          Tabs: Overview · Access · Activity · Settings
/{org}/models                            Providers, limits, people (was AI Gateway + legacy BYOK)
/{org}/models/{provider}                 Tabs: Overview · Usage · Settings
/{org}/members                           Tabs: People · Teams · Roles
/{org}/members/teams/{team}              Tabs: People · Agents · Access
/{org}/marketplaces                      Was Settings › Advanced
/{org}/marketplaces/{marketplace}        Tabs: Plugins · Access · Branding
/{org}/desktop-policies[/{policy}]
/{org}/deployments
/{org}/activity                          Tabs: Audit log · Runs · Usage (was Analytics + Audit logs)
/{org}/settings                          Sub-list: General · Billing · Security (SSO, SCIM) · API keys
```

Developer tools (Diagnostics, Tool Tester) move to a quiet group at the bottom
of the sidebar, the way PlanetScale keeps Changelog and Docs out of the main
list.

### Sidebar

Org level:

```
Overview
Library
Automations
───────────
Plugins
Connections
Models
Members
Marketplaces
Desktop policies
Deployments            (when on)
Activity
Settings ▸
───────────
Diagnostics · Tool tester
```

Inside a plugin, connection, team or provider, the top bar shows
`org ▾ / plugin ▾` and the page shows that object's tabs. The sidebar keeps
the org list, with the parent item highlighted.

## Route map

| Today | Proposed | Change |
|-------|----------|--------|
| `/dashboard` | `/{org}` | Becomes a hub of links |
| `library` | `/{org}/library` | Same |
| `library/plugins/[id]`, `plugins/[id]`, `plugins/[id]/details` | `/{org}/plugins/{id}` | Merge; controls depend on role |
| `library/plugins/[id]/share` | `/{org}/plugins/{id}` › Access | Tab |
| `plugins/[id]/skills/*` | `/{org}/plugins/{id}/skills/{skill}` | Edit in place, no `/edit` |
| `plugins/new`, `plugins/import`, `library/plugins/new` | `/{org}/plugins` › New | One dialog or flow |
| `mcp-connections/[id]`, `library/connectors/[id]` | `/{org}/connections/{id}` | Merge |
| `library/connectors/[id]/share` | `/{org}/connections/{id}` › Access | Tab |
| `mcp-connections`, `your-connections` | `/{org}/connections` | Merge; "needs your sign-in" as a filter |
| `mcp-connections/new/*`, `library/connectors/new/*` | `/{org}/connections/new/{catalog}` | Merge |
| `ai-gateway/*`, `custom-llm-providers/*`, `library/models/[id]` | `/{org}/models/*` | Merge; legacy BYOK as a provider type |
| `members`, `members/teams/*`, `members/roles/new` | `/{org}/members/*` | Tabs |
| `permissions/*` | `/{org}/members` › Roles | Already moving with `teamRoles` |
| `marketplaces/*`, `brand-appearance`, `onboarding/*` | `/{org}/marketplaces/*` | Branding becomes a tab |
| `analytics/*`, `audit-logs` | `/{org}/activity` | Tabs |
| `org-settings`, `billing`, `api-keys`, `sso`, `scim` | `/{org}/settings/*` | Sub-list |
| `diagnostics`, `tool-tester` | `/{org}/diagnostics`, `/{org}/tool-tester` | Bottom group |
| `desktop-policies/*`, `deployments`, `automations`, `workbot-settings`, `web` | `/{org}/…` | Same name, org-scoped |

Every old URL keeps working as a permanent redirect. Agents and docs link to
these routes (for example `mcp-connections/[id]?remove=1`), so the redirects
carry query strings through.

## Order of work

Each step ships and is useful on its own.

1. **Org in the URL plus top-bar switchers.** Add `/{org}/…` routes and
   redirect `/dashboard/…` to the active org. Show `org ▾ / object ▾` in the
   header. Makes links shareable.
2. **One home per object.** Merge the plugin, connection and model routes, with
   redirects. This step matters most for finding things.
3. **Detail-page tabs.** One shared tab-bar primitive in `@/components`, used
   by plugin, connection, team, provider and marketplace pages (P5).
4. **Split Settings, rename labels.** Advanced → Marketplaces, Connectors
   (MCPs) → Connections, AI Gateway → Models; developer tools move to the
   bottom group. Update `PAGE_KEYWORDS` so old words still find the pages.
5. **The overview becomes a hub.** Counts and states that link into each area,
   plus recent activity from the audit log.
6. **List template and protected deletion.** One list primitive (search,
   action, rows, `⋯` with blocked items shown and explained). Protect deleting
   an org, marketplace or connection with a switch plus typing the name; keep
   undo everywhere else.

## Open questions

- Does the member view of a plugin or connection need anything the admin view
  lacks, or is it really the same page with fewer controls?
- Should Workbot settings sit under Models (default model) or stay separate?
- Does Library stay a separate page once plugins and connections each have one
  home, or does it become a "mine" filter on those lists?
