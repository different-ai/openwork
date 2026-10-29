# Release Changelog Tracker

Internal preparation file for release summaries. This is not yet published to the changelog page or docs.

## v0.18.60

#### Commit
`60c6c3fc`

#### Released at
`2026-10-22T05:26:05Z`

#### Title
Move older OpenWork installs to OpenCode v2 in the background

#### One-line summary
Older installs move to OpenCode v2 in the background with a backup first, alongside improvements to computer use, chat, documents, Workbot, and admin controls.

#### Pull requests
| PR | Audience | Decision | Reason |
|---|---|---|---|
| #6350 | everyone | Included | Older installs migrate to OpenCode v2 in the background with a backup |
| #6342 | desktop users | Included | Windows installers carry less duplicate engine data |
| #6340 | desktop users | Omitted | The model retirement switch is off until it is rolled out |
| #6336 | website visitors | Included | Enterprise and AI governance pages offer practical rollout guidance |
| #6320 | desktop users | Included | Support diagnostics preserve startup timing and stall details |
| #6330 | MCP clients | Included | Older clients retain their expected capability format when the new format is off |
| #6338 | desktop users | Included | Agents can create and move sidebar groups even without the desktop window open |
| #6337 | internal | Omitted | Developer-only session diagnostics, not everyday product behavior |
| #6318 | desktop users | Included | First launch stays responsive while bundled engine tools are prepared |
| #6332 | everyone | Included | Workbot computers can run on Freestyle and resume with the desktop open |
| #6334 | everyone | Included | People can rebuild a Workbot computer that will not connect |
| #6333 | MCP clients | Omitted | The new tool format stays off until its rollout switch is enabled |
| #6326 | MCP clients | Included | Restores OpenWork Cloud tools for older desktop versions |
| #6325 | desktop users | Included | Sign-in and setup no longer keep the CPU busy on machines without a GPU |
| #6324 | desktop users | Included | Browser pages keep a steady size as the panel changes |
| #6323 | everyone | Included | Workbot computers recover from unrelated runner updates and explain when an update is needed |
| #6316 | everyone | Included | A single-skill plugin can use the skill's name when created in Den |
| #6215 | everyone | Included | Reloading Documents no longer consumes editing sessions or loses unsaved work |
| #6216 | everyone | Included | Closing an edited document now presents clear save, discard, and cancel choices |
| #6314 | desktop users | Included | Mac computer use can script apps directly and sends smaller observations |
| #6315 | desktop users | Included | Chats no longer send a model setting that the selected model does not support |
| #6202 | everyone | Included | Workbot Documents explains why a Google file could not be opened |
| #6310 | desktop users | Included | Slow Windows browser launches and workspace startup no longer block sign-in recovery |
| #6297 | everyone | Included | Cloud computer agents can install approved packages without admin access; risky shell-capable Mac apps are blocked |
| #6251 | everyone | Included | Workbot can guide eligible people from free Auto to paid Luna without losing the conversation |
| #6308 | MCP clients | Included | Agents can start a connector removal request and admins can use the Remove action again |
| #6311 | desktop users | Included | Computer use continues while people use their Mac, and Continue resumes the task |
| #6305 | desktop users | Included | The Mac computer-use permission guide matches OpenWork in light and dark mode |
| #6307 | everyone | Included | Workbot shows computer connection progress and hides teaching notices when teaching is off |
| #6299 | admins | Included | Changing a team's role no longer intermittently fails |
| #6209 | desktop users | Included | The built-in browser fills forms with fewer steps |
| #6302 | desktop users | Included | Windows security tools can identify OpenWork's signed app files |
| #6298 | everyone | Included | People can finish or repair API-key connections from chat without sharing the key with the agent |
| #6303 | desktop users | Included | Mac computer-use setup recovers when permissions no longer match the current app |
| #6296 | desktop users | Included | Typing # in chat can link another task as context |
| #6301 | MCP clients | Included | Connected actions are easier to find with everyday search wording |
| #6293 | everyone | Included | Configured cloud computers connect through the production runner |
| #6295 | everyone | Included | Workbot can open a requested document beside chat and report the result |
| #6300 | desktop users | Included | OpenCode v2 conversation search can read larger histories without losing matches |
| #6290 | desktop users | Included | Optional Windows shortcut repair no longer blocks first launch or activation |
| #6294 | internal | Omitted | Developer-mode diagnostics layout only |
| #6292 | desktop users | Included | Sidebar shortcut hints appear after holding Cmd/Ctrl instead of flashing immediately |
| #6291 | admins | Included | Platform administrators can manage feature access for individual organization members |
| #6258 | everyone | Omitted | Browser-task teaching is unreleased and off by default |
| #6289 | admins | Included | Admins can finish adding a connector after a sign-in check fails |
| #6210 | everyone | Included | Workbot can script supported desktop apps for multi-step edits |
| #6288 | desktop users | Included | Provider settings clear an old sync error after the connection recovers |
| #6287 | internal | Omitted | Model catalog snapshot refresh with no visible product change described |
| #6233 | self-hosters | Included | GCP health checks recognize valid services with an omitted zero-percent target |
| #6277 | MCP clients | Included | Concurrent MCP connection setup no longer leaves partial connections after a failed save |
| #6276 | everyone | Included | People can dictate into OpenWork or Workbot, edit the transcript, or send while speaking |
| #6091 | desktop users | Included | Computer use works across follow-ups with clearer Stop and Take over controls |
| #6272 | desktop users | Included | OpenCode v2 app errors have compact details and Retry without a separate offline indicator |
| #6274 | everyone | Included | Cloud task recovery and per-chat Workbot storage no longer need separate administrator switches |
| #6273 | admins | Included | Workbot settings show one default model and its availability together |
| #6271 | everyone | Included | Service and connected-tool dependencies receive security fixes |
| #6263 | admins | Included | Admin URLs verify access before showing the admin navigation |
| #6261 | everyone | Included | Finished capabilities become standard; Workbot's team shortcut and selected old controls are removed |
| #6257 | desktop users | Included | Fresh desktop installs can load bundled engine tools without an npm registry connection |
| #6254 | admins | Included | Platform administrators can grant organizations Web access and additional or unlimited Free Auto usage when enabled |
| #6253 | internal | Omitted | Internal platform-administrator adoption report, not an end-user capability |

