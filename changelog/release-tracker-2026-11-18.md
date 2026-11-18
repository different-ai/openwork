# Release Changelog Tracker

Internal preparation file for release summaries. This is not yet published to the changelog page or docs.

## v0.18.68

#### Commit
`42a16469`

#### Released at
`2026-11-18T00:55:52Z`

#### Title
Chat and cloud work recover more reliably

#### One-line summary
Conversations and cloud computer work recover more smoothly, while admins get clearer controls for usage, computers, and organization setup.

#### Pull requests
| PR | Audience | Decision | Reason |
|---|---|---|---|
| #7503 | desktop users | Included | Conversations stay in place while earlier messages load or scrollbars appear |
| #7502 | desktop users | Omitted | Side chat tab and selected-text references require the off-by-default side chat feature |
| #7498 | desktop users | Included | Right-clicking a backticked file path opens its file actions |
| #7497 | desktop users | Included | Failed steps and dropped connections are explained without alarming red error text |
| #7493 | admins | Included | Long provider names no longer overlap amounts in AI Gateway limits |
| #7489 | desktop users | Included | Answers recovered after a dropped connection render as one complete answer |
| #7490 | desktop users | Omitted | Suggested follow-ups are behind an off-by-default feature |
| #7492 | admins | Included | Admins can inspect cloud computers and their state on a Computer fleet page |
| #7491 | desktop users | Included | Long agent questions scroll in their own space instead of hiding the conversation |
| #7487 | desktop users | Omitted | Side chat and `/btw` require the off-by-default side chat feature |
| #7483 | desktop users | Included | Requests for separate threads now start sessions in the sidebar, not sub-agents |
| #7482 | MCP clients | Omitted | Session management and event subscriptions are behind an off-by-default feature |
| #7478 | admins | Included | Platform admins can inspect live cloud runner nodes on a Runner fleet page |
| #7480 | admins | Included | Idle cloud conversations no longer wake themselves daily and crowd runner capacity |
| #7476 | internal | Omitted | Model catalog snapshot refresh has no described user-visible effect |
| #7475 | admins | Included | Cloud tasks can retry when a runner node is full, with an alert for the team |
| #7473 | admins | Included | Admins can choose which TrueFoundry models are available to their organization |
| #7461 | self-hosters | Included | AWS managed deployments can opt into a Gateway-backed profile |
| #7472 | everyone | Included | Slack tasks retry when the cloud runner briefly drops its connection |
| #7462 | everyone | Included | Workbot replaces a computer whose desktop will not start sooner |
| #7460 | everyone | Included | Workbot shows when it is replacing a computer instead of offering a disruptive rebuild |
| #7458 | desktop users | Included | A chat sign-in remains connected to its card when the agent makes another tool call |
| #7455 | everyone | Included | Workbot's message box stays visible above the Android keyboard |
| #7454 | desktop users | Included | Where an organization requires it, desktop owners are asked what other devices may do on their computer |
| #7453 | MCP clients | Included | Per-connection routes now enforce admin review and Workbot access restrictions |
| #7449 | admins | Included | Members without display names appear in the Members list under their email |
| #7451 | MCP clients | Included | Missing provider permissions no longer sign users out, and the error names the needed permissions |
| #7444 | everyone | Included | Workbot explains when a computer cannot take tasks and duplicate offline computers are hidden |
| #7448 | admins | Included | My Usage now appears under Work in the Den sidebar |
| #7447 | everyone | Included | Model-provider connection failures now explain the cause in plain language |
| #7446 | desktop users | Included | Background helpers stay in the Agents list with their own Stop control |
| #7442 | self-hosters | Included | Self-hosters can configure the organization API-key request limit |
| #7434 | admins | Included | Spend limits can be assigned to invited people before they join |
| #7440 | desktop users | Included | Ollama stays listed in AI Providers with a Configure button |
| #7422 | everyone | Included | Workbot preserves computer-command results if the service restarts while they run |
| #7423 | desktop users | Included | The installed desktop app is smaller |
| #7420 | everyone | Included | Workbot's computer view and computer steps respond faster while a chat is working |
| #7421 | everyone | Included | Large files move directly between Files and a Workbot computer, avoiding the earlier copy timeout |
| #7419 | everyone | Included | A Workbot computer used since an update opens its desktop without waiting for that update |
| #7438 | desktop users | Included | Ollama now has a persistent Configure entry in AI Providers instead of Enable or Use Ollama |
| #7435 | self-hosters | Included | PlanetScale deployments retry plugin creation with a new key when its name is already used |
| #7425 | desktop users | Included | Desktop startup no longer fails on a stored configuration timestamp that is too large |
| #7433 | admins | Included | Organization configuration exports and imports now carry built-in connections and their settings |
| #7426 | everyone | Included | Japanese Excel phonetic readings no longer appear appended to spreadsheet cell text |
| #7431 | admins | Included | Configuration re-imports match renamed plugins and skills, reuse prior answers, and flag name conflicts before approval |
| #7424 | admins | Included | Whole-organization configuration imports complete in one run with one choice per missing person or team |
| #7413 | desktop users | Included | Diagnostics gives a plain status, app version, and a Copy report action |
| #7417 | everyone | Included | Multi-step Workbot, Slack, and Automation replies start each step sooner |
| #7414 | everyone | Included | Members can see their own AI Gateway limits, recent usage, and model prices in My Usage |
| #7411 | desktop users | Included | Ollama settings moved from their own sidebar entry to AI Providers |
| #7412 | self-hosters | Included | Terraform operators can deploy an optional AI Gateway with its own HTTPS hostname |
| #7407 | admins | Included | The retired Network check has been removed from Settings Diagnostics |
| #7404 | desktop users | Included | When disk space is exhausted, OpenWork says so instead of showing a generic server error |
| #7406 | desktop users | Included | The Settings Help section no longer links to Discord |
| #7401 | everyone | Omitted | Workbot device activity is behind an off-by-default feature |
| #7032 | desktop users | Omitted | Automation failure notifications are behind an off-by-default feature |
| #6876 | desktop users | Included | Packaged desktop builds keep the debugging port closed unless explicitly enabled |
| #7398 | desktop users | Included | Chat shows a Connect card when a connection needs sign-in instead of failed steps and a link |
| #7115 | desktop users | Included | Agents can show images found on the web inline in chat |
| #7397 | admins | Included | The Den sidebar logo now returns to the organization dashboard |
| #7386 | everyone | Included | Connector sign-in confirms the OpenWork account when the browser is not signed in |
| #7383 | admins | Included | SCIM can change account email only between the organization's verified SSO domains |
| #7396 | desktop users | Included | Italian is now available as an app language |
| #7385 | admins | Included | AI Gateway keeps Microsoft Foundry credentials on the provider's own resource or an approved address |
| #7389 | admins | Included | Workflows and schema checks stop a regular expression that takes too long |
| #7380 | admins | Included | SCIM deprovisioning is limited to the organization's own users and accounts it provisioned |
| #7381 | desktop users | Included | Signing in to sites in the built-in browser works after handing a tab back from the agent |
| #7367 | desktop users | Included | Local model providers stay available when one saved provider entry cannot be read |
| #7368 | desktop users | Omitted | Minimizing agent questions is behind an off-by-default feature |
| #7378 | admins | Included | Platform admins can choose a new sandbox's models without enabling a rollout switch |
| #7376 | admins | Included | Team settings use horizontal tabs, Workbot's tabbed settings are standard, and cloud sandboxes include sample Slack by default |
| #7373 | desktop users | Included | On Windows, the agent can open an installed app that is not already running |
| #7369 | desktop users | Included | OpenCode connection status now reflects the engine used by chats; importing connections remains off by default |
| #7370 | everyone | Omitted | Setup checklist changes are behind an off-by-default feature |
| #7364 | desktop users | Included | Hidden side chats no longer leave blank rows between conversations |

#### Behavior changes and removals
- Ollama moved from its own Settings sidebar entry into AI Providers; its separate **Use Ollama** action is gone and **Configure** is available from the provider row.
- The Diagnostics screen now leads with a status line and Copy report; detailed rows are tucked under Technical details. The Network check and its Den settings are removed, while the desktop, AI provider, connector, and installation checks remain.
- The Settings Help section no longer has a **Join Discord** button. Packaged desktop builds also no longer leave a debugging port open by default; Help can restart the app with debugging when needed.
- Team settings now use horizontal tabs, Workbot's tabbed settings are the standard, and cloud sandboxes include sample Slack without a separate rollout switch. Platform admins can choose sandbox models without a rollout switch as well.
- Connector sign-in from a browser without an OpenWork session now asks for confirmation of the account before completing. SCIM email changes and deprovisioning, and per-connection access, are more tightly limited to the organization's authorized users and settings.

#### Lines of code changed since previous release
212080 lines changed since `v0.18.67` (77419 insertions, 134661 deletions).
