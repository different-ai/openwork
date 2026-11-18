# Release Changelog Tracker

Internal preparation file for release summaries. This is not yet published to the changelog page or docs.

## v0.18.55

#### Commit
`b2535fb0`

#### Released at
`2026-10-03T01:29:39Z`

#### Title
Workflows and artifacts can use your connected tools

#### One-line summary
Workflows and artifacts can now use connected services, work handed to a desktop can be followed through to its result, and OpenWork adds broader Auto, MCP, chat, and self-hosting improvements.

#### Pull requests
| PR | Audience | Decision | Reason |
|---|---|---|---|
| #5585 | everyone | Included | Workflows, live artifacts, and scheduled Automations can call connected tools |
| #5582 | MCP clients | Included | Standard OpenAI and Anthropic clients can list and call Gateway models without provider-specific URLs |
| #5580 | admins | Included | Provider lists and connections are more responsive under concurrent use |
| #5581 | everyone | Included | Artifacts can use connection tools with large inputs |
| #5555 | desktop users | Included | Model picker explains unavailable models and recovery actions clearly |
| #5560 | desktop users | Included | Dashboard tiles and controls use a cleaner, consistent layout |
| #5576 | everyone | Included | Slack reports desktop-handoff outcomes in the original thread |
| #5577 | MCP clients | Included | Apps can read, continue, stop, and list desktop sessions |
| #5574 | MCP clients | Included | Apps can follow desktop session progress and final answers |
| #5572 | desktop users | Included | Desktop handoffs and Automations appear as normal chats using the selected model |
| #5567 | desktop users | Included | Chats remain readable after switching between engines |
| #5565 | everyone | Included | Slack completion messages quote the answer, not a heading |
| #5564 | everyone | Included | Desktop handoffs report an immediate first-turn failure accurately |
| #5562 | admins | Included | Slack replies are quieter by default, with an admin option for progress updates |
| #5550 | desktop users | Included | Chats no longer fail when multiple OpenWork app instances run |
| #5561 | desktop users | Included | Built items are now called artifacts throughout the product |
| #5558 | admins | Included | Imported MCP servers display their actual names |
| #5559 | desktop users | Included | Failed tool steps and artifact creation rows are clearer and more compact |
| #5546 | everyone | Included | OpenWork in Slack can read PDFs, Office documents, and text files |
| #5547 | desktop users | Included | Chat errors and tool activity are clearer and less jumpy |
| #5545 | everyone | Included | Model replies are not cut off during Gateway updates |
| #5544 | everyone | Included | Long Slack tasks continue reliably and handle follow-ups in order |
| #5543 | self-hosters | Included | AWS ECS deployments can target an existing cluster |
| #5541 | everyone | Included | Long Slack tasks deliver answers instead of going silent |
| #5537 | desktop users | Included | Deployments can disable Auto without hiding other available models |
| #5527 | desktop users | Included | Create, edit, share, and place artifacts on a personal dashboard |
| #5534 | desktop users | Included | Packaged desktop startup works after the Auto model update |
| #5533 | desktop users | Included | Auto uses GPT-6 Luna and handles larger connected-tool lists |
| #5529 | desktop users | Included | Models appear in the picker sooner after opening OpenWork |
| #5530 | desktop users | Included | Signed-out Auto is no longer blocked for everyone on a shared network |
| #5508 | MCP clients | Included | Signed-out Auto works in OpenAI-compatible clients with the public key |
| #5506 | desktop users | Included | Engine switching is smoother and chat migration shows progress |
| #5502 | internal | Omitted | Repo agent model configuration only |
| #5500 | desktop users | Included | Activity shows member resource changes and refreshes for organizations using MCP Apps |
| #5499 | admins | Included | MCP servers with many OAuth permissions can be connected successfully |
| #5494 | desktop users | Included | Signed-out Auto works on official builds unless a version is blocked |
| #5487 | self-hosters | Included | Draft Terraform modules support ECS Fargate and Kubernetes deployments |
| #5485 | admins | Included | Platform admins can review free Auto usage across organizations |
| #5489 | desktop users | Included | Auto accepts the same chat requests as paid Models |
| #5473 | desktop users | Included | Activity shows changes to available models, skills, plugins, and connections |
| #5486 | desktop users | Included | Auto is offered to eligible members with clear availability explanations |
| #5483 | desktop users | Included | The new-task screen returns to its previous layout |
| #5484 | everyone | Included | Invited teammates can verify email and finish joining their team |
| #5480 | admins | Included | Slack can use existing connections, read shared images, and use an admin-selected model |
| #5196 | desktop users | Included | Auto joins the shared model picker; admins can enable it for organizations |
| #5195 | desktop users | Included | Desktop Auto uses the signed-in allowance and runs only for active tasks |
| #5194 | desktop users | Included | Guests and members can use the free Auto starter model |
| #5455 | desktop users | Included | HTML file previews are isolated from OpenWork and the computer |
| #5470 | desktop users | Included | Previously opened artifacts reopen quickly without a tools-unavailable flash |
| #5458 | desktop users | Included | Sent messages show attachments and pasted text as composed |
| #5456 | desktop users | Included | Prompts beginning with a path containing spaces are sent as text |
| #5466 | desktop users | Included | Browser login sync and its setup controls have been removed |
| #5468 | MCP clients | Included | App connection errors explain the cause and which organization to use |
| #5467 | MCP clients | Included | Connecting Claude through the MCP connector no longer fails on unsupported grant types |
| #5464 | internal | Omitted | Model catalog snapshot refresh with no described user-visible effect |
| #5332 | MCP clients | Included | Enabled organizations can build and share Apps as their own MCP servers |
| #5453 | internal | Omitted | Model catalog snapshot refresh with no described user-visible effect |
| #5460 | desktop users | Included | Built-in browser explains connection failures and offers Reload |
| #5459 | desktop users | Included | Restarting an update installs the newest allowed release available |
| #5461 | desktop users | Included | OpenCode v2 shows a Connect card when a service needs sign-in |
| #5454 | admins | Included | Team organizations can set up SSO; Enterprise pricing is custom |
| #5452 | admins | Included | Dashboards are enabled per organization by OpenWork staff |
| #5444 | desktop users | Included | First messages no longer wait for cloud connection upkeep |
| #5352 | admins | Included | Organizations with audit logging enabled can inspect provider changes |
| #5440 | internal | Omitted | No visual change; fixes a regression in an internal activity check |
| #5427 | desktop users | Included | The side-panel button aligns with the tool rail |
| #5433 | admins | Included | “Only models you provide” now prevents use of personal provider keys |
| #5428 | everyone | Included | External-app approval distinguishes verified identity domains and shows the return host |
| #5431 | admins | Included | Empty example plugins are removed from the Plugins page |
| #5435 | desktop users | Included | Working stays visible, helpers can be stopped separately, and Stop keeps queued text |
| #5430 | internal | Omitted | Model catalog snapshot refresh with no described user-visible effect |
| #5418 | desktop users | Included | Working stays visible, helpers can be stopped separately, and Stop keeps queued text |
| #5147 | admins | Included | Admins can approve repeated usage-limit increases |
| #5262 | desktop users | Included | Artifact previews open with the file tree collapsed |
| #5419 | desktop users | Included | OpenCode v2 shows connection sign-in and failure status in chat |
| #5409 | admins | Included | Deleting a connector removes its tools from chats and prevents them returning |
| #5405 | desktop users | Included | Local MCP connections retry after failing to start |
| #5398 | admins | Included | Free invite limit message correctly refers to seats |
| #5392 | MCP clients | Included | Consent screens identify the requesting app and where approval returns |
| #5390 | MCP clients | Included | Agents can prepare a workspace before sign-up, then hand access to its owner |
| #5389 | MCP clients | Included | Sign in to the OpenWork CLI with a browser-approved device code |
| #5388 | MCP clients | Included | Agents can sign up a new person and finish workspace setup in one pass |
| #5386 | internal | Omitted | Registry metadata is not submitted and has no described user-facing effect |
| #5394 | desktop users | Included | Disconnected providers can be enabled again in Settings |
| #5376 | desktop users | Included | OpenCode v2 can read other conversations and background agents stay visibly active |
| #5372 | admins | Included | Routine plugin management no longer repeatedly asks admins to confirm identity |
| #5370 | self-hosters | Included | Per-member model credentials work in OpenWork Web |
| #5365 | desktop users | Included | OpenCode v2 chat stays responsive during connection and provider updates |
| #5369 | admins | Included | Removing a shared plugin or connector no longer gets stuck behind identity verification |
| #5557 | website visitors | Included | The roadmap now shows a phone app starting with MCP Apps |
| #5481 | website visitors | Included | Sharing, connector, and policy documentation matches the current product |
| #5478 | admins | Included | Private-alpha admins can follow the Slack setup guide |
| #5451 | website visitors | Included | The site navigation now links to the roadmap |
| #5449 | website visitors | Included | The roadmap groups products into Ready, Building, and Coming soon |
| #5437 | website visitors | Included | Pricing lists SSO for Team and the cost calculator supports a model mix |
| #5434 | website visitors | Included | The main calculator compares like-for-like plans |
| #5415 | website visitors | Included | Claude Cowork pages compare 22 capabilities with sources |
| #5411 | website visitors | Included | The comparison explains third-party team sharing requirements |
| #5410 | website visitors | Included | Enterprise volume pricing is reflected in the cost calculator |
| #5408 | website visitors | Included | The comparison explains use of other models through a personal gateway |
| #5407 | website visitors | Included | The comparison distinguishes Claude Cowork from third-party Claude setups |
| #5406 | website visitors | Included | Enterprise pricing and Claude Team calculator assumptions are updated |
| #5402 | MCP clients | Included | OpenCode gets an MCP setup command in the website and docs |
| #5399 | website visitors | Included | Pricing clarifies Cloud's free seats and the self-hosting free tier |
| #5397 | website visitors | Included | Free-tier copy consistently says the first five Cloud seats are free |
| #5396 | website visitors | Omitted | Alias-domain redirect setup has no described user-facing content change |
| #5387 | internal | Omitted | AI-crawler traffic measurement only |
| #5384 | website visitors | Omitted | Search/canonical domain redirects only; no distinct product change described |
| #5383 | website visitors | Omitted | Search metadata and heading semantics only; page appearance unchanged |
| #5382 | website visitors | Omitted | Search metadata and sitemap cleanup only |
| #5381 | website visitors | Included | Claude Cowork comparison pages add a cost calculator and third-party comparison |
| #5380 | website visitors | Included | Documentation navigation is reorganized by product |
| #5379 | website visitors | Included | AI Gateway setup documentation adds step-by-step screenshots |
| #5378 | website visitors | Included | MCP and AI Gateway docs put actionable setup steps first |
| #5377 | website visitors | Included | Docs add a one-command MCP quickstart and AI Gateway overview |

