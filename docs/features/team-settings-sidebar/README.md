# Den: team sections in a sidebar

Feature key: `teamSettingsSidebar` · Deployments: cloud and self-hosted · Default: off · Author: @reachjalil

## What changes

A team's page (Den › Members › Teams › a team) and Everyone's page had up to
nine tabs in one row across the top: Role, Members, Access, Agents, Browser,
Models, Workbot, Prompts and Desktop. They no longer fit, so the row scrolls
sideways and the later tabs are out of view.

With the feature on, both pages list the same sections in a sidebar on the
left, in groups:

| Group | Sections |
|---|---|
| People | Role, Members |
| Permissions | Access, Agents, Browser |
| AI | Models, Workbot, Prompts |
| Apps | Desktop |

- A section shows only where its tab showed before (same permissions and
  features); a group with no section is left out. Everyone's page has no
  Members or Access.
- The chosen section is highlighted, and a section whose introduction has not
  been viewed keeps its dot, on the right.
- The page is wider (up to 1100px) so each section keeps about the width it
  had under the tabs.
- Narrow screens (under 768px) keep the row of tabs.

Nothing else changes: the sections' contents, the `?tab=` address of each
section, and what each person can see or edit are the same.

## Try it

1. Turn `teamSettingsSidebar` on for the organization in `/admin`.
2. Open Den › Members › Teams and choose a team, or Everyone.

## Turning it off

The pages show the row of tabs again on the next load. Nothing is stored, so
there is nothing to migrate or clean up.

## Code

- `ee/apps/den-web/app/(den)/dashboard/_components/team-sections.tsx`: the
  tabs or the sidebar, used by `team-detail-screen.tsx` and
  `everyone-screen.tsx`.
- `team-section-groups.ts`: which group each section is under.
