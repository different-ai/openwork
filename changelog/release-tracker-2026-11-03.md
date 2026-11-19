# Release Changelog Tracker

Internal preparation file for release summaries. This is not yet published to the changelog page or docs.

## v0.18.64

#### Commit
`44c70740`

#### Released at
`2026-11-03T14:33:06Z`

#### Title
Make agent work smoother across chat, browser, and Apps

#### One-line summary
Use more browser and file capabilities, open Apps and Artifacts more smoothly, and follow remote work and helpers more easily.

#### Pull requests
| PR | Audience | Decision | Reason |
|---|---|---|---|
| #6899 | admins | Included | Adds browser upload rules and remembered website-and-folder consent |
| #6898 | everyone | Included | Workbot can read PDFs and Office files from Drive on its computer |
| #6894 | MCP clients | Included | Agents can read text from Google Drive PDFs up to 50 MB |
| #6895 | everyone | Included | Browser uploads stay connected while approval is pending |
| #6192 | self-hosters | Omitted | Managed installer upgrade internals; no installer is published or auto-updated |
| #6890 | desktop users | Included | When enabled, members can add and sign in to a personal MCP from the desktop Library |
| #6583 | everyone | Included | Repairs history-copy lockouts and makes v2-only an opt-in rollout |
| #6886 | desktop users | Included | Remote tasks start soon after Den queues them |
| #6885 | desktop users | Included | Title-bar Back and Forward work from a remote task |
| #6884 | everyone | Included | Re-sending remote work from a new chat is no longer rejected as a duplicate |
| #6881 | admins | Included | Artifact managers can delete artifacts from the Artifacts page |
| #6875 | everyone | Included | Apps built by an agent are guided to show data sooner |
| #6750 | everyone | Included | Agent can enter a supplied password or code after destination approval |
| #6867 | everyone | Included | Built-in browser agents can use website tools on the current engine |
| #6868 | everyone | Included | Reopened Apps show saved data without a loading flash |
| #6865 | everyone | Included | Saved App data appears before the full launch finishes |
| #6863 | everyone | Included | Large chat attachments can reach the workspace for agent work |
| #6862 | everyone | Included | Leaving an App cancels its pending load so the next App is not held up |
| #6860 | everyone | Included | Assistive technology can identify the teaching window's controlled panel |
| #6853 | admins | Included | Sandbox organizations can connect Workbot to sample Microsoft 365 data |
| #6858 | desktop users | Included | Mac computer use gets its own Screen Recording permission entry |
| #6857 | everyone | Included | Workflows no longer wait for connections they do not use |
| #6855 | desktop users | Included | Browser activity no longer takes focus from other work |
| #6856 | everyone | Included | Browser steps can be grouped into a compact chat card |
| #6845 | desktop users | Included | Popped-out browser stays visible when posting in chat |
| #6843 | everyone | Included | Returning during a computer pause no longer waits for the pause to finish |
| #6839 | everyone | Included | Read-only Apps can load connected-service data without an approval click |
| #6841 | everyone | Included | New Workbot computers open faster |
| #6842 | admins | Included | Google Vertex providers accept EU and US multi-region locations |
| #6838 | everyone | Included | Workbot computers keep open apps and tabs during an unhelpful image update |
| #6834 | everyone | Included | Workbot computers are not paused during an active command |
| #6828 | desktop users | Included | Pop out opens the browser in a real resizable window |
| #6829 | everyone | Included | Workbot computers tolerate slow pauses and resumes |
| #6831 | admins | Included | SSO test failures explain when the email domain does not match |
| #6830 | everyone | Included | Drive files can be downloaded into the workspace drive folder without a prompt |
| #6832 | everyone | Included | Workbot progress steps use the right Outlook, Calendar, and OneDrive names |
| #6776 | everyone | Included | Agents no longer try tools fully blocked by organization permissions |
| #6760 | everyone | Included | Workbot teaching opens in a floating, collapsible window |
| #6812 | admins | Included | Grafana Cloud can be added as an MCP connector preset |
| #6825 | admins | Included | Admins can test and enable SSO again without locking out a self-hosted setup admin |
| #6822 | admins | Included | Older agents can no longer bypass outside-folder restrictions |
| #6821 | admins | Included | When enabled, admins can set computer, scripting, and folder permissions per agent |
| #6820 | desktop users | Included | Individual background commands can be stopped from the composer when enabled |
| #6818 | desktop users | Included | Feed rows give titles more room and keep decisions and actions clearer |
| #6814 | everyone | Included | When enabled, agents can create and update recurring Google Calendar meetings |
| #6815 | desktop users | Included | Sidebar starts on Workspaces and makes side-chat activity visible |
| #6808 | everyone | Included | Full desktop task results appear in Slack with readable formatting |
| #6805 | everyone | Included | Missing and remote chat files offer a safe copy-path fallback |
| #6806 | everyone | Included | Sign-in method is remembered, remote tasks open like helpers, and restart appears only when an update is ready |
| #6803 | everyone | Included | Chat file links resolve home-relative and nested filenames |
| #6802 | admins | Included | Agent, browser, and computer-use settings each use one control for their related behavior |
| #6799 | desktop users | Included | Remote tasks stay in the Agents list after follow-ups |
| #6801 | desktop users | Included | Desktop Calendar is removed; Automations and Workbot Calendar remain |
| #6798 | everyone | Included | Makes chat, Artifacts, and schedule improvements generally available |
| #6796 | everyone | Included | Workbot includes OpenWork models and clearer usage recovery |
| #6794 | desktop users | Included | Mac permission guide no longer takes keyboard focus during password entry |
| #6774 | internal | Omitted | Retires rollout switches for schedules already made generally available |
| #6784 | desktop users | Included | Mac computer use runs menu commands directly in fewer steps |
| #6792 | everyone | Included | Artifacts become list-first and retain opened-view state when enabled |
| #6758 | everyone | Included | Reopened Apps check saved launch data against current access |
| #6790 | desktop users | Included | Local and remote agents share a clearer row and status presentation |
| #6785 | everyone | Included | Workbot Calendar no longer repeats its account fallback message |
| #6787 | admins | Included | AI Gateway providers can be renamed from their title |
| #6757 | everyone | Included | Apps can show read-only data as soon as they open |
| #6782 | desktop users | Included | Selected sidebar titles return to their starting position after hover |
| #6779 | everyone | Included | Computer use defaults to completing requested tasks, not read-only modes |
| #6749 | everyone | Included | Read-only connected-service Apps load when opened without a click |
| #6773 | everyone | Included | Computer activity can appear in one compact chat card when enabled |
| #6783 | admins | Included | Workbot setup preserves its destination through sign-in and allows model-key setup |
| #6780 | desktop users | Included | Mac computer use sends screenshots when they add useful information |
| #6755 | everyone | Included | Apps start sooner in chat and on dashboards |
| #6754 | everyone | Included | Apps open with fewer Cloud round trips |
| #6777 | admins | Included | Workbot setup actions open the correct team's Den pages |
| #6771 | internal | Omitted | Removes rollout settings for generally available features |
| #6768 | desktop users | Included | Agents list opens a sub-agent chat by clicking its name |
| #6766 | admins | Included | Admins set Workbot source guardrails and members choose accounts it reads |
| #6765 | everyone | Included | Turns on 22 previously rolled-out features by default, including on self-hosted installs |
| #6762 | desktop users | Included | Shows the replying model while a response is streaming when enabled |
| #6703 | everyone | Included | Setup checklist accepts models provided by an organization |
| #6727 | everyone | Included | Gmail plain-text drafts retain authored lists and quote structure |
| #6748 | everyone | Included | Workbot browser teaching works without Computer view |
| #6744 | everyone | Included | Workbot begins reading the conversation before its app script finishes loading |
| #6743 | everyone | Included | Dashboard Apps recover when their launch expires |
| #6742 | desktop users | Included | Add-an-artifact picker stays within the window and can scroll |
| #6740 | everyone | Included | Workbot shows recent messages first and preserves scroll position |
| #6739 | everyone | Included | Workbot opens with its message box ready while chat loads |
| #6733 | admins | Included | Admins choose which connected accounts and apps Workbot reads |
| #6736 | desktop users | Included | Session search prioritizes recent chats and hides sub-agent sessions |
| #6737 | everyone | Included | Workbot side chats show and control their own computer |
| #6734 | admins | Included | Den no longer warns about a healthy runner that has not been checked |
| #6724 | desktop users | Included | Settings and provider changes no longer stop AI Gateway chats |
| #6725 | desktop users | Included | New work returns a settled session to the active list when enabled |
| #6714 | everyone | Included | Long Workbot tasks no longer cause repeated runner alarms |
| #6723 | everyone | Included | Gmail replies preserve rich quoted messages and local attribution |
| #6721 | desktop users | Included | v1 history copies finish faster and include continued chats |
| #6722 | everyone | Included | Gmail drafts render safe Markdown formatting and preserve spacing |
| #6719 | desktop users | Included | AI Gateway providers and sign-in rows appear in Settings again |
| #6713 | admins | Included | Gateway provider and connection lists load more efficiently |
| #6712 | admins | Included | Connection and Library lists load more efficiently for large organizations |
| #6720 | everyone | Included | Gmail drafts preserve intentional line breaks |
| #6711 | admins | Included | Organization deletion can finish and resume after a failed attempt |
| #5521 | desktop users | Included | Missed helper questions and approvals are recovered in the parent chat |
| #6644 | desktop users | Included | Mac computer use can see apps when nonessential accessibility reads fail |
| #6710 | desktop users | Included | Feed can group and sort sessions when enabled |
| #6708 | admins | Included | Den's workspace switcher shows the actual plan and member count |
| #6700 | admins | Included | When enabled, custom connector setup has clearer sign-in choices and live checks |
| #6693 | desktop users | Included | Library breadcrumbs preserve category and plugin context when enabled |
| #6692 | admins | Included | Admins choose connections behind Workbot sources and members avoid unnecessary sign-in prompts |
| #6658 | internal | Omitted | Platform-admin sandbox provisioning, not an end-user capability |
| #6688 | desktop users | Included | Archiving and approvals keep working when another session's folder is gone |
| #6674 | admins | Included | Gateway usage limits remain after a provider is removed |
| #6673 | admins | Included | When enabled, Slack connector setup becomes a guided checklist |
| #6659 | admins | Included | Custom MCP setup can show detected sign-in routes and accept request headers |
| #6649 | admins | Included | Organizations can opt in to running Workbot computers through a sandbox gateway |
| #6680 | desktop users | Included | Invalid OpenCode settings identify the file and setting to fix |
| #6677 | desktop users | Included | Library no longer asks members for organization Slack or GitHub app credentials |
| #6679 | admins | Included | Daily usage trends are available when the analytics option is enabled |
| #6678 | desktop users | Omitted | Early-update window was removed later in this release |
| #6671 | desktop users | Included | Sessions can be archived and restored again in v2 workspaces |
| #6670 | desktop users | Included | Bundled OpenCode v2 engine is updated, restoring features and fixes |
| #6651 | everyone | Included | Workbot chat no longer flickers as messages are sent and answered |
| #6657 | desktop users | Included | One searchable destination list chooses a workspace and group for a task |
| #6668 | desktop users | Included | More local and configured providers appear in the v2 model picker |
| #6667 | desktop users | Included | Choosing Default after Plan really returns the chat to its default agent |
| #6666 | desktop users | Included | Desktop Automations can use models available on the desktop |
| #6665 | desktop users | Included | A bad or unreadable chat no longer empties v2 workspace chat lists |
| #6663 | everyone | Included | OpenCode Zen is identified as retired and the free-model control is clearer |
| #6664 | desktop users | Included | Older chats migrate to v2, including chats previously archived |
| #6662 | desktop users | Included | OpenWork starts alongside a standalone OpenCode v2 installation |
| #6661 | admins | Included | Slack connection refusals explain how to enable MCP access |
| #6652 | desktop users | Included | Finished sessions can settle into a collapsed row and return with new activity |
| #6650 | everyone | Included | Agents can create Outlook events with working Teams meeting links |
| #6646 | desktop users | Included | Keep awake prevents the computer sleeping during agent work, with a setting to turn it off |
| #6648 | desktop users | Included | Middle-click closes a side-panel tab |
| #6645 | everyone | Included | Outlook drafts, replies, and events can use formatted HTML bodies |
| #6642 | MCP clients | Included | OpenWork Connect sends full instructions and read/write hints for tools |
| #6640 | desktop users | Included | Interrupted Windows updates repair on the next sign-in |
| #6637 | everyone | Included | Agent can answer another session's pending question with approval |
| #6639 | everyone | Included | Chat explains when a message was not sent instead of silently restoring it |
| #6636 | everyone | Included | Agents can create and message sessions on v2 |
| #6635 | desktop users | Included | Mac computer use can type into Chromium and Electron in the background |
| #6633 | admins | Included | Platform admins get a cached Control Center overview |
| #6618 | desktop users | Included | Mac computer use follows app windows and menus and hands system prompts to the person |
| #6621 | desktop users | Included | Mac computer-use clicks, scrolling, and dragging work in app windows again |
| #6629 | admins | Included | Admins choose which sources agents may read and messages explain their relevance |
| #6626 | admins | Included | Connector setup identifies providers that refuse unapproved sign-in apps |
| #6625 | desktop users | Included | Chat activity is clearer and created skills have an openable Library card |
| #6623 | admins | Included | Den Library is grouped and My bot is under Work; additional connector presets are optional |
| #6614 | desktop users | Included | Agent file uploads can proceed after approval rather than getting stuck at the picker |
| #6605 | everyone | Included | Auto no longer fails on adaptive-only Claude thinking and keeps a model through the task |
| #6615 | desktop users | Included | Closing the popped-out browser returns it to the app |
| #6613 | desktop users | Included | Browser pages stay at the panel's size while the agent works |
| #6612 | desktop users | Included | When background computer use is enabled, the agent cursor stays with its own window |
| #6611 | everyone | Included | Workbot updates computers without signing out of sites or clearing files |
| #6609 | desktop users | Included | Browser button opens or closes the side panel; Pop out is a separate browser action |
| #6607 | everyone | Included | Workbot knows which browser tab is open when you ask about the page |
| #6604 | desktop users | Included | Mac computer use can read apps that answer accessibility requests slowly |
| #6603 | desktop users | Included | Mac computer-use setup clearly identifies its own permission entry |
| #6595 | desktop users | Included | Several Mac chats can use computer use in separate windows |
| #6598 | desktop users | Included | Windows computer use hands focus and pointer back and stops when interrupted |
| #6591 | desktop users | Included | Mac computer use works in short moments and hands the computer back |
| #6599 | everyone | Included | Workbot's computer card updates promptly and avoids repeating an open screen |
| #6596 | desktop users | Included | OpenCode v2 restarts after a failed start or unexpected exit |
| #6597 | everyone | Included | MCP saves and Connect reconnects no longer fail because of unrelated connections |
| #6574 | admins | Included | Admins set an Auto Router default model and one thinking level per model |
| #6590 | desktop users | Included | Helpers can be messaged or stopped without losing drafts or chat position |
| #6586 | desktop users | Included | Streaming replies stay above later follow-ups |
| #6587 | everyone | Included | Workbot shows a live screen only when it is useful to share |
| #6580 | desktop users | Included | Chat reports when a background helper finishes, fails, or stops |
| #6576 | desktop users | Included | Working time excludes waits for approval or an answer |
| #6584 | everyone | Included | Google Workspace's Google Chat permission enables chat search and replies |
| #6571 | desktop users | Included | Mac computer use delivers clicks, drags, scrolling, and typing more reliably |
| #6582 | internal | Omitted | Model catalog snapshot refresh with no described user-visible change |
| #6575 | desktop users | Included | Working timer continues through follow-ups in the same run |
| #6579 | admins | Included | OpenRouter EU appears as a region-specific provider |
| #6578 | MCP clients | Included | Google MCP sign-ins renew without hourly sign-in prompts |
| #5121 | desktop users | Included | Follow-ups typed while a new chat starts are kept and sent |
| #6573 | admins | Included | Auto Router explains how to add the missing routing key |
| #6569 | self-hosters | Included | Public guide and Helm setting explain Auto Model Routing setup |
| #6207 | everyone | Included | Workbot Documents can browse, preview, edit, and save OneDrive files |
| #6502 | everyone | Included | Agents can read Outlook attachments and add approved files to drafts |
| #6563 | desktop users | Included | Computer tools are offered only when computer use is on |
| #6561 | everyone | Included | Workbot opens the conversation faster |
| #6564 | admins | Included | Workbot browser and computer views can be controlled separately |
| #5973 | admins | Included | Permission rules block commands named through a variable set on the same line |
| #6509 | desktop users | Included | Desktop chat can prepare an Automation for review and creation again |
| #6558 | everyone | Included | Workbot Browser has tabs and a Chrome-style browsing toolbar |
| #6568 | desktop users | Included | Mac computer-use clicks target the right window more reliably |
| #6562 | everyone | Included | Workbot runs computer commands quietly and offers to show or hand off the screen |
| #6413 | internal | Omitted | Desktop runtime dependency update; no product behavior described beyond security maintenance |
| #6566 | desktop users | Included | Older workspaces no longer load a retired browser plugin alongside built-in tools |
| #6560 | everyone | Included | Idle Workbot computers pause reliably and reopen faster |
| #6557 | everyone | Included | Opening a Workbot computer view resumes it automatically |
| #6565 | everyone | Included | Auto no longer fails when using OpenAI models for tool tasks |
| #6559 | desktop users | Included | Restores support for the previous engine and engine switching |
| #6528 | everyone | Included | Workbot chat stays open beside work and knows the open document |
| #6556 | desktop users | Included | Remote-computer setup cards open Settings → Computer use |
| #6532 | admins | Included | AI Gateway Auto Router can choose a model for each prompt |
| #6533 | everyone | Included | Returning sign-in remembers the last method and supports password saving |
| #6515 | desktop users | Omitted | v1-only removal was reverted in this release; dual-engine support remains |
| #6546 | everyone | Included | Automations can run every few hours or before/after Google Calendar meetings |
| #6544 | MCP clients | Included | Assistants can organize conversations in a single checked script when enabled |
| #6516 | admins | Included | Organization plan and user limit can be managed in one place |
| #6537 | everyone | Included | Gateway credential errors explain who can resolve them |
| #6538 | desktop users | Included | AI Providers distinguishes untested and rejected credentials from verified ones |
| #6540 | everyone | Included | Agents can send Slack messages from the OpenWork app when enabled |
| #6535 | desktop users | Included | Temporary session-check failures no longer make synced models disappear |
| #6539 | desktop users | Included | Organization skills load in one step and show their names in chat |
| #6519 | admins | Included | My Library connects to connector management and shows plugin skill steps |
| #6690 | website visitors | Included | Slack setup docs add a step-by-step guide and video |
| #6585 | website visitors | Included | Website comparison and roadmap reflect current product information |
| #6549 | website visitors | Included | AI Gateway docs compare provider support and explain legacy differences |

#### Behavior changes and removals
- The desktop Calendar is removed. Automations and Workbot's Calendar remain available.
- Popping out the built-in browser now opens a real, resizable window instead of the small preview card. The Browser button opens or closes the side panel; pop out is controlled from inside the browser.
- The sidebar now opens on Workspaces by default. Selecting Default after Plan returns the chat to its default agent.
- Downloading a Drive, OneDrive, or SharePoint file into the workspace's `drive/` folder no longer asks for approval; replacing a local copy or saving elsewhere still does. Library setup no longer asks members for organization-owned Slack or GitHub app credentials.
- Computer use now defaults to completing the requested task rather than staying in read-only modes. Twenty-two already rolled-out features also become defaults, including the Library, browser, and analytics improvements described above.
- Restart is offered only when an update is ready; the early-update download window was removed.
- The v1-only engine removal was reverted in this release. Engine switching and previous-engine support remain; v2-only is an opt-in rollout.
- OpenCode Zen models are no longer offered; the related admin control is labelled for the free starter model it actually controls.

#### Lines of code changed since previous release
539456 lines changed since `v0.18.63` (523034 insertions, 16422 deletions).
