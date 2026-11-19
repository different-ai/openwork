# Release Changelog Tracker

Internal preparation file for release summaries. This is not yet published to the changelog page or docs.

## v0.18.59

#### Commit
`0c60c8a6`

#### Released at
`2026-10-20T22:32:16Z`

#### Title
Read, edit, and discuss documents in Workbot

#### One-line summary
When Documents is enabled, people can preview and work on files alongside Workbot chat, while this release also improves model setup, admin diagnostics, self-hosting, and everyday chat reliability.

#### Pull requests
| PR | Audience | Decision | Reason |
|---|---|---|---|
| #6252 | admins | Included | Deployment diagnostics show desktop startup, provider, connector, and service health |
| #6243 | admins | Included | Audit logs load faster for organizations with extensive history |
| #6244 | everyone | Included | Workbot explains when an organization needs an AI provider and who can add one |
| #6242 | everyone | Included | Teammates on one network can sign up and verify email without sharing a tiny limit |
| #6239 | everyone | Included | Document previews avoid reload flashes and editing details appear when editing is chosen |
| #6238 | desktop users | Included | Developer session diagnostics can be moved, resized, closed, and reopened |
| #6226 | desktop users | Included | Environment-based provider endpoints now work with OpenCode v2 |
| #6230 | desktop users | Included | Workspace report files save in the opened folder and show their destination |
| #6231 | admins | Included | Den API deployments start successfully instead of failing while loading service readiness |
| #6227 | everyone | Included | Documents open in read-only preview before an optional edit session |
| #6212 | self-hosters | Included | GCP installs no longer reject valid Docker Hub images or miss a project prerequisite |
| #6225 | desktop users | Included | Azure Foundry and custom OpenAI-compatible providers work with OpenCode v2 |
| #6224 | self-hosters | Included | Self-hosted operators can inspect optional service health and setup fields in Settings |
| #6195 | self-hosters | Included | New AWS and Google Cloud installs get larger database defaults |
| #6219 | admins | Included | Deployment administrators can check service health and setup requirements |
| #6208 | desktop users | Included | The optional chat upgrade remains available after a slow startup |
| #6211 | desktop users | Included | Reply model details stay hidden until hover or focus |
| #6205 | desktop users | Included | Failed file writes no longer appear successful |
| #6201 | admins | Included | Previously enabled organization models, skills, permissions, and chat improvements no longer need rollout overrides |
| #6206 | admins | Included | Cloud agents use supported models and credentials assigned through the organization's AI Gateway |
| #6203 | admins | Included | Google Workspace settings identify disabled APIs and link to their activation pages |
| #6199 | everyone | Included | Google Docs, Sheets, and Slides open in Google and save to the original file |
| #6197 | everyone | Included | Documents and spreadsheets show their contents instead of a blank editor while loading |
| #6194 | self-hosters | Included | Managed AWS upgrades can run their database migration instead of stopping during maintenance |
| #6196 | everyone | Included | Workbot can offer a mentioned document while keeping its conversation open beside it |
| #6127 | desktop users | Included | Some requests that failed between the app and its server now work |
| #6193 | desktop users | Included | Message buttons and right-click menus show the same actions for each message type |
| #6191 | desktop users | Included | Files created in a conversation's worktree open and save in that same folder |
| #6190 | desktop users | Included | Chat file links with spaces or `file://` open correctly |
| #6189 | everyone | Included | On OpenWork Cloud, Office files can open in an editor in the member's own workspace when enabled |
| #6188 | self-hosters | Included | Managed AWS upgrades migrate the database once before services start |
| #6187 | internal | Omitted | Terraform module checks only; no product behavior change described |
| #6186 | everyone | Included | Workbot's link-only sharing was removed; authorized inviters can still email invitations from Den |
| #6174 | everyone | Included | Workbot can connect assigned accounts without leaving chat and can restore authorized unsaved files |
| #6169 | everyone | Included | Workbot sign-in keeps workspace setup in one flow and provides recovery steps |
| #6179 | admins | Included | Admins can test Workbot's default model without creating a conversation |
| #6165 | admins | Included | Members with team-management access can open that team's settings from Workbot |
| #6168 | everyone | Included | Workbot members can share a link and see when an invitation is still needed |
| #6146 | admins | Included | Spend limits retain provider scope and saved providers when lookups fail |
| #6139 | everyone | Included | Viewers can run a readable Workflow manually but cannot schedule it |
| #6130 | everyone | Included | Automations can be created in the web app and run when manually triggered |
| #6178 | self-hosters | Included | Automations and Workbot can use tools with newer OpenAI models through Responses |
| #6138 | desktop users | Included | Provider refreshes no longer silently replace an organization-assigned chat model |
| #6137 | desktop users | Included | Completed replies show a readable model name when routing details are missing |
| #6136 | desktop users | Included | The latest reply can show which model answered below the answer |
| #6125 | desktop users | Included | Opening a side chat places the cursor in its message box |
| #6126 | desktop users | Included | The next prompt is no longer lost after sending a message |
| #6124 | desktop users | Included | Settings and shortcuts list the same models as chat; Recent keeps models under their provider |
| #6122 | everyone | Included | Model pickers and Cmd+K behave consistently across desktop and Den web |
| #6119 | admins | Included | Organizations can move chats between engines automatically and safely return forced instances |
| #6117 | desktop users | Included | OpenWork Web no longer shows a desktop chat-upgrade prompt or fails to attach its history snapshot |
| #6118 | desktop users | Included | Unavailable models disappear from the picker and chats move to an available model |
| #6120 | desktop users | Included | Fast mode is available again for supported organization OpenAI models |
| #6111 | admins | Included | Organization model changes can appear in the open desktop picker when enabled |
| #6110 | self-hosters | Included | Self-hosting documentation presents AWS, Google Cloud, and Azure modules consistently as beta on `dev` |
| #5967 | self-hosters | Included | AWS self-hosters have a supported module with verified database certificates and a single migration step |
| #6108 | desktop users | Included | Model picker rows show full names and avoid repeating option warnings |
| #6106 | everyone | Included | Documents navigation stays hidden until Documents is enabled for the workspace |
| #6103 | desktop users | Included | Model picker search understands providers, typos, and options such as Fast |
| #6098 | everyone | Included | When enabled, Workbot offers Drive browsing, document editing, and chat alongside Documents and Calendar |
| #6061 | self-hosters | Included | Cloud Run deployment defaults protect secrets and use safer database settings |
| #6085 | self-hosters | Included | Deployment docs explain the shared Terraform module contract and beta support |
| #5929 | self-hosters | Included | A draft Azure Container Apps module provides another self-hosting path |
| #6093 | admins | Included | When enabled, Workbot can search Google Docs passages and make precise requested edits |
| #5971 | self-hosters | Included | A draft Terraform module deploys the Den control plane on Google Cloud Run |
| #6095 | desktop users | Included | Branching an OpenCode v2 chat starts from the selected message |
| #6094 | desktop users | Included | OpenCode v2 App connection errors offer a scoped Retry view without disrupting task recovery |
| #6081 | desktop users | Included | Large chat histories copy fully to OpenCode v2 and interrupted copies resume after restart |
| #6084 | desktop users | Included | When enabled, offline recovery preserves work and offers explicit continuation after reconnecting |
| #6083 | everyone | Included | Newly created or updated Apps keep readable colors when switching themes |
| #6080 | everyone | Included | When enabled, signing back in can reopen the last organization |
| #5837 | desktop users | Included | Agents use the built-in browser without repeated permission prompts |
| #6002 | MCP clients | Included | Shell-using agents can download Drive files through short-lived links and save edits back |
| #6071 | desktop users | Included | OpenCode v2 chats recover missed replies, tool results, and questions after reconnecting |
| #6056 | admins | Included | Admins can configure exact OAuth sign-in addresses for custom MCP connections |
| #6075 | admins | Included | Organization feature controls have their own tab and remain readable on phones |
| #6066 | internal | Omitted | Plugin loading implementation optimization without a user-visible change stated |
| #6062 | everyone | Included | Dashboard Apps keep their previous data visible while refreshing |
| #6048 | admins | Included | Admins can navigate organization activity and inspect free Auto conversion insights |
| #6070 | desktop users | Included | Working and background-task status shimmer together as one line |
| #5975 | desktop users | Included | Tasks started on another computer appear in chat with status and controls |
| #6057 | desktop users | Included | App creation progress stays close to the request instead of leaving a large gap |
| #6054 | desktop users | Included | App creation progress remains visible and active through hidden tool steps |
| #6020 | desktop users | Included | Desktop agents can download Drive files, edit them locally, and save with confirmation |
| #6053 | MCP clients | Included | The MCP server API origin answers domain checks directly instead of redirecting |
| #6052 | desktop users | Included | App creation keeps one progress view through completion |
| #6044 | MCP clients | Included | MCP clients can identify OpenWork and discover clearer tool guidance and built-in views |
| #6045 | everyone | Included | When enabled, private key fields are consistent and chat setup supports more credential types |
| #6050 | desktop users | Included | App creation shows a stable checklist earlier in the process |
| #6049 | desktop users | Included | Apps share connection discovery and recover from temporary first-load failures |
| #6026 | admins | Included | Install links use the normal install page; old links continue to work and connection codes are removed |
| #6024 | self-hosters | Included | Self-hosted sign-in and account labels name the organization's server |
| #6047 | MCP clients | Included | MCP sign-in can discover OAuth metadata when the initial request reaches a login page |
| #6046 | admins | Included | Invite links are visible only to authorized inviters; enabled invite verification can remove the email-code step |
| #6018 | everyone | Included | When enabled, chat accepts API keys in a private field that is not sent to the model |
| #6037 | internal | Omitted | Retry-safe database migration change with no user-facing behavior described |
| #6032 | admins | Included | Admins can assign custom roles when inviting or editing a member |
| #6033 | admins | Included | Desktop suggestions move into Everyone and team tabs; the old Desktop policies screen is retired |
| #6034 | everyone | Included | Microsoft 365 stays connected after successful Entra sign-in |
| #6029 | admins | Included | Members, Teams, and Roles lists have consistent filters and deleted teams leave reusable roles |
| #6030 | admins | Included | Models & usage and Task analytics are opt-in views; existing collection and exports continue when hidden |
| #6027 | admins | Included | Team plugin access is easier to scan and direct access removal asks for confirmation |
| #6019 | desktop users | Included | When enabled, App creation appears as a staged checklist in chat |
| #6025 | internal | Omitted | Revert of the invite-link change; final re-land is described in #6046 |
| #6011 | admins | Included | Invite links require invitation-management access and can verify invite email when enabled |
| #5992 | desktop users | Included | Apps load their read-only data as soon as they open |
| #6007 | desktop users | Included | Clock times in chat answers no longer turn into emoji |
| #6010 | desktop users | Included | Chat emoji shortcodes match GitHub and ordinary colon-wrapped text stays intact |
| #6013 | desktop users | Included | Chat answers keep single line breaks instead of running lines together |
| #6016 | desktop users | Included | Clicking a link inside a PDF opens it in the built-in browser instead of closing OpenWork |
| #6015 | desktop users | Included | Open Apps follow OpenWork's dark mode |
| #5997 | everyone | Included | Apps open and respond faster in organizations with large libraries |
| #6014 | admins | Included | Team pages can show Browser and Models settings for the team |
| #6012 | admins | Included | Members › Teams rows fit long names and ask before deleting a team |
| #6004 | admins | Included | With plain install links enabled, Copy install link shares the regular install page |
| #6006 | desktop users | Included | OpenWork model icons remain visible in dark mode and unsupported effort choices are hidden |
| #6003 | desktop users | Included | New installs start on OpenCode v2; existing installs keep their current engine |
| #5980 | desktop users | Included | Organization-provisioned Google models use supported thinking levels for conversation titles |
| #5482 | desktop users | Included | A v2 conversation can be rebound to an available model without opening it |
| #5995 | admins | Included | Agent permissions move from Settings into Members › Teams; old links still work |
| #5994 | admins | Included | Members › Teams shows Everyone and which teams override its agent permissions |
| #5993 | admins | Included | Admins can edit agent permissions from the team's Agents tab and Everyone's page |
| #5968 | desktop users | Included | After the first message in a new session, the composer stays ready for the next one |
| #6000 | admins | Included | Admins can set separate AI Gateway spend limits for each provider |
| #5991 | admins | Included | Local skills and MCP servers use simple Allowed/Blocked switches without affecting organization resources |
| #5996 | everyone | Included | Plugin and skill lists load with fewer requests |
| #5990 | desktop users | Included | OpenCode v2 chat upgrades copy history first and resume interrupted copies after restart |
| #5989 | admins | Included | Agent permission changes reach desktop apps within five minutes, with timing shown to admins |
| #5983 | desktop users | Included | Automatic chat naming works again for AWS-signed Bedrock requests |
| #5987 | desktop users | Included | Restarting OpenWork starts the v2 engine for members with saved agent permissions |
| #5986 | admins | Included | Edit role and Invite share the same role choices and aligned menu |
| #5985 | admins | Included | Production API startup works so admins can deploy organization default-model settings |
| #5984 | internal | Omitted | Database migration retry compatibility; no direct user-facing change described |
| #5978 | admins | Included | Admins can choose a default model for new v2 desktop chats by organization or team |
| #5974 | everyone | Included | Long role names and share-recipient lists stay inside their dialogs |
| #5955 | desktop users | Included | Signing in to the already-configured Den no longer triggers repeated server-switch prompts |
| #5816 | admins | Included | Admins can set agent permissions for everyone or per team |
| #5966 | desktop users | Included | Apps follow OpenWork's theme and fit narrow panels and dashboard tiles |
| #5946 | admins | Included | Deployments has clearer installer guidance and an opt-in Google Cloud approval flow |
| #5965 | desktop users | Included | Reopened Apps show their previous data immediately and then refresh |
| #5943 | everyone | Included | Connecting a service from a chat card continues the task automatically |
| #5961 | internal | Omitted | Evidence cleanup tooling only |
| #5963 | desktop users | Included | Oversized chats can upgrade without their largest outputs; full histories remain in v1 |
| #5941 | desktop users | Included | Chat shows commands still running in the background and when they finish |
| #5956 | internal | Omitted | CI world-template handling only |
| #5953 | desktop users | Included | Quoted drafts preserve lines and bullets and can be copied as a whole |
| #5951 | everyone | Included | Buttons and refreshes inside an open App respond faster |
| #5949 | everyone | Included | Apps load and refresh their data faster |
| #5952 | desktop users | Included | Chat upgrades finish when an individual chat cannot be copied and list chats left in v1 |
| #5930 | admins | Included | Analytics can show every Library use and drill into items and people |
| #5948 | admins | Included | Den dashboard pages return to their previous backgrounds and layouts |
| #5945 | desktop users | Included | Chat shows App creation and editing progress before the agent finishes writing |
| #5942 | internal | Omitted | CI snapshot cleanup only |
| #5928 | desktop users | Included | Global skills in the standard OpenCode folders work in v2 chats |
| #5839 | desktop users | Included | Agents build Apps from working starters and chat shows one App step |
| #5927 | desktop users | Included | Selecting a skill no longer fails when another copy has the same name |
| #5503 | desktop users | Included | Composer menus show all commands without clipping and close when clicked away |
| #5925 | internal | Omitted | Runner presence write optimization without a user-visible change described |
| #5926 | desktop users | Included | Organization skills work in OpenCode v2 without disabling OpenWork tools |
| #5923 | admins | Included | The Library loads faster for organizations with many Workflows |
| #5922 | self-hosters | Included | Self-hosted Gateway usage rollups run hourly and handle larger batches |
| #5898 | everyone | Included | Several finished features become standard, and organization Dashboards are removed |
| #5920 | desktop users | Included | Chat upgrades run separately from the app and skip already copied chats |
| #5094 | desktop users | Included | OpenCode v2 no longer reports deprecated models as missing or delays provider changes for model checks |
| #5919 | everyone | Included | Google actions explain whether the issue is an API, file format, access, or sign-in |
| #5907 | internal | Omitted | Organization permission-read optimization only |
| #5905 | desktop users | Included | Approving or denying permission requests on OpenCode v2 no longer leaves tasks waiting |
| #5908 | internal | Omitted | Repeated database reads shared within a request; no user-facing behavior described |
| #5906 | internal | Omitted | Feature-flag lookup optimization only |
| #5903 | everyone | Included | Agents receive the connected service's reason when an action is refused |
| #5497 | everyone | Included | Apps show a connection card when their connected service needs attention |
| #5900 | internal | Omitted | Audit policy query optimization only |
| #5899 | admins | Included | Dashboard Activity loads faster in organizations with many plugins |
| #5067 | desktop users | Included | Apps that fail during Cloud credential refresh reload when sign-in is restored |
| #5896 | everyone | Included | Revoked Google access prompts members to reconnect instead of failing |
| #5881 | everyone | Included | CLI sign-in waits through temporary request limits until browser approval |
| #5895 | internal | Omitted | Model catalog snapshot maintenance with no user-visible change described |
| #5883 | everyone | Included | More finished features become standard, Connect can no longer be disabled, and organization Dashboards are removed |
| #6217 | website visitors | Included | Trust Center links now open the hosted Trust Center, while `/trust` bookmarks redirect there |

