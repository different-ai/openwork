# Release Changelog Tracker

Internal preparation file for release summaries. This is not yet published to the changelog page or docs.

## v0.18.69

#### Commit
`c396ceb0`

#### Released at
`2026-11-19T15:44:13Z`

#### Title
Chat and connected work handle more situations reliably

#### One-line summary
Chat, browser and file work recover more reliably, while deployments and admin tools handle more real-world setups.

#### Pull requests
| PR | Audience | Decision | Reason |
|---|---|---|---|
| #7546 | self-hosters | Included | AWS deployment approval can open the installer directly after a blank AWS 400 error |
| #7536 | everyone | Included | Chat retries or lowers output limits when a model allows less output than requested |
| #7541 | admins | Included | AWS deployment sign-in can omit the role name and let AWS ask the person to choose |
| #7542 | everyone | Included | Agent questions can include a short paragraph of context |
| #7540 | desktop users | Included | The Files button and Files & artifacts entry now open the correct file view |
| #7539 | everyone | Omitted | New question forms are an opt-in prototype, off unless the server enables them |
| #7535 | everyone | Included | Agent questions are kept short so details remain readable in chat |
| #7538 | desktop users | Included | Computer use can read and screenshot larger Chrome pages while preserving password masking |
| #7532 | desktop users | Included | Computer use can open a person's own browser when they ask for it |
| #7533 | desktop users | Included | File links in split chat open the file instead of an empty side panel |
| #7534 | desktop users | Included | Long agent questions use the full width of the question card |
| #7537 | everyone | Omitted | Questions in the conversation are behind a flag that is off by default |
| #7531 | everyone | Included | The agent honors proxy settings for model providers on proxy-only networks |
| #7527 | desktop users | Omitted | The new sandbox execution controls and runtime are not rolled out in production |
| #7529 | admins | Omitted | Notices when an agent stops reading a source are behind an off-by-default feature |
| #7528 | admins | Omitted | Automation sharing is behind an off-by-default feature |
| #7523 | desktop users | Included | French translation coverage is complete in the desktop app |
| #7524 | admins | Omitted | Sharing a skill from its chat card is behind an off-by-default feature |
| #7525 | desktop users | Included | Automation proposals from a script show the review card again |
| #7526 | admins | Included | TrueFoundry models expose reasoning efforts, usage costs, and token-limit recovery |
| #7517 | admins | Omitted | Local sandbox-only execution is behind an off-by-default feature |
| #7522 | admins | Omitted | Editing installed deployment configuration is behind an off-by-default feature |
| #7519 | admins | Included | Enterprise installs no longer send product analytics or error reports to OpenWork |
| #7514 | everyone | Included | Workbot can open the teaching window when asked in chat |
| #7513 | everyone | Included | Teaching groups repeated steps and lets people try and edit a saved skill |
| #7488 | admins | Omitted | LiteLLM Microsoft sign-in is disabled until explicitly rolled out |
| #7509 | MCP clients | Omitted | AI Gateway OpenCode setup is disabled until explicitly rolled out |
| #7508 | admins | Included | Runner fleet cells show their organization, conversation kind, and time in memory |
| #7507 | admins | Included | Admins can filter cloud computers and inspect why one is in its state |
| #7499 | desktop users | Included | Chat and the Agents list agree on running agents, and Stop all stops them all |
| #7496 | desktop users | Included | One-time Automations accept date strings proposed from chat |
| #7504 | desktop users | Omitted | Side chat browser pages require the off-by-default side chat feature |

#### Behavior changes and removals
- AWS deployment sign-in no longer requires a role name; AWS can ask the person to choose one, and approval offers a direct installer route when the portal produces a blank 400 page.
- Agents can use a person's own browser when asked instead of treating external browser control as unsupported, while longer question details move into chat and questions can use a short paragraph.
- The Files button and **Files & artifacts** now open the file view, file links in split chat open the linked file, and the chat's running-agent count now matches the Agents list.

#### Lines of code changed since previous release
135310 lines changed since `v0.18.68` (134044 insertions, 1266 deletions).
