# Release Changelog Tracker

Internal preparation file for release summaries. This is not yet published to the changelog page or docs.

## v0.18.58

#### Commit
`258218b9`

#### Released at
`2026-10-13T00:00:43Z`

#### Title
Run OpenWork Web on your own self-hosted deployment

#### One-line summary
Self-hosters can run OpenWork Web and team tools on their own AWS deployment, while this release also brings OpenCode 2 integrations, restored Organization Analytics, and changes to dashboards and session search.

#### Pull requests
| PR | Audience | Decision | Reason |
|---|---|---|---|
| #5182 | everyone | Included | Signed-out members now reach organization sign-in and return to the page they opened |
| #5890 | admins | Omitted | Background refresh cadence changes without a visible behavior change |
| #5885 | desktop users | Included | Migrated chats with a missing agent can answer again |
| #5801 | desktop users | Included | The agent picker lists native OpenCode v2 agents |
| #5880 | desktop users | Included | The Gateway providers link opens the current Den page instead of a 404 |
| #5870 | everyone | Included | Cloud onboarding reaches the dashboard with fewer setup steps when enabled |
| #5865 | everyone | Included | Library rows, details, and add pickers have a more consistent layout when enabled |
| #5854 | MCP clients | Included | Compatible clients can subscribe to remote-session status updates |
| #5859 | admins | Included | Connections show their last recorded check and admins can check them again |
| #5853 | MCP clients | Included | Opted-in OpenCode clients can be remote-session targets with recoverable progress |
| #5857 | everyone | Included | Calendar meeting titles and organization defaults are clearer; stopped Workbot tasks can run again |
| #5858 | admins | Included | Audit history can use compact rows with expandable changes when enabled |
| #5862 | admins | Included | Analytics can use the same management rows and detail pages when enabled |
| #5863 | desktop users | Included | OpenCode 2 users can install the OpenWork plugin with `opencode plugin add opencode-openwork` |
| #5855 | everyone | Included | Menus, Calendar forms, settings, and recovery actions work more clearly in small windows |
| #5848 | desktop users | Included | The OpenCode v2 preview receives an engine update and recovers connection and stopped-task work |
| #5799 | admins | Included | Dashboard Activity loads faster in workspaces with many skills |
| #5833 | admins | Included | Analytics can show plugin and connector use and failures when enabled |
| #5846 | everyone | Included | Slack replies recover older threads and can stream replies when enabled |
| #5845 | admins | Included | Admins can choose the default model for Workbot, Slack, and cloud Automations |
| #5844 | MCP clients | Included | OpenWork sign-in from OpenCode 2 waits through temporary rate limits |
| #5842 | desktop users | Included | Tasks report when OpenWork is unreachable and are not repeatedly queued |
| #5841 | desktop users | Included | Pasted text and images stay at the cursor position |
| #5838 | MCP clients | Included | OpenCode 2 can use organization AI Gateway models and OpenWork tools through the plugin |
| #5815 | admins | Included | OAuth MCP connections no longer lose credentials when concurrent requests renew them |
| #5806 | desktop users | Included | Windows startup recovers when the engine refuses a saved provider credential |
| #5809 | admins | Included | Enterprise organizations can set permissions for members, admins, and teams; super-admin and custom roles are removed |
| #5830 | self-hosters | Included | Managed AWS deployments can use an existing VPC and ECS cluster |
| #5826 | admins | Included | Analytics can show which organization skills are used when enabled |
| #5829 | admins | Included | Organization Analytics returns, with history retained or restored where available |
| #5827 | self-hosters | Included | Den upgrades no longer delete Organization Analytics history |
| #5823 | everyone | Included | Workbot replies stay steady and follow-ups can interrupt the answer in progress |
| #5820 | everyone | Included | Drive uploads use the selected Google account and can resume larger uploads when enabled |
| #5818 | self-hosters | Included | AWS self-hosters can run diskless Workbot replicas and use an existing runner fleet |
| #5817 | everyone | Included | AI Gateway requests wait through brief usage-record delays instead of failing immediately |
| #5812 | desktop users | Included | Desktop users can upgrade chats to OpenCode v2 with a backup first |
| #5811 | everyone | Included | Free Auto accounts cached input at its cached price |
| #5761 | everyone | Included | MCP sign-in works with the supported regional resource address |
| #5002 | everyone | Included | Automation model choices are preserved and unavailable models are reported rather than silently substituted |
| #5120 | desktop users | Included | Explicit chat navigation no longer gets overridden by saved-position recovery |
| #5119 | desktop users | Included | Chat position is restored only after its transcript is ready |
| #5086 | desktop users | Included | Follow-ups and Stop no longer wait behind unrelated chat reads |
| #5116 | desktop users | Included | The built-in browser stays within its pane instead of covering chat |
| #5304 | desktop users | Included | Sub-agent activity updates in the parent conversation without opening child chats |
| #5328 | admins | Included | Gateway analytics show paid and free OpenWork Models usage alongside providers |
| #5496 | admins | Included | Gateway providers load and prepare for desktop syncing faster |
| #5518 | desktop users | Included | Completed connected-tool results remain inspectable after chat reloads |
| #5578 | desktop users | Included | Shared Apps ask viewers to sign in when their own account is needed |
| #5808 | everyone | Included | MCP connections no longer stall on a successful response with an open body |
| #5805 | internal | Omitted | Model metadata snapshot maintenance with no user-visible change described |
| #5802 | website visitors | Included | The API playground asks for an API key in the working `x-api-key` header |
| #5795 | desktop users | Included | Chat and side panels sit evenly in the window |
| #5786 | desktop users | Included | Organizations with OpenWork Models can choose GPT-6 Luna from that plan |
| #5793 | internal | Omitted | Model metadata snapshot maintenance with no user-visible change described |
| #5785 | desktop users | Included | For organizations with OpenWork Models, Auto is removed from the picker in favor of those models |
| #5792 | everyone | Included | Automations can be edited from Calendar, including instructions, model, and run location |
| #5790 | everyone | Included | An Automation can be created from an empty Calendar time slot |
| #5769 | everyone | Included | Calendar can show Automations alongside meetings when enabled |
| #5766 | desktop users | Included | Organization skills can be discovered from natural requests in OpenCode v2 when enabled |
| #5773 | everyone | Included | Long Workbot chats keep answering and failed turns can be retried; side chats are available when enabled |
| #5772 | admins | Included | Admins can offer per-member AWS sign-in and add Claude on Microsoft Foundry |
| #5583 | admins | Included | Organization-managed dashboard pages are removed from Den |
| #5770 | admins | Included | Empty example plugins no longer appear in older organizations |
| #5764 | everyone | Included | Cloud scripts and Workflows can make up to 1,024 tool calls in one run, up from 50 |
| #5763 | everyone | Included | Cloud Automations name the provider when the owner's key is missing |
| #5759 | desktop users | Included | Ollama retains added models, shows thinking choices, and can sync its model list |
| #5756 | desktop users | Included | OpenCode v2 discovers connected tools in scripts with TypeScript types |
| #5748 | self-hosters | Included | Workbot's optional computer tools can use Daytona instead of Freestyle |
| #5753 | admins | Included | When enabled, the admin dashboard shows recent workspace additions and skill updates instead of Quick add |
| #5752 | admins | Included | OpenWork downloads are available from any Den dashboard page; admins can copy an install link |
| #5745 | self-hosters | Included | AWS ECS self-hosters can run Slack, Workbot, and headless Automations |
| #5667 | everyone | Included | Workbot shows background jobs and lets people stop or retry them without losing the conversation |
| #5742 | self-hosters | Included | Single-organization self-hosted deployments can run OpenWork Web with sandboxed browser workspaces |
| #5709 | desktop users | Included | The Working line stays visible during long quiet stretches |
| #5746 | desktop users | Included | Legacy worker dashboard and token polling are removed; desktops older than 0.18.57 lose saved remote-worker connections |
| #5743 | self-hosters | Included | The AWS ECS Terraform module can deploy OpenWork Web with the operator's Daytona account |
| #5737 | self-hosters | Included | AWS ECS deployments can use an existing load balancer and wait for healthy tasks |
| #5698 | admins | Included | Audit Logs cover sign-ins, access changes, API keys, identity setup, and agent actions |
| #5739 | desktop users | Included | OpenCode v2 discovers connected tools when scripts use the namespaced search spelling |
| #5741 | desktop users | Included | OpenCode v2 conversations can use the built-in browser with approval prompts |
| #5733 | everyone | Included | Bring-your-own-key Amazon Bedrock providers work in chat with saved region settings |
| #5656 | desktop users | Included | Admin-assigned dashboards are removed from Desktop; personal dashboards remain |
| #5731 | admins | Included | Adding or removing a model provider in OpenWork Cloud no longer errors |
| #5729 | desktop users | Included | Reopened Apps load their data instead of showing an artifact-view error |
| #5732 | internal | Omitted | Revert of an intermediate change; the user-facing fix is present in #5733 |
| #5730 | everyone | Omitted | This change was reverted before the fix was re-applied in #5733 |
| #5723 | desktop users | Included | “Search sessions” now searches titles and workspace names, not message text |
| #5873 | website visitors | Included | Integrations docs explain MCP and client-plugin setup and status |
| #5871 | website visitors | Included | The OpenCode guide explains how OpenWork Connect provides models, tools, and skills |
| #5867 | website visitors | Included | New focused guides cover OpenCode, MCP clients, Ollama, and AI spend |
| #5744 | website visitors | Included | A dedicated guide explains Microsoft 365 setup for an OpenWork organization |
| #5734 | website visitors | Included | A guide explains how to connect Google Cloud CLI and share it with a team |

#### Behavior changes and removals
- Organization-managed dashboard pages are removed from Den, and admin-assigned dashboards no longer appear in Desktop; personal dashboards remain available.
- “Search sessions” now searches session titles and workspace names only; searching message text from that dialog and jumping to a matching message are gone.
- For organizations with OpenWork Models, Auto is no longer shown in the model picker; GPT-6 Luna is available from OpenWork Models instead.
- Super-admin and custom roles are removed. Enterprise organizations can set permissions for members, admins, and teams; certain former super-admin-only actions are owner-only unless granted.
- The legacy worker dashboard, its token polling, and older worker routes are removed. Desktops older than 0.18.57 can no longer connect to a cloud worker saved as a remote workspace.
- Dashboard Quick add is replaced by recent Activity when that rollout is enabled; the prior Quick add view returns when it is disabled.
- Slack now answers through the headless runner rather than the former OpenWork Web path; older thread sessions that disappeared are retried once in a fresh session.
- Empty example plugins no longer appear in older organizations.

#### Lines of code changed since previous release
441277 lines changed since `v0.18.57` (416746 insertions, 24531 deletions).