#### Behavior changes and removals
- New desktop installs start on OpenCode v2; existing installs keep their current engine. For organizations with OpenWork Models, model selection, unavailable-model recovery, and some model labels now behave differently.
- In chat, the latest reply's model detail is quiet until hover or focus, message buttons match their right-click menus, and branching an OpenCode v2 conversation stops at the selected message. A viewer can run a readable Workflow manually but still cannot schedule it.
- Documents opens as a read-only preview first, with editing as a separate action when enabled. Google Docs, Sheets, and Slides stay in Google; the Office editor behavior remains separate.
- Deployment service checks now live in Settings › Diagnostics; the old Services dashboard route redirects, and the previous service-readiness switch is retired.
- Workbot no longer offers link-only sharing. Authorized email invitations remain available from Members in Den.
- Invite-link access and the sign-in verification step can change when invite verification is enabled; old install links continue to work, but install links now use the normal sign-in page and desktop connection codes are removed.
- Agent permissions move from Settings into Members › Teams; local skills and MCP servers use simple Allowed/Blocked rules without blocking organization resources. Models & usage and Task analytics are opt-in, and the organization Dashboards feature is removed; personal desktop dashboards remain. Previously enabled organization features are now standard rather than depending on rollout switches.
- OpenWork's built-in browser no longer asks for repeated permission prompts. Local skill and MCP server controls are now Allowed/Blocked switches and do not block organization Cloud skills or connections.
- Oversized chats can be copied to OpenCode v2 with their largest outputs or attachments left in the original OpenCode v1 history; the upgrade lists chats that remain in v1.
- The hosted Trust Center replaces the in-site `/trust` page; that address permanently redirects to the hosted center.

#### Lines of code changed since previous release
508195 lines changed since `v0.18.58` (371181 insertions, 137014 deletions).
