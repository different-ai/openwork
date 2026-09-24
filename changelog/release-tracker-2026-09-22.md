# Release Changelog Tracker

Internal preparation file for release summaries. This is not yet published to the changelog page or docs.

## v0.18.50

#### Commit
`4707262e`

#### Released at
`2026-09-22T21:19:28Z`

#### Title
Run OpenWork on your own server with one command

#### One-line summary
Self-hosters can run the full OpenWork web app with one command, connecting an account in chat no longer gets stuck, and agents in other AI tools can reach your organization's skills directly.

#### Pull requests
| PR | Audience | Decision | Reason |
|---|---|---|---|
| #5212 | self-hosters | Included | One-command self-hosting of the web app and API |
| #5211 | desktop users | Included | Connection requests in chat can no longer hang forever |
| #5172 | desktop users | Included | Embedded chat cards replaced by text replies; visible behavior change |
| #5205 | desktop users | Included | Sidebar account row no longer shows the email address |
| #5208 | MCP clients | Included | Agents in Claude Code, Cursor, or Codex can list and open org skills |
| #5214 | website visitors | Included | Pricing is now consistent across the website, docs, and sign-up |
| #5027 | website visitors | Included | Refreshed website and docs branding, folded into the pricing bullet |
| #5219 | internal | Omitted | Reviewer preview launches; the one app change is invisible to users |
| #5226 | internal | Omitted | Reviewer preview links only |
| #5225 | internal | Omitted | Reviewer preview environments only |
| #5227 | internal | Omitted | Automated model catalog refresh with no visible change |
| #5224 | internal | Omitted | Automated model catalog refresh with no visible change |
| #5220 | internal | Omitted | Pull request security review tooling |
| #5209 | internal | Omitted | CI browser setup |
| #5202 | internal | Omitted | Test type-checking baseline |

#### Behavior changes and removals
- Creating or sharing a skill, asking for a mockup, being asked for an environment variable, and browsing connectors now reply in plain text instead of embedded cards. Only the connection card remains.
- The sidebar account row shows your name and "OpenWork Cloud" instead of your email address. The email is still at the top of the account menu.

#### Lines of code changed since previous release
17096 lines changed since `v0.18.49` (9924 insertions, 7172 deletions).
