# Release Changelog Tracker

Internal preparation file for release summaries. This is not yet published to the changelog page or docs.

## v0.18.54

Covers everything since `v0.18.52`. The `v0.18.53` release was never published (its Windows builds failed and it stayed a draft), so nobody received it and its changes had no notes. They are documented here instead.

#### Commit
`46f36803`

#### Released at
`2026-09-25T23:28:01Z`

#### Title
Enterprise sign-in and version pinning are back, plus Amazon Bedrock and model shortcuts

#### One-line summary
Enterprise and cloud desktops require organization sign-in again and honour allowed desktop versions, admins can add Amazon Bedrock to AI Gateway, you can bind keys to your favourite models, and chat and connector setup are more dependable.

#### Pull requests
| PR | Audience | Decision | Reason |
|---|---|---|---|
| #5366 | desktop users | Included | Windows desktop installers publish again |
| #5353 | desktop users | Included | Editing a message while a reply runs replaces it instead of queueing |
| #5363 | internal | Omitted | Pull request evidence report layout |
| #5359 | desktop users | Included | OpenCode v2 chat no longer fails when a skill is installed in two folders |
| #5360 | internal | Omitted | CI evidence selection |
| #5362 | admins | Included | Enterprise and cloud desktops require sign-in again; allowed desktop versions enforced again |
| #5358 | internal | Omitted | Pull request evidence checkpoints |
| #5356 | internal | Omitted | Local test isolation |
| #5354 | internal | Omitted | Reviewer preview storage cleanup |
| #5350 | admins | Included | Amazon Bedrock and Bedrock (OpenAI) in AI Gateway |
| #5349 | internal | Omitted | Pull request template |
| #5339 | internal | Omitted | Pull request evidence screenshots |
| #5347 | desktop users | Included | OpenCode v2 question answers are isolated from other conversations |
| #5346 | internal | Omitted | Test ordering fix |
| #5345 | desktop users | Included | Updating no longer fails with a checksum mismatch after a release is re-run |
| #5344 | internal | Omitted | Reviewer preview progress output |
| #5343 | desktop users | Included | Model shortcuts show a subtle Fast label instead of a notice |
| #5336 | desktop users | Included | Keyboard shortcuts for saved models and a Fast toggle |
| #5341 | internal | Omitted | Reviewer preview hosting |
| #5340 | desktop users | Included | Questions and approvals stay when an OpenCode v2 task changes folder |
| #5338 | internal | Omitted | Reviewer previews of published Windows releases |
| #5334 | MCP clients | Included | One-click Cursor and VS Code install links in the MCP docs |
| #5337 | internal | Omitted | Reviewer preview browsers and sign-in links |
| #5335 | desktop users | Included | Code-mode activity summarized by outcome |
| #5333 | desktop users | Included | Conversations stay in their folder when an agent changes directory |
| #5317 | admins | Included | Clearer Plugins filters; more connector setup options |
| #5331 | admins | Included | Anthropic effort choice preserved through AI Gateway |
| #5319 | desktop users | Included | Switch OpenCode engines from the command palette and optionally migrate history |
| #5293 | MCP clients | Included | MCP clients can connect with a Client ID Metadata Document |
| #5326 | MCP clients | Included | Failed app sign-ins to OpenWork Connect explain what went wrong |
| #5324 | internal | Omitted | Hosted billing record fix with no visible change |
| #5330 | website visitors | Included | SOC 2 Type II status shown on the website |
| #5318 | internal | Omitted | Pull request evidence viewer |
| #5188 | desktop users | Included | Compact update controls with clearer version details |
| #5315 | admins | Included | API-key, custom OAuth, Google Workspace and Microsoft 365 connectors in the new setup flow |
| #5257 | desktop users | Included | OpenCode v2 preview keeps tasks through provider and skill updates, folded into the engine bullet |
| #5313 | self-hosters | Omitted | npm package change; the npm package was not republished for this release |
| #5286 | desktop users | Included | A second OpenWork profile no longer stops the first one's engine |
| #5308 | internal | Omitted | Previous release notes |
| #5312 | internal | Omitted | Reviewer preview reliability |
| #5310 | internal | Omitted | npm packaging; the npm package was not republished for this release |
| #5309 | internal | Omitted | Release verification step |

#### Behavior changes and removals
- OpenWork Enterprise and OpenWork Cloud desktops hold people at sign-in until they sign in to their organization again. Releases v0.18.49 through v0.18.52 let them work without signing in.
- Allowed desktop versions set in organization settings apply to desktop updates again: a version removed from the list is not installed. Other desktop policies remain unenforced on the desktop while they are redesigned.
- Editing a message while a reply is running replaces the running message instead of queueing the edit.
- Settings › Updates no longer shows inline release notes.
- Model shortcuts no longer open a notice above the composer; Fast shows as a label next to the model name.

#### Lines of code changed since previous release
29196 lines changed since `v0.18.52` (19717 insertions, 9479 deletions).
