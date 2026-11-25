# Release Changelog Tracker

Internal preparation file for release summaries. This is not yet published to the changelog page or docs.

## v0.18.67

#### Commit
`96d33f7a`

#### Released at
`2026-11-13T06:10:42Z`

#### Title
AI Gateway capabilities are now available to every organization

#### One-line summary
AI Gateway features are now available to every organization, while computer access, Workbot tasks, and desktop workflows are easier to manage and recover.

#### Pull requests
| PR | Audience | Decision | Reason |
|---|---|---|---|
| #7360 | admins | Included | Completed feature rollouts no longer appear as configurable admin switches |
| #7346 | MCP clients | Omitted | MCP event subscriptions are off by default for cloud and self-hosted deployments |
| #7340 | MCP clients | Omitted | Hosted-chat MCP event subscriptions are behind an off-by-default feature |
| #7348 | desktop users | Omitted | Local dictation improvements remain behind the off-by-default dictation feature |
| #7345 | everyone | Omitted | The calmer Workbot sidebar is behind an off-by-default feature |
| #7343 | admins | Included | TrueFoundry is now generally available in the AI Gateway provider picker |
| #7342 | desktop users | Omitted | Local macOS dictation improvements are behind the off-by-default dictation feature |
| #7335 | desktop users | Omitted | The new local dictation experience is behind an off-by-default feature |
| #7333 | desktop users | Included | Chat file actions now resolve files inside project subfolders correctly |
| #7327 | desktop users | Included | The suggested-follow-up Tab hint now appears only when the message box is focused |
| #6987 | desktop users | Included | OpenCode v2 web search cards now show returned titles and links |
| #7330 | desktop users | Omitted | Follow-up suggestion changes are behind an off-by-default feature |
| #7329 | admins | Included | The Control Center again shows plugin and marketplace creation counts |
| #7209 | desktop users | Omitted | SSH sign-in for remote desktops is off by default |
| #7328 | everyone | Included | Interactive views are consistently called Artifacts across chat, the library, and sharing |
| #7325 | everyone | Omitted | Moving Computers into Workbot's profile menu is behind an off-by-default feature |
| #7326 | everyone | Included | Auth and Security, config import/export, AI Gateway API keys, custom providers, Smart Routers, and page introductions are generally available |
| #7323 | desktop users | Included | People can hide the Get set up checklist from its menu |
| #7320 | desktop users | Included | Connect checks and remotely launched chats now use the correct conversation model and reasoning setting |
| #7319 | everyone | Omitted | Google as an alternative on the password sign-in step is off by default |
| #7318 | admins | Included | Den pages have more consistent compact lists and centered details |
| #7233 | everyone | Included | Documents can play audio and video, and the Workbot step-limit setting is removed |
| #7313 | desktop users | Included | Desktop chat Automation proposals can now target OpenWork Cloud |
| #7314 | desktop users | Included | Members and owners can set computer access choices; the My Sessions pages are removed from Den |
| #7311 | desktop users | Omitted | Suggested follow-ups are behind an off-by-default feature |
| #7312 | everyone | Included | Invitation, sandbox, and install screens use the same setup-panel design |
| #7207 | desktop users | Omitted | The single OpenWork Models row and device-level switch are behind an off-by-default feature |
| #7308 | admins | Omitted | Sample Slack for sandbox organizations is cloud-only and off by default |
| #7306 | admins | Included | SSO setup accepts a full OIDC discovery URL in the issuer field |
| #7305 | internal | Omitted | Model catalog snapshot refresh has no described user-visible effect |
| #7302 | desktop users | Included | OpenWork Models no longer appear missing in the OpenCode v2 model catalog |
| #7300 | everyone | Included | Claude models through AI Gateway and custom providers now receive prompt caching |
| #7295 | everyone | Included | Workbot tasks no longer show Failed after recovering from an action error |
| #7299 | admins | Included | A member's Workbot cloud computers are deleted when they leave or are removed from an organization |
| #7298 | desktop users | Included | Artifacts stay in the sidebar during temporary Cloud connection failures |
| #7294 | desktop users | Included | Agents can list and organize chat groups across several open workspaces |
| #7292 | admins | Included | Idle Workbot cloud computers that are woken pause again within an hour |
| #7293 | admins | Included | Team settings show change indicators on the team's page, not Everyone's |
| #7291 | everyone | Included | Workbot replaces an unresponsive cloud computer and offers Rebuild sooner |
| #7290 | desktop users | Included | The packaged desktop server starts with device-provider sharing; public session timestamps follow the documented format |
| #7286 | admins | Included | Identity confirmation can use organization SSO even when SSO is not mandatory |
| #7274 | admins | Omitted | Sharing desktop provider keys and managing shared models are behind an off-by-default feature |
| #7285 | admins | Included | Members and admins can disconnect signed-in computers, and the Computers pages are easier to scan |
| #7279 | internal | Omitted | Production import compatibility fix has no schema or runtime behavior change |
| #7275 | desktop users | Omitted | Remote-session access and the My Sessions experience are deployment-controlled; the Den pages are removed later in this release |
| #7272 | admins | Omitted | Den computer inventory is behind an off-by-default rollout |
| #7267 | desktop users | Included | Computer use settings show readiness and outstanding macOS permissions at a glance |
| #7268 | desktop users | Included | Artifacts and Automations remain in the sidebar when signed out and explain how to sign in |
| #7270 | desktop users | Included | The model name now lines up with the chat's Working status |
| #7264 | admins | Included | Workbot settings are simpler, connector access governs mail and chat, and the step-limit setting is gone |
| #7254 | everyone | Included | Workbot chat has a flatter appearance without drop shadows |
| #7253 | everyone | Included | Workbot-built apps appear as cards that open beside the chat |
| #7255 | MCP clients | Included | Claude and Gemini through AI Gateway no longer fail on union-shaped tool schemas |
| #7240 | admins | Included | New sandbox organizations make people who join super admins by default |
| #7250 | desktop users | Included | Remote tasks can answer yes/no and number questions from the chat that started them |
| #7251 | admins | Omitted | Optional quiet-check and message checks are off by default |
| #7249 | desktop users | Included | Remote tasks bring helper questions and computer-use approvals to their starting chat |
| #7244 | desktop users | Included | Idle desktop apps no longer reload Cloud data every 40 seconds |
| #7239 | desktop users | Included | Connect can sign Claude Code in through the browser and explains when it needs installing |
| #7243 | admins | Omitted | Workbot model-spend analytics are behind an off-by-default feature |
| #7238 | admins | Included | Admins can assign built-in and custom roles to people or teams from the role screens |
| #7235 | admins | Omitted | The Workbot settings screen is not released and its changes are behind an off-by-default feature |
| #7229 | admins | Omitted | The Workbot settings screen is not released and its change is behind an off-by-default feature |
| #7228 | admins | Omitted | The Workbot settings screen is not released and its changes are behind an off-by-default feature |
| #7225 | admins | Omitted | The Workbot settings screens it updates are behind an off-by-default feature |
| #7224 | admins | Included | Connector setup explains who can access a connection and shows the callback URL needed for OAuth setup |
| #7221 | admins | Omitted | Team-section explanations are behind an off-by-default feature |
| #7222 | admins | Omitted | The redesigned Workbot settings are behind an off-by-default feature |
| #7220 | admins | Included | The member API-key switch now lives in AI Gateway API Keys with a direct create-key action |
| #7216 | admins | Omitted | The redesigned Workbot settings are behind an off-by-default feature |
| #7212 | desktop users | Included | Desktop Automations run when their selected model has no variant |
| #7215 | admins | Omitted | The grouped team-settings sidebar is behind an off-by-default feature |
| #7359 | website visitors | Included | The website adds an EU sovereignty guide and setup-specific checklist |
| #7353 | website visitors | Included | The docs publish a knowledge-work cost benchmark and its methodology |
| #7289 | website visitors | Omitted | It reverts an unpublished docs addition from this same release, leaving no lasting release change |
| #7283 | website visitors | Included | The docs add a step-by-step OIDC single sign-on setup guide |
| #7284 | website visitors | Omitted | Its documentation page and links are reverted in this same release |

#### Behavior changes and removals
- Completed feature rollouts are no longer configurable switches in the admin dashboard. Nine additional Den and AI Gateway features become available to every organization, including self-hosted deployments; organizations that had not enabled Auth & Security now use the 30-day session cap and 15-minute admin identity confirmation for sensitive changes.
- Audio and video files in Workbot Documents now play in their tab. The Workbot step-limit setting and its organization/team values are removed; mail and chat access follows the allowed Google Workspace, Microsoft 365, or Slack connector instead of separate Workbot source switches.
- Computer access can be limited by both the computer owner's choice and the organization's policy. The My Sessions pages are removed from Den; session access remains a separate capability, without Den pages.
- OpenWork interactive views are consistently called Artifacts instead of Apps in chat, the Artifacts library, Workbot, Den, and sharing.
- When a member leaves or is removed from an organization, their Workbot cloud computers are deleted immediately; their chats and kept files remain.
- The member API-key switch moves from Settings › General to AI Gateway › API Keys. The Get set up checklist can now be hidden instead of remaining as a sidebar prompt until all steps are complete.

#### Lines of code changed since previous release
372254 lines changed since `v0.18.66` (346904 insertions, 25350 deletions).
