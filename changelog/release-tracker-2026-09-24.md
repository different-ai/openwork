# Release Changelog Tracker

Internal preparation file for release summaries. This is not yet published to the changelog page or docs.

## v0.18.52

#### Commit
`c04b9a50`

#### Released at
`2026-09-24T01:17:11Z`

#### Title
Admins can manage plugins and add any MCP server

#### One-line summary
Admins can find plugins by name or access and add an MCP server that is not listed in the connector catalog.

#### Pull requests
| PR | Audience | Decision | Reason |
|---|---|---|---|
| #5306 | admins | Included | Search plugins by name and filter them by team or user |
| #5305 | admins | Included | Add any MCP server from the connector page or a pasted URL |

#### Behavior changes and removals
- The Add a connector page now has an **Add any MCP** header action instead of the smaller **Add another MCP** button beside search; the Connectors sidebar item keeps its MCPs badge.

#### Lines of code changed since previous release
17552 lines changed since `v0.18.51` (17304 insertions, 248 deletions).
