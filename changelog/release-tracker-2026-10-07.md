# Release Changelog Tracker

Internal preparation file for release summaries. This is not yet published to the changelog page or docs.

## v0.18.57

#### Commit
`1b430194`

#### Released at
`2026-10-07T00:01:54Z`

#### Title
Move your Claude Cowork setup to OpenWork with one prompt

#### One-line summary
An agent can move your Claude Cowork plugins and skills to OpenWork in one prompt, while this release also adds per-member connector keys and changes several desktop and organization features.

#### Pull requests
| PR | Audience | Decision | Reason |
|---|---|---|---|
| #5728 | everyone | Included | The first organization chat now works before a workspace exists |
| #5724 | desktop users | Included | Library rows use aligned columns on wide windows and the card view is gone |
| #5061 | self-hosters | Included | Starter files and deployment instructions add Google Cloud Run |
| #5720 | everyone | Included | Slow-starting models no longer fail with a Cloudflare timeout |
| #5707 | desktop users | Included | Stopping a run no longer leaves a misleading interruption row |
| #5660 | admins | Included | Preview option lets organizations connect their own LiteLLM proxy |
| #5687 | admins | Included | The legacy Organization Analytics section is removed while Gateway reporting remains |
| #5673 | MCP clients | Included | Every organization can build Apps without a platform admin enabling them |
| #5675 | desktop users | Included | Desktop workspace sharing and remote-workspace connections are removed |
| #5676 | desktop users | Included | Model names replace opaque ids in the palette and picker |
| #5646 | desktop users | Included | Members can add and replace personal connector keys in desktop Library and chat |
| #5645 | admins | Included | Admins can set up individual keys and members can manage theirs in Den web |
| #5672 | desktop users | Included | Model rows and keyboard hints in the command palette are easier to read |
| #5643 | admins | Included | External MCP connections can use each member's own API key |
| #5670 | everyone | Included | Free Auto is available to organization members without a rollout switch |
| #5665 | admins | Omitted | The Usage & adoption dashboard it improved is removed in this release |
| #5661 | admins | Included | AI Gateway usage reporting loads faster for organizations with high traffic |
| #5664 | desktop users | Included | Russian model, plugin, and worker counts are translated again |
| #5655 | everyone | Included | Auto can now read attached images and images returned by tools |
| #5652 | everyone | Included | Choosing an organization and returning from setup no longer crashes Den |
| #5653 | desktop users | Included | Desktop chat no longer has an extra divider below its title |
| #5648 | self-hosters | Included | Self-hosted Den no longer reads retired configuration settings |
| #5650 | everyone | Included | Workbot replaces step lists with a quiet activity line and can react with emoji |
| #5642 | MCP clients | Included | `openwork-bootstrap login` reuses an existing sign-in |
| #5640 | MCP clients | Included | Cowork plugin imports reuse existing organization connections |
| #5639 | MCP clients | Included | Re-importing removes skills and connectors deleted from the source repository |
| #5633 | MCP clients | Included | A one-prompt migration brings Cowork and Claude Code plugins and skills to OpenWork |
| #5629 | MCP clients | Included | Cowork plugins can be imported, used, and updated through one agent call |
| #5624 | MCP clients | Included | GitHub marketplace imports avoid rate limits and explain missing connections |
| #5625 | everyone | Included | Agent-led setup opens on completion without requiring Node first and preserves teammate invites |
| #5623 | desktop users | Included | Videos made in a conversation's work folder play in chat or fall back to a file link |
| #5606 | everyone | Included | The Library gets cleaner rows, sections, and filters on desktop and Den |
| #5622 | desktop users | Included | Organization plugins are no longer installed into workspaces and GitHub import is removed |
| #5620 | everyone | Included | Slack runs wait for slow desktop work instead of stopping as stuck |
| #5612 | admins | Included | Den stops polling teammates' workers and closing an integration dialog no longer crashes |
| #5609 | desktop users | Included | Signed-out Auto works on Linux without a system keyring; its limit is shared by network |
| #5600 | desktop users | Included | Automation choices are labeled Desktop or Cloud; computer use is removed |
| #5602 | desktop users | Included | Automation choices say whether they run on Desktop or Cloud |
| #5601 | desktop users | Included | Dashboard and Automations stay visible in the signed-out desktop sidebar |
| #5554 | desktop users | Included | AI Providers and Connect a provider show clearer connection and access details |
| #5596 | everyone | Included | Remote sessions and Automations can target a chosen desktop, workspace, and model |
| #5595 | desktop users | Included | The mobile chat header no longer flashes during the first send |
| #5638 | website visitors | Included | The Cowork migration guide now starts with a prompt to give your agent |

#### Behavior changes and removals
- Desktop workspace sharing and remote-workspace connections are removed; saved remote entries are no longer listed and the embedded desktop server is local-only.
- Organization Analytics and its legacy reporting screens are removed. Usage reporting remains in AI Gateway; applying the migration deletes legacy app analytics data.
- Desktop plugins now come from the organization's Library rather than being installed into workspaces. The “From GitHub” import and workspace install/remove actions are gone; existing local copies can still be removed.
- The desktop Library is list-only: its card/list toggle is gone. Wide windows show aligned Name, Kind, From, and What it does columns.
- Computer use is removed from the Automation editor, and its remaining “What it can use” choices now identify Desktop or Cloud.
- Free Auto no longer needs an organization-by-organization rollout switch, and Apps can be built in every organization by default. Deployment controls can still disable the features; organization Auto opt-outs still apply.
- Signed-out desktop Auto no longer requires system secure storage and its free limit is based on network address rather than a device identity.
- AI Providers no longer describe OpenWork Models as “Free,” “No account needed,” or with a weekly limit in the provider list and Settings.
- Self-hosted Den no longer reads the retired `POLAR_*`, `DEN_MCP_CONNECTIONS_GATING_ENABLED`, or `DEN_INSTALL_LINKS_GATING_ENABLED` settings; the related Terraform setting is removed.

#### Lines of code changed since previous release
257847 lines changed since `v0.18.56` (194315 insertions, 63532 deletions).
