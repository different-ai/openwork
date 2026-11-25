# Release Changelog Tracker

Internal preparation file for release summaries. This is not yet published to the changelog page or docs.

## v0.18.72

#### Commit
`5febd7c1`

#### Released at
`2026-11-23T04:07:36Z`

#### Title
Bring your team's skills into OpenWork with their files

#### One-line summary
Teams can import skills with their files, use them in OpenWork, and rely on clearer chat, browser, and organization workflows.

#### Pull requests
| PR | Audience | Decision | Reason |
|---|---|---|---|
| #7659 | admins | Included | GitHub sources require workspace approval before connection or sync |
| #7658 | admins | Included | Invited password signups use the regular email-verification flow |
| #7651 | desktop users | Included | Run executes a suggested command in chat and continues from its output |
| #7649 | desktop users | Included | Gateway models stay visible with a way to renew a lapsed sign-in |
| #7650 | admins | Included | Configured member sign-in providers show Ready without the admin signing in |
| #7647 | everyone | Included | Remote sessions keep their chosen model on follow-up messages |
| #6681 | everyone | Included | Workbot offers every team app that is set up, not just four named apps |
| #6682 | admins | Included | New workspace owners can add team tools before Workbot opens |
| #7641 | desktop users | Included | Agent questions are better placed and ask about visible, decision-relevant details |
| #7640 | everyone | Included | Computer-based skills can use their expected Node libraries without installing them first |
| #7639 | desktop users | Included | Find text works on every Settings page without an admin enabling it |
| #7638 | everyone | Included | Computer-based skills can use their expected Python libraries without installing them first |
| #7637 | admins | Included | Teams can import selected custom skills from Claude with their files |
| #7631 | desktop users | Included | Automation review cards remain visible when chat activity folds |
| #7543 | desktop users | Included | Split-chat app previews open in the visible side panel |
| #7636 | admins | Included | GitHub skill folders can be imported without a plugin manifest, with explicit selection |
| #7635 | everyone | Included | Organization skills' scripts and reference files are available to the agent in a read-only folder |
| #7632 | admins | Included | Skills can be uploaded to and downloaded from OpenWork as ZIP archives |
| #7634 | admins | Included | GitHub-imported plugins remain private until deliberately shared or published |
| #7633 | admins | Included | GitHub plugin imports find skills alongside declared agent files and report empty imports |
| #7604 | admins | Included | Cloud skills can hold binary files and larger supporting files |
| #7626 | admins | Included | Expired one-time Automation schedules are rejected with a clear correction |
| #7628 | internal | Omitted | Operator-only demo launcher; no shipped app behavior |
| #7625 | admins | Omitted | Archived Automation restore UI is behind an off-by-default feature |
| #7623 | desktop users | Omitted | Office text-outline preview is behind an off-by-default feature |
| #7608 | everyone | Included | Workbot sees an app connected during a turn on its next step |
| #7613 | admins | Included | New organizations no longer get three unused plugins pre-added to the Library |
| #7574 | admins | Included | AI Gateway provider edits retain credentials and access and save supported model selections |
| #7611 | desktop users | Included | OpenWork Connect retries a temporary sign-in transition instead of showing a false failure |
| #7609 | admins | Included | Provider readiness reflects a team's working shared key, not the viewing admin's access |
| #7610 | everyone | Included | Parallel calls no longer break native connections during token refresh |
| #7600 | admins | Included | GitHub marketplace imports keep each plugin's own skills and report omitted files |
| #7599 | internal | Omitted | Repairs development workflows without changing product behavior |
| #7598 | admins | Included | Cloud skills can include larger sets of reference files, scripts, and templates |
| #7303 | internal | Omitted | Database dependency update has no described user-visible effect |
| #7595 | everyone | Included | Skills created by an agent can include supporting files |
| #7591 | desktop users | Included | Suggested Automation review cards stay visible after the agent finishes |
| #7592 | desktop users | Included | Answers to agent questions remain visible in chat after the turn |
| #7593 | MCP clients | Included | More clients receive instructions for opening Cloud skill supporting files |
| #7589 | everyone | Included | Chat identifies an AI Gateway usage limit instead of a provider rate limit |
| #7587 | desktop users | Included | Question cards prevent duplicate answers and allow people to go back |
| #7585 | internal | Omitted | Repository file organization change only |
| #7584 | everyone | Included | SSO requirements apply to sign-in without blocking agents, Workbot, or Automations |
| #7583 | desktop users | Included | Sending a message no longer makes chat flicker |
| #7581 | everyone | Included | Config export clarifies private-skill exclusions; private transfers are available when enabled |
| #6988 | everyone | Included | Browser click, fill, key, and scroll actions work with string-form action payloads |
| #6819 | everyone | Included | Spreadsheet elapsed-time values are read as durations, not dates |
| #6043 | admins | Included | Den registration can recover from a transient password-screening failure |
| #5138 | admins | Included | Required SSO blocks email OTP sign-in and avoids duplicate SSO start requests |
| #7578 | desktop users | Included | Low-disk warnings stop repeating until disk space is cleaned up |
| #7576 | everyone | Included | Organization skills are not replaced by same-name local skill folders |
| #7575 | admins | Included | Admin access denials explain the reason and identify the signed-in account |
| #7569 | desktop users | Included | Browser pages use a normal size by default; size choices apply to one tab |
| #7573 | desktop users | Omitted | Expand-table feature is behind an off-by-default feature |
| #7568 | desktop users | Omitted | Suggested-command Run button is behind an off-by-default feature in this PR |
| #7565 | desktop users | Included | Links opened in the built-in browser widen a narrow panel to a readable width |
| #7563 | desktop users | Omitted | Temporary browser secret handles are opt-in and off by default |
| #7567 | desktop users | Included | Side chats can start from selected text across multiple agent replies |
| #7564 | desktop users | Omitted | Multi-selecting sidebar sessions is behind an off-by-default feature |
| #7566 | internal | Omitted | Model data snapshot refresh has no described visible effect |
| #7561 | desktop users | Included | Sign-in now completes in the OpenWork iPhone app |
| #7562 | desktop users | Included | Chat question rows show the answer a person gave |
| #7559 | MCP clients | Included | Agents can list and read supporting files that come with Cloud skills |

