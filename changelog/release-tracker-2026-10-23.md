# Release Changelog Tracker

Internal preparation file for release summaries. This is not yet published to the changelog page or docs.

## v0.18.61

#### Commit
`47daea2e`

#### Released at
`2026-10-23T19:18:57Z`

#### Title
Keep agent work in view while you work elsewhere

#### One-line summary
Pop computer and browser views out of chat, while Workbot, invitations, and self-hosted setup get more capable and dependable.

#### Pull requests
| PR | Audience | Decision | Reason |
|---|---|---|---|
| #6421 | everyone | Included | Teams messages and Outlook meeting invitations require confirmation, and OneDrive searches handle special characters |
| #6420 | admins | Included | Command-line sign-ins can only be approved on Den's device page |
| #6418 | everyone | Included | Existing accounts are linked to Google, GitHub, or SSO only after email verification |
| #6417 | self-hosters | Included | `openwork-server web` limits hosts and keeps its UI token on the UI's own origin |
| #6411 | admins | Included | Saving and removing Den prompts no longer fails |
| #6406 | admins | Included | Self-hosted Den admins can opt into recovering Admin-team permissions |
| #6074 | everyone | Included | Free Auto respects the anonymous-usage opt-out, and the admin Overview loads active-user data on request |
| #6068 | everyone | Included | Library Workflow cards load with fewer database requests |
| #6407 | admins | Omitted | Organization prompts are behind an off-by-default feature switch |
| #6409 | desktop users | Included | Workspace commands and skills can be listed and run from `/` on OpenCode v2 |
| #6410 | everyone | Included | Workspace invitation emails explain who invited you, which email to use, and how to get help or report abuse |
| #6405 | everyone | Omitted | Included OpenWork models in Workbot require an off-by-default feature switch |
| #6402 | admins | Included | Successful MCP sign-ins no longer appear to have failed |
| #6400 | desktop users | Included | The floating browser has its own window and full screen fills the display |
| #6399 | desktop users | Included | The computer view can float above other apps |
| #6398 | desktop users | Included | Desktop dictation transcribes in OpenWork and preserves words across pauses |
| #6361 | desktop users | Omitted | Returning to the same task after sign-in is behind an off-by-default feature switch |
| #6396 | desktop users | Included | Mac computer-use permissions no longer require restarting OpenWork |
| #6360 | everyone | Omitted | The Get set up checklist is behind an off-by-default feature switch |
| #6359 | admins | Included | Billing checkout and plan updates work more clearly, including on deployments without billing configured |
| #6358 | desktop users | Included | Existing chats move to OpenCode v2 without an administrator enabling a rollout switch |
| #6389 | desktop users | Included | Sending a message after browser takeover hands control back to the agent |
| #6390 | everyone | Included | Workbot tasks can exchange files and read just the needed part of a result |
| #6374 | everyone | Included | Workbot's Computer view stops streaming in a background tab |
| #6362 | everyone | Omitted | The unified paid usage-limit card is behind an off-by-default feature switch |
| #6392 | internal | Omitted | Fewer database reads for feature checks have no described visible effect |
| #6391 | internal | Omitted | Fetching the provider list once per change is an implementation optimization only |
| #6385 | everyone | Included | Organization skills are checked for changes more efficiently and loaded when used |
| #6388 | admins | Included | GitHub-connected plugins can resume syncing after an interrupted sync |
| #6383 | everyone | Included | Invited people can join their workspace from the sign-in screen |
| #6382 | everyone | Included | Workbot can write longer scripts and documents in one go |
| #6386 | everyone | Included | Requests in progress during an OpenWork Cloud update no longer fail part-way |
| #6372 | internal | Omitted | This changes the demo and workshop environment, not a user-facing product surface |
| #6380 | everyone | Included | Unchanged organization skills are not re-downloaded, and background downloads do not count as Library use |
| #6370 | everyone | Included | Unchecked connectors say “Not checked,” while admins can check them from Connectors |
| #6379 | everyone | Included | Workbot no longer reports a cut-off reply as completed work |
| #6378 | everyone | Included | Workbot shows browser activity live and links to pages it opened |
| #6373 | everyone | Included | Workbot's Computer view no longer flashes blank while its connection renews |
| #6371 | admins | Included | Admin organization pages show their header and tabs sooner and load each tab's data separately |
| #6218 | admins | Included | Admins can scan compact organization rows, revisit recent organizations, and see week-over-week changes |
| #6365 | self-hosters | Included | Standalone server and bootstrap installs use supported Node.js 24, with the installer providing a runtime when needed |
| #6364 | admins | Included | Free and Team billing use one count, including pending invitations until they expire |
| #6355 | admins | Included | One Connect setting controls standard tools across supported clients |
| #6352 | desktop users | Omitted | Individual connected actions in Desktop require an off-by-default rollout switch |
| #6353 | website visitors | Included | The enterprise landing page has a redesigned presentation |