#### Behavior changes and removals
- The product now calls items OpenWork builds “artifacts” instead of “apps.”
- Browser login sync, its setup prompt, and its settings controls are removed; you can still sign in directly in the built-in browser.
- Slack replies are quiet by default while work runs; admins can turn progress updates back on. Slack now reports desktop handoff results and clearer completion messages.
- The new-task empty screen returns to its earlier layout, and Activity now focuses on member changes to models, skills, plugins, and connections rather than background system notices.
- Organization-managed Dashboards are no longer available by default; OpenWork staff must enable them for an organization. Existing dashboard data is retained while disabled.
- Auto availability and access changed: it is offered to eligible organization members, signed-out use is supported for clients, shared-network sign-out limits were removed, and deployments may explicitly disable it.
- Auto is no longer pinned by default in the model picker. Signed-out Auto uses updated access limits, and official builds remain usable unless a version is explicitly blocked.
- Admins choosing “Only models you provide” now prevent members from adding or using personal provider keys.
- Team organizations can now set up SSO. Routine plugin and connector management no longer prompts admins to re-confirm identity as often; sensitive settings retain their checks.
- The model picker removes Advanced options and presents effort and Fast choices directly in the picker.
- Self-hosters can deploy with Terraform modules and use an existing AWS ECS cluster; these modules are described as draft.