#### Behavior changes and removals
- GitHub sources now require workspace approval before they connect or sync. Imported GitHub plugins stay private unless shared or published, and organization skills take precedence over same-name local folders. New organizations no longer start with unused OpenWork Browser, OpenAI Image Gen, and Ollama plugin entries in their Library.
- Skills can now be brought in from Claude, GitHub skill folders, or ZIP archives, and downloaded as ZIP files. Cloud skills support larger collections of text and binary supporting files; agents can list and read those files, save them when creating skills, and use verified skill folders and preinstalled Python and Node libraries when running skill scripts. GitHub imports now identify skills alongside agent declarations and disclose files that were skipped.
- Running a suggested command now executes it directly in the conversation and continues with its output. Agent questions appear beside the conversation, avoid asking about hidden or agent-only details, and stay understandable: answers and Automation review cards remain visible after a turn, duplicate question answers are prevented, and people can go back to an earlier question. Sending a message no longer causes a chat flicker; side-chat selection can span replies, and split-chat app previews open in the visible panel.
- Settings search is available on every Settings page. The built-in browser displays normal page sizes by default, lets a chosen size apply to one tab, and opens clicked links at a readable width. Low-disk warnings no longer repeat continuously, and elapsed-time spreadsheet cells are read as durations.
- AI Gateway models requiring a member's own sign-in remain available in the picker with a sign-in prompt. Admin provider status and edits now reflect configured credentials and supported models, and chat distinguishes Gateway usage limits from ordinary provider rate limits. Provider connections also survive parallel token refreshes.
- Workbot offers every app configured for a team, accepts team-tool setup from new workspace owners, and notices apps connected during an ongoing turn. Remote sessions keep the selected model on follow-up; required SSO no longer blocks agents, Workbot, or Automations. Invited password signups follow regular email verification, and required SSO blocks email OTP sign-in.
- One-time Automation schedules in the past are rejected with guidance to choose a future time. Den registration retries transient password-screening failures, and admin access denials now explain why access was refused.

#### Lines of code changed since previous release
105660 lines changed since `v0.18.71` (51248 insertions, 54412 deletions).
