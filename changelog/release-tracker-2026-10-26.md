# Release Changelog Tracker

Internal preparation file for release summaries. This is not yet published to the changelog page or docs.

## v0.18.63

#### Commit
`9add0d2b`

#### Released at
`2026-10-26T23:47:08Z`

#### Title
Bring Claude conversations into OpenWork

#### One-line summary
Import Claude conversations into OpenWork, work with connected files on OpenCode v2, and get more dependable desktop, Workbot, and admin experiences.

#### Pull requests
| PR | Audience | Decision | Reason |
|---|---|---|---|
| #6510 | everyone | Included | Remote sessions start with fewer waits and detect when Cloud workspaces finish waking |
| #6504 | everyone | Included | Completed Desktop, Workbot, and organization features are now generally available |
| #6501 | everyone | Omitted | Diagram zoom remains behind an off-by-default feature switch |
| #6505 | everyone | Included | OpenCode v2 can create Gmail drafts and replies with approved workspace attachments |
| #6508 | everyone | Included | GPT-6.1 Terra is available to teams using OpenWork Models |
| #6499 | self-hosters | Included | Connected desktops no longer update past the release supported by a self-hosted server |
| #6503 | desktop users | Included | Computer use setup moves to Settings and Windows gains This PC |
| #6497 | everyone | Included | OpenCode v2 can pull, check, and save Google Drive, OneDrive, and SharePoint files |
| #6250 | everyone | Included | Verified sign-in no longer waits for organization discovery to finish |
| #6494 | desktop users | Included | The desktop window restores its previous size and position on launch |
| #5840 | everyone | Included | OpenCode v2 can upload workspace files to Google Drive after approval |
| #6490 | everyone | Included | Sign-in from the Auto usage notice works and returns to the same task |
| #6492 | desktop users | Included | Session shortcut hints appear sooner when Cmd or Ctrl is held |
| #6491 | desktop users | Included | Computer use no longer breaks messages with providers that validate tool schemas |
| #6477 | internal | Omitted | Runner deployment configuration change with no user-facing interface |
| #6472 | desktop users | Included | AI Providers lists each locally added key when using the new engine |
| #6470 | desktop users | Included | Cmd+N or Ctrl+N starts a session while the composer is focused |
| #6465 | desktop users | Omitted | Provider mirroring remains behind an off-by-default feature switch |
| #6468 | self-hosters | Included | The Helm recovery guide explains how to capture logs and interpret a refused recovery run |
| #6463 | everyone | Omitted | Built-in libraries for OpenWork apps remain behind an off-by-default feature switch |
| #6461 | everyone | Included | Workbot waits during Den rate limits and keeps rotated sign-in tokens |
| #6459 | MCP clients | Included | Steady OAuth token renewals are no longer refused by a sliding failure count |
| #6458 | MCP clients | Included | One connected app's failed sign-in no longer blocks other users renewing tokens |
| #6455 | website visitors | Included | Configured website sign-in limits distinguish each person's attempts |
| #6456 | admins | Included | New sandbox organizations can be prefilled with sample connectors and a configured AI Gateway model |
| #6453 | admins | Included | Sandbox join links add admins by default, and admins can choose members instead |
| #6447 | internal | Omitted | Feature-author metadata and repository documentation links are for platform maintenance |
| #6452 | everyone | Omitted | Model catalog snapshot refresh has no described user-visible model addition |
| #6454 | everyone | Included | Kimi K3.1 Pro and DeepSeek V4.1 Flash are added to OpenWork Models |
| #6451 | everyone | Included | Show model reasoning now requests readable reasoning and starts off by default |
| #6448 | everyone | Included | Existing account holders can sign in to join a sandbox instead of waiting for a code email |
| #6444 | everyone | Included | Claude chats and Claude Code sessions can be imported into a workspace |
| #6449 | desktop users | Included | Windows environment variables that differ only by case merge correctly |
| #6278 | website visitors | Included | The hosted API reference now reads the deployed public contract |
| #6446 | admins | Included | Prompts show their update state and give empty teams a clear way to add one |
| #6433 | desktop users | Included | Windows computer use can work with apps on This PC |
| #6437 | everyone | Included | Joining an organization no longer fails when people join simultaneously |
| #6443 | desktop users | Included | Switching organizations refreshes skills, connected apps, and models |
| #6369 | admins | Included | Den dashboard pages start loading their data sooner |
| #6440 | admins | Included | Automations are on by default with separate organization controls for Desktop and Cloud |
| #6442 | everyone | Included | Workspace instruction files apply from the first message on OpenCode v2 |
| #6441 | everyone | Included | Resuming a paused Workbot computer that needs an update rebuilds it automatically |
| #6394 | self-hosters | Included | Upgrades before Super Admin deprecation preserve active members' former capabilities for owner review |
| #6438 | admins | Included | The Microsoft 365 guide reflects current sign-in, permissions, reconnection, and credential replacement |

#### Behavior changes and removals
- Computer use is set up once in Settings → Computer use rather than from a button in each chat. The per-chat computer status button and the extra browser button in the header are gone; the browser toggle is in the side rail. Windows desktop users can select This PC for computer use.
- Nine completed features are now available by default: local AI providers, Automation settings, agent-assisted connection removal, Workbot search, improved usage-limit cards, task-preserving sign-in, Claude imports, and organization Prompts; the ninth retires OpenCode Zen models, which are no longer offered. Automations are enabled by default, with separate Desktop and Cloud organization controls. Cloud Automations still require a configured runner.
- Show model reasoning now starts off, and existing saved preferences are reset to off; turn it on in Settings → Preferences to see readable reasoning when supported.
- Sandbox join links now add admins by default rather than members. Platform admins can select Members; owners are not added through join links.
- New sandbox organizations can start with sample connectors and, when configured, an AI Gateway model for each member. The Den Prompts tab now shows each prompt's update state and gives empty teams a direct way to add one.
- Cmd+N (Ctrl+N) now starts a session even when the chat composer is focused, and sidebar session shortcut hints appear sooner.
- On Windows, environment variable names now match without regard to case, so saved values no longer hide system `Path` or similarly named variables.
- Returning members can enter OpenWork as soon as Den verifies their session while organization details load in the background. Switching organizations refreshes the app's organization-specific data.
- Existing-account users joining a sandbox are offered the sign-in flow instead of being sent to a verification-code step that cannot send them a code.
- On OpenCode v2, workspace instruction files now apply from the first message. Remote sessions start with fewer waits, and status checks detect when a Cloud workspace has finished waking.
- Single-organization self-hosted servers now cap the desktop version they report at their own stable release, preventing connected desktops from updating beyond the server's support.
- OpenCode v2 can now work with connected Drive files, upload workspace files to Google Drive, and create Gmail drafts or replies with workspace attachments. Transfers and drafts require approval in chat; drafts are not sent automatically.
- New sandbox join links default to admin access, and choosing admin can promote people who already joined as members. Separately, upgrades that have not yet passed the Super Admin deprecation preserve matching active members' former capabilities in a reviewable team.
- OpenWork Models adds GPT-6.1 Terra, Kimi K3.1 Pro, and DeepSeek V4.1 Flash. The public API reference now reads the deployed public contract rather than a committed generated file.
- AI Providers now lists every locally added key on OpenCode v2, and Sign in from the Auto usage notice returns to the same task. Other fixes restore the desktop window's last size and position, make computer use work with strict model providers, keep Workbot sign-in and resume flows reliable, and allow organization joins to proceed concurrently.

#### Lines of code changed since previous release
227273 lines changed since `v0.18.62` (40956 insertions, 186317 deletions).