#### Lines of code changed since previous release
296994 lines changed since `v0.18.54` (279347 insertions, 17647 deletions).

## v0.18.56

#### Commit
`78f8b5cb`

#### Released at
`2026-10-03T05:30:05Z`

#### Title
Find shared connectors that still need your sign-in

#### One-line summary
The Library makes shared connectors that need your sign-in easier to find, while self-hosted first runs are faster and side chats no longer take up space in the sidebar.

#### Pull requests
| PR | Audience | Decision | Reason |
|---|---|---|---|
| #5594 | self-hosters | Included | First folder opens much faster on a fresh `openwork-server web` install |
| #5593 | desktop users | Included | Side chats no longer take up space as chips beside session names |
| #5587 | self-hosters | Included | Faster first folder load and fewer engine-install failures on Windows |
| #5568 | everyone | Included | Find shared Library items that still need your sign-in; Den also shows an attention dot |

#### Behavior changes and removals
- Side chats no longer appear as chips in the sidebar; open a session to see its side chat.
- On a fresh `openwork-server web` install, the first folder opens in about a second instead of taking 10+ seconds on Windows; engine installation no longer fails with “resource busy or locked.”

#### Lines of code changed since previous release
291014 lines changed since `v0.18.55` (1562 insertions, 289452 deletions).
