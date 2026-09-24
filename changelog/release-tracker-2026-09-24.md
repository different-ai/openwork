# Release Changelog Tracker

Internal preparation file for release summaries. This is not yet published to the changelog page or docs.

## v0.18.52

Covers everything since `v0.18.50`. The `v0.18.51` release was never published (it stayed a draft), so nobody received it and its changes had no notes. They are documented here instead.

#### Commit
`c04b9a50`

#### Released at
`2026-09-24T01:17:11Z`

#### Title
Manage your Library from the desktop, find anything from one + menu, and a rebuilt AI Gateway

#### One-line summary
The desktop Library can add, share, edit and delete items, the composer has one searchable + menu, usage limits are clearer, and admins get a rebuilt AI Gateway plus simpler connector and plugin management.

#### Pull requests
| PR | Audience | Decision | Reason |
|---|---|---|---|
| #5306 | admins | Included | Search plugins by name and filter them by team or user |
| #5305 | admins | Included | Add any MCP server from the catalog header or a pasted address |
| #5294 | MCP clients | Included | Agents can update shared skills with update_skill |
| #5292 | everyone | Included | Plugin lists load faster in Manage, My Library and the desktop |
| #5296 | everyone | Included | Models move into My Library with per-person Google sign-in |
| #5291 | admins | Included | My Library, Manage and the catalog open faster |
| #5284 | admins | Omitted | Undoes a sidebar grouping that never shipped in a published release |
| #5279 | admins | Included | Confirm before Remove and before switching to one shared account |
| #5278 | admins | Omitted | Superseded by the Add any MCP header action in the same release |
| #5255 | desktop users | Included | Choose where links open on first click and remember it |
| #5264 | admins | Included | Mistral support in AI Gateway |
| #5273 | admins | Included | Manage › Plugins lists who has each plugin; create and share in place |
| #5272 | admins | Included | Simpler connector add flow with sign-in mode and teams |
| #5268 | desktop users | Included | Signed-out Library shows a working Sign in button |
| #5263 | desktop users | Included | No misleading "too many requests" error under the usage-limit card |
| #5267 | desktop users | Included | One searchable + menu in the composer, with ⌘U to attach |
| #5260 | desktop users | Included | Clearer usage-limit card, account-menu usage and Settings › Usage |
| #5261 | desktop users | Included | Search and notifications in the titlebar; native window controls |
| #5236 | everyone | Included | Per-person Google sign-in for Gemini and Claude on Google Cloud |
| #5251 | desktop users | Included | Chat and Share on Library item pages; Uninstall renamed Remove |
| #5252 | admins | Omitted | Row layout polish on a page redesigned again in this release |
| #5258 | internal | Omitted | Reverts #5244 before any published release carried it |
| #5249 | admins | Included | Users & Teams directory with providers, limits and spend |
| #5248 | desktop users | Included | Library Connectors tab, Add dialog with logos, MCP address check |
| #5244 | internal | Omitted | Reverted by #5258 in the same release |
| #5246 | admins | Included | AI Gateway spend views, person pages and limits with undo |
| #5239 | desktop users | Included | Share, edit and delete from the desktop Library; chat names the skill used |
| #5243 | internal | Omitted | Pull request check only |
| #5242 | self-hosters | Included | Self-hosted web sign-in works for people in several organizations |
| #5181 | desktop users | Included | Suspend removed from the built-in browser toolbar |
| #5241 | internal | Omitted | Regenerated SDK files with no visible change |
| #5230 | MCP clients | Omitted | Narrow admin-agent action; too specialized for these notes |
| #5210 | admins | Included | AI Providers redesigned: catalog and one form per provider |
| #5228 | desktop users | Included | AI providers work after sign-in before the first workspace |
| #5238 | self-hosters | Included | Owners approve self-hosted web addresses in Org settings |
| #5232 | MCP clients | Included | Agents are told when long results are cut and how to read the rest |
| #5139 | admins | Included | AI Gateway becomes a sidebar page available to every organization |
| #5237 | self-hosters | Omitted | npm package change; the npm package was not republished for this release |
| #5223 | desktop users | Included | Link destinations simplified to OpenWork or your browser, saved in Preferences |

#### Behavior changes and removals
- The composer's paperclip and tools buttons are replaced by one **+** menu; attach files from its first row or with ⌘U / Ctrl+U.
- The built-in browser toolbar no longer has a **Suspend** button.
- Link menus no longer list individual installed browsers; the choices are OpenWork or your default browser.
- The Library says **Remove** instead of **Uninstall** (connections still say **Disconnect**).
- Den's **My Model Connections** page now opens the Models section of My Library.
- AI Gateway's old Gateway pages are gone; old list, new, detail and edit links return 404, and `/dashboard/inference` links forward to the Models tab.
- Users & Teams in AI Gateway is read-only; access is changed in AI Providers and limits in Limits.
- Manage › Plugins no longer shows GitHub sources and marketplaces; they remain reachable at their old links.
- Removing a connector or plugin in OpenWork Cloud now asks for confirmation.

#### Lines of code changed since previous release
93509 lines changed since `v0.18.50` (83894 insertions, 9615 deletions).