#### Behavior changes and removals
- Older installs now move from OpenCode v1 to v2 in the background, after a backup is made.
- Computer use no longer pauses just because someone switches apps or interacts with the Mac; Take over and Stop return control, and Continue resumes a finished task.
- OpenCode v2 app failures now use compact errors with Retry and expandable details; the separate offline indicator is gone.
- Closing a document with unsaved changes now opens a save/discard/cancel dialog instead of showing inline links. Reopening a file reuses its editing session and unsaved changes.
- In the built-in browser, the agent's page keeps its chosen desktop, tablet, or phone size when the panel is resized. Workbot's Browser view now opens at `/browser`, separate from the Computer view at `/computer`; its computer connection view shows progress instead of a blank screen.
- Slow Windows browser launches no longer show a false sign-in error or open duplicate tabs, and startup no longer leaves Retry hidden; optional shortcut repair no longer blocks first launch.
- Workbot's default-model picker now shows one model and its availability, rather than a selectable-but-unsaved default and a separate status row.
- Workbot's team-settings shortcut and the optional OpenCode v2 upgrade notice are gone. Selected old rollout controls were retired, while secure key fields, Slack Assistant, account connection from Workbot, and task recovery are now standard; the old Models analytics and Task analytics screens were removed.
- Typing `#` in the composer now lets you search for and insert a task link instead of typing only a plain character.

#### Lines of code changed since previous release
159234 lines changed since `v0.18.59` (137412 insertions, 21822 deletions).