#### Behavior changes and removals
- Existing chats now migrate to OpenCode v2 without an administrator enabling a rollout switch; the former upgrade control is retired.
- In `openwork-server web` mode, only localhost, IP addresses, the configured host, or explicitly allowed hosts are accepted; the UI token is sent only to same-origin UI loads. Proxy hostnames must be added with `--allowed-hosts`.
- Command-line device sign-ins can be approved only from Den's device page. Linking Google, GitHub, or SSO to an existing account now requires a verified email; SSO creation and linking are limited to the provider's verified domain.
- Sending a Teams message or inviting Outlook meeting attendees now requires explicit confirmation. Lost responses no longer prompt duplicate retries, and OneDrive searches containing `?`, `#`, or `%` work.
- Desktop dictation now shows the transcript in OpenWork on macOS and Windows, stops from the mic button, and keeps words across pauses instead of handing the session to system dictation. On OpenCode v2, `/` lists and runs workspace commands and skills again.
- The computer view and floating browser can live in their own windows above other apps; browser full screen fills the display. After browser takeover, the next message returns control to the agent. Mac computer-use permissions are requested for OpenWork Computer Use, so granting them no longer requires quitting OpenWork; existing grants may need to be approved again.
- Workbot now shows browser work separately with a live view and links to opened pages. Workbot tasks can pass files and read selected portions; longer replies can finish, and cut-off replies are no longer reported as completed work. Its Computer view pauses streaming in a hidden tab and keeps the current picture until a replacement frame is ready.
- Invited people can choose their pending workspace while signing in instead of creating a new one. Invitation emails now include the inviter, sign-in email, support information, and an abuse-reporting path.
- Connector states now distinguish “Not checked” from a failed check, and admins can trigger checks by opening Connectors. A completed MCP sign-in is no longer reported as failed; interrupted GitHub syncs can resume.
- Organization skill updates are transferred only when changed, and skill instructions are loaded when used; background downloads no longer count as Library use.
- Den prompt saves and removals no longer fail; Library Workflow cards load with fewer database requests, and admins can opt into recovering permissions for a designated Admin team on self-hosted Den.
- Requests already in progress can finish during an OpenWork Cloud update. Deployments without billing configured now explain that billing is unavailable instead of showing a server error.
- Free Auto no longer sends its analytics identifier when anonymous usage sharing is off. The Free plan covers up to five users; pending invitations count until they expire, and Team billing counts every user.
- Standalone server and bootstrap installations now require Node.js 24.x, version 24.22.1 or newer; the bootstrap installer downloads a supported runtime when needed.
- One Connect setting now controls standard tools across supported clients; the former separate rollout controls are retired.
- Admin organization rows are compact, recent organizations and week-over-week summaries are available, and organization tabs load progressively. The admin Overview loads active-user data only when requested.

#### Lines of code changed since previous release
79842 lines changed since `v0.18.60` (75653 insertions, 4189 deletions).

## v0.18.62

#### Commit
`df15f868`

#### Released at
`2026-10-23T21:49:19Z`

#### Title
Work with OneDrive and SharePoint files in OpenWork

#### One-line summary
Agents can work with OneDrive and SharePoint files, while Workbot views and Den security and admin recovery get important fixes.

#### Pull requests
| PR | Audience | Decision | Reason |
|---|---|---|---|
| #6414 | desktop users | Included | The bundled OpenCode engine blocks unsafe non-web sign-in URLs from remote MCP servers |
| #6434 | admins | Included | Opt-in administrator permission recovery works across common database encodings |
| #6416 | self-hosters | Included | Self-hosted Den deployments receive fixes for recent Next.js security advisories |
| #6429 | everyone | Included | Agents can find, open, edit, and save OneDrive and SharePoint files, including shared files |
| #6432 | everyone | Included | Workbot Browser and Computer views reconnect, and outdated computers rebuild automatically |
| #6419 | MCP clients | Included | Den admin tools require write access, scripts cannot call them, and credential reads are blocked |
| #6424 | admins | Included | Operators can enable hashed Den sign-in session tokens without signing anyone out |

#### Behavior changes and removals
- The bundled OpenCode v1 engine now opens only web links for remote MCP sign-in and rejects other URL schemes.
- Den admin writes now require `mcp:write`; scripts can no longer call admin tools, and `den_query` refuses credential and server-internal data.
- When session-token hashing is enabled, Den stores a hash instead of each new sign-in token; existing sessions remain valid and users are not signed out.
- Opt-in Den administrator permission recovery now works across common database encodings, including legacy latin1 and utf8mb3 schemas.
- Workbot reconnects its Browser and Computer views, and automatically rebuilds an outdated computer when someone opens the view (unless a turn is running).
- Agents can now search, open, edit, and save OneDrive and SharePoint files, including shared and Teams files; saved changes replace only the version that was pulled.

#### Lines of code changed since previous release
54583 lines changed since `v0.18.61` (43485 insertions, 11098 deletions).
