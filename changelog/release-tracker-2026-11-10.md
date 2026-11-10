# Release Changelog Tracker

Internal preparation file for release summaries. This is not yet published to the changelog page or docs.

## v0.18.66

#### Commit
`ef75f7b2`

#### Released at
`2026-11-10T18:31:49Z`

#### Title
Workbot is easier to follow on desktop and phone

#### One-line summary
Workbot's navigation, task updates, and file previews are easier to follow on desktop and phone, alongside more dependable desktop chat and computer work.

#### Pull requests
| PR | Audience | Decision | Reason |
|---|---|---|---|
| #7211 | admins | Included | Admins can view invoices without billing-portal access and start custom roles from Billing manager permissions |
| #7210 | desktop users | Included | The Feed no longer leaves gaps that hide sessions |
| #7199 | admins | Omitted | Member-created Gateway keys are behind a feature that is off by default |
| #7202 | admins | Omitted | Per-team member-agent settings are behind a feature that is off by default |
| #7200 | website visitors | Included | Shared App pages and public App links are kept out of search results |
| #7195 | desktop users | Included | People can choose whether Enter sends or queues follow-ups while an agent works |
| #7194 | admins | Omitted | Per-team Workbot step limits require features that are off by default |
| #7191 | admins | Included | Team settings use consistent wording and indicators across tabs |
| #7188 | admins | Omitted | Per-team Workbot settings are behind a feature that is off by default |
| #7189 | website visitors | Omitted | Opening Apps as browser sites requires a feature that is off by default |
| #7186 | MCP clients | Omitted | Public Apps require a feature that is off by default |
| #7185 | admins | Omitted | Workbot step limits are behind a feature that is off by default |
| #7183 | everyone | Omitted | Audio and video previews require a feature that is off by default |
| #7182 | everyone | Included | Workbot stays responsive as conversations grow |
| #7180 | everyone | Included | Workbot starts replies sooner and handles brief sign-in service interruptions more smoothly |
| #7181 | desktop users | Included | The model button shows the selected model while sign-in is checked |
| #7178 | everyone | Included | Workbot handles parallel lookups and long tasks more reliably |
| #7179 | everyone | Included | Workbot tabs left open during an update reload instead of breaking |
| #7175 | desktop users | Included | Chat recognizes Connect's per-action tools and shows their connection details |
| #7177 | admins | Included | Connections blocked for Workbot are unavailable in Workbot chat too |
| #7171 | desktop users | Omitted | Claude Code sign-in for Claude providers is behind a feature that is off by default |
| #7173 | internal | Omitted | Model catalog snapshot refresh has no described visible effect |
| #7168 | internal | Omitted | Bundled engine dependency update has no new user-facing flow |
| #7170 | MCP clients | Included | Claude Code and other supported clients can again search for OpenWork operations in the full tool view |
| #7167 | desktop users | Omitted | The profile sheet behavior depends on a feature that is off by default |
| #7107 | desktop users | Included | Cmd+K now offers missing session actions, group choices, and Close side chat |
| #7166 | everyone | Included | Workbot's visible chat polish includes better image proportions, restored reply styling, and a warmer voice |
| #7165 | admins | Included | Billing lists organization invoices with links to view, pay, or download them |
| #7163 | desktop users | Included | Feed opens and switches sessions faster with large histories |
| #7161 | everyone | Included | Workbot's iPhone chat uses the full screen and opens full screen from the home screen |
| #7153 | everyone | Included | Workbot files appear as preview cards and open beside chat or full screen on phones |
| #7160 | everyone | Included | Typing a longer Workbot message no longer makes the chat jump |
| #7159 | everyone | Included | Workbot's avatar and name no longer overlap |
| #7158 | everyone | Included | Workbot connector logos are easier to see in light mode |
| #7152 | everyone | Included | Workbot's header and message box float over the conversation |
| #7154 | everyone | Included | Workbot shows when an answer used OpenWork features |
| #7156 | everyone | Included | Workbot navigation is tidier and its empty task view is clearer |
| #7155 | everyone | Included | Documents has one navigation and the chat list only appears in chat |
| #7151 | everyone | Included | The Tasks tab and phone assistant profile are removed; Apps opens a simple list |
| #7148 | everyone | Included | Workbot shows connector activity and typing no longer makes the chat bounce |
| #7150 | everyone | Included | Workbot chat is limited to the chat view, with an Ask Workbot action for open documents |
| #7149 | everyone | Included | Workbot Apps uses clearer connector names and recognizable logos |
| #7147 | everyone | Included | Workbot chats are directly accessible from desktop and phone navigation |
| #7146 | everyone | Included | Browser tasks stay in chat and open a full preview only when chosen |
| #7145 | everyone | Omitted | The expanded Apps list depends on the profile-sheet feature, which is off by default |
| #7144 | everyone | Included | Remote tasks show their actual status and finished long sessions report completion |
| #7143 | everyone | Included | Workbot keeps the newest message visible while preserving your reading position |
| #7142 | everyone | Included | Browser cards appear with the correct activity and stay in chat when finished |
| #7137 | everyone | Included | Workbot task states and progress are more accurate and easier to follow |
| #7136 | everyone | Omitted | Browser recovery behavior is behind a feature that is off by default |
| #7135 | everyone | Omitted | The Workbot profile sheet is behind a feature that is off by default |
| #7134 | desktop users | Included | Short Workbot replies display cleanly, Return adds a line on touch, and HEIC previews work |
| #7129 | desktop users | Included | Workspaces in protected folders no longer fail when OpenWork cannot read their config file |
| #7123 | desktop users | Included | Cancelling browser navigation or taking over a navigating tab no longer crashes the desktop |
| #7116 | desktop users | Included | Browser tabs can be opened without hitting OpenWork's 12-tab limit |
| #7112 | self-hosters | Included | Self-hosted GitHub push reconciliation can run on a schedule instead of on every API replica |
| #7117 | admins | Omitted | Session and admin re-auth settings are behind features that are off by default |
| #7114 | desktop users | Included | Images saved on the computer appear inline in replies |
| #7102 | admins | Included | LiteLLM model sync no longer fails for IDs that differ only by letter case |
| #7103 | admins | Included | Slack messages containing shared files or images are handled as requests |
| #7105 | desktop users | Included | Sent messages and reloaded history retain composer chips and mentions |
| #7106 | admins | Included | SCIM can reprovision members removed from Den while still assigned in the identity provider |
| #7104 | desktop users | Included | Mac screen recordings can show the computer-use cursor and controls |
| #7090 | admins | Included | Organization API keys can again provision a member's Gateway provider key when permitted |
| #7094 | everyone | Included | Choosing email sign-in keeps the email form open after a remembered Google or GitHub sign-in |
| #7087 | admins | Omitted | Custom OpenAI-compatible providers are behind a feature that is off by default |
| #7088 | internal | Omitted | API documentation timestamp clarification does not change the wire format |
| #7079 | desktop users | Included | A sent message stays visible instead of leaving blank space while a reply runs |
| #7085 | admins | Included | CompactifAI is available as an AI Gateway provider |
| #7077 | admins | Omitted | Multiple SSO connections are behind a feature that is off by default |
| #7083 | desktop users | Included | You can ask an agent to settle or un-settle chats |
| #7082 | desktop users | Included | Agent questions can be dismissed instead of answered |
| #7081 | admins | Omitted | Per-member OpenWork Web access is behind a feature that is off by default |
| #7080 | desktop users | Included | The Mac computer-use outline no longer draws over windows in front of the agent's app |
| #7076 | desktop users | Included | Mac computer use brings dialogs into view when apps open them on another desktop |
| #7072 | desktop users | Included | Mac computer use can reach windows on other desktops and continue map or canvas drags after scrolling |
| #7066 | desktop users | Included | Sessions worked in today appear under Today in the Feed |
| #7070 | desktop users | Included | Saved-file actions are together in one menu and longer lists can be folded |
| #7071 | desktop users | Included | Mac computer use saves and picks files more reliably in app panels and across desktops |
| #7068 | desktop users | Included | Keyboard navigation loads missing conversation history instead of leaving a blank view |
| #7069 | desktop users | Included | Mac computer use clicks and types more reliably after switching apps |
| #7067 | desktop users | Included | Mac computer use can save through app panels, follow new windows, and use background menus |
| #7065 | desktop users | Included | File panels and fresh views are available in the same computer-use step |
| #7064 | desktop users | Included | Mac computer use can save and pick files in app panels and click in Blender across displays |
| #7196 | website visitors | Included | MCP Gateway docs explain how admins set up an app once for an organization |
| #7193 | website visitors | Included | Docs identify native Google Workspace and Microsoft 365 integrations and explain how to request more |
| #7096 | website visitors | Included | Docs provide a per-member TrueFoundry key provisioning tutorial |
| #7063 | desktop users | Included | Desktop users get a platform-specific guide to backing up conversation history |

#### Behavior changes and removals
- Workbot's Tasks tab and phone assistant profile are gone, Apps opens a simple list, and the chat no longer appears over Documents, Calendar, or Browser/Computer pages. An open document's **Ask Workbot** action switches to chat and attaches that document to the next message only.
- Workbot browser work now stays in one chat card from start to finish, and its full preview opens only when selected. Workbot-made files appear as preview cards instead of small file chips.
- Return on touch adds a new line in Workbot; desktop users can choose whether Enter sends a follow-up immediately or queues it while the agent is working.
- An admin's **Not allowed** connection setting now also blocks that connection in Workbot chat. Billing invoices use the separate `billing_invoices.view` permission; the billing-portal permission remains owner-only.
- OpenWork's 12-tab browser limit is removed. On Mac, the computer-use outline stays with the agent's app window rather than drawing over windows in front of it; the recording option can include the cursor and controls.
- Shared App pages and public App links now tell search engines not to list them.
- Cmd+K gains missing session actions and group choices, while the Settle action remains removed; its other session actions now align with the sidebar.

#### Lines of code changed since previous release
273504 lines changed since `v0.18.65` (266209 insertions, 7295 deletions).
