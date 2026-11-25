# Release Changelog Tracker

Internal preparation file for release summaries. This is not yet published to the changelog page or docs.

## v0.18.65

#### Commit
`abb0def5`

#### Released at
`2026-11-05T07:43:34Z`

#### Title
Mac computer use can work across apps and hand files back

#### One-line summary
On a Mac, agents can work across apps more reliably, move files between them, and return their finished files in chat.

#### Pull requests
| PR | Audience | Decision | Reason |
|---|---|---|---|
| #7055 | everyone | Included | Removes blank panels left behind as tool details fold or settle |
| #7054 | desktop users | Included | Cloud connections work without a legacy engine on OpenCode v2 |
| #7053 | desktop users | Included | Run diagnostics opens usable Agent access controls outside developer mode |
| #6989 | desktop users | Included | Windows agent shells can use Microsoft OpenSSH again |
| #7049 | MCP clients | Omitted | Its App-envelope integration was reverted and requires unavailable upstream support |
| #7028 | everyone | Included | Agent-created conversations with a chosen model now start correctly |
| #7041 | desktop users | Included | Mac agents can send real input and app shortcuts to a wider range of apps |
| #7040 | desktop users | Included | Mac agents can use real input in apps such as Blender that draw their own interfaces |
| #7044 | desktop users | Included | The live computer view is smaller, with controls shown on hover |
| #7043 | desktop users | Included | Mac agents can edit values and canvas text and identify unverified results |
| #7038 | desktop users | Included | Mac computer use can reopen apps macOS quit after their last window closed |
| #7037 | desktop users | Included | Mac computer use follows an app when it replaces the working window |
| #7036 | desktop users | Included | Mac computer use handles collapsed Save sheets and delayed Open or Place panels |
| #7035 | desktop users | Included | Mac agents can type on design-app canvases without reported keyboard focus |
| #7034 | desktop users | Included | Mac computer use waits for animated windows to settle and ignores a blinking caret |
| #7033 | desktop users | Included | Mac computer-use batches continue through linked-field and layout changes |
| #6964 | admins | Omitted | Feature introductions and the combined settings page are behind disabled flags |
| #7018 | desktop users | Included | OpenCode v2 agents can manage existing conversations without opening them |
| #7031 | everyone | Included | Automation runs now show when a connection needs attention instead of reporting success |
| #7021 | desktop users | Omitted | App-agent crew display depends on the disabled Parallel computer use feature |
| #7020 | desktop users | Omitted | Shared staging for app-agent windows depends on disabled Parallel computer use |
| #7015 | desktop users | Omitted | Splitting computer work across agents depends on disabled Parallel computer use |
| #7014 | desktop users | Omitted | Subagent follow-along depends on disabled Parallel computer use |
| #7013 | desktop users | Omitted | Per-agent cursor names and colors depend on disabled Parallel computer use |
| #7012 | desktop users | Omitted | Shared computer access for subagents depends on disabled Parallel computer use |
| #7030 | desktop users | Included | Mac agents can set focus and check results during a batch |
| #7029 | desktop users | Included | Mac agents can edit values in design apps using real key presses |
| #7024 | desktop users | Included | Mac computer use can bring forward apps that ignore normal activation |
| #7023 | desktop users | Included | Mac agents can send app shortcuts without a focused text field |
| #7022 | desktop users | Included | Mac computer-use batches continue after clicks when the next step is still valid |
| #7017 | admins | Omitted | Per-organization SSO requirements and expiry are behind a disabled flag |
| #6998 | desktop users | Included | Removes the developer-only Reset notifications button from the session header |
| #7000 | admins | Omitted | Moving SSO requirement settings is behind a disabled flag |
| #6999 | admins | Included | Owners can assign a Super admin role with nearly full organization control |
| #6996 | everyone | Included | Password sign-in for other workspaces no longer loops back to SSO |
| #7004 | desktop users | Included | The Mac computer card returns files made by scripts and app exports as well as saved files |
| #7006 | desktop users | Included | Mac agents can save a window image as a file for use in another app |
| #7007 | desktop users | Included | Mac agents can choose a file in an Open, Place, or Attach panel in one step |
| #6994 | desktop users | Included | Mac agents can save or export files and open them from the computer session card |
| #6993 | desktop users | Included | Mac agents can copy between apps and open apps directly onto files |
| #6997 | admins | Included | Admins can allow, require approval for, or block file moves and copy/paste between apps |
| #7002 | desktop users | Included | Mac computer use can work beside OpenWork while watched and in the background otherwise |
| #6992 | desktop users | Included | Mac agents can keep several apps open and arrange their windows side by side |
| #7001 | desktop users | Included | Mac computer use pauses for a person's input and resumes without losing their place |
| #6963 | desktop users | Included | A crashed built-in browser page no longer closes the desktop app |
| #6991 | everyone | Included | Tool searches in Code Mode scripts no longer fail with an unknown-tool error |
| #6983 | desktop users | Included | Organization models appear in the picker before the first workspace is created |
| #6986 | admins | Included | Newly created sandbox organizations get the updated included model choices |
| #6985 | desktop users | Included | Browser activity returns to simple chat steps instead of the computer session card |
| #6984 | everyone | Included | Asking for an artifact now creates a reusable App instead of a local HTML page |
| #6982 | everyone | Included | Approved Drive uploads support remembered consent and healthy long transfers |
| #6980 | admins | Omitted | Organization-scoped SSO behavior is behind a disabled flag |
| #6979 | desktop users | Included | OpenCode v2 now handles history migration at startup instead of OpenWork's custom copy process |
| #6968 | admins | Omitted | Workbot access to any connected connector is behind a disabled flag |
| #6967 | internal | Omitted | API schema shape change fixes contract linting without a described user-facing effect |
| #6966 | admins | Omitted | Workbot's new agent brief and check rhythm are behind a disabled flag |
| #6909 | desktop users | Included | Provider connection setup now explains why sign-in methods could not load |
| #6962 | everyone | Included | Opening Workbot from a workspace now opens that workspace's Workbot |
| #6961 | everyone | Omitted | Workbot sign-out and workspace switching are behind a disabled flag |
| #6960 | desktop users | Included | Mac agents no longer ask again before canvas typing or scripts unless organization policy requires it |
| #6954 | desktop users | Included | Mac computer use handles focus, canvas text, dialogs, and chat position more smoothly |
| #6953 | desktop users | Included | Chat file links can resolve files from their surrounding message and session context |
| #6955 | everyone | Included | Workflows can be named, found in My Library, and show failures in plain language |
| #6956 | everyone | Omitted | The model-picker changes are behind a disabled flag |
| #6952 | desktop users | Omitted | The live-reply layout change is behind a disabled flag |
| #6917 | everyone | Included | Workbot teaching has a first-run guide and a window that stays clear of chat |
| #6947 | desktop users | Included | Mac agents can use hidden menus, tool keys, and approved canvas typing |
| #6944 | everyone | Included | With standard JavaScript Workflows enabled, agents are guided to await each call |
| #6948 | desktop users | Included | Mac agents can hand an approved file to the app they are using |
| #6945 | desktop users | Included | Mac computer use can click in Finder and submit fields after bringing a window forward |
| #6938 | desktop users | Included | Mac agents can save with shortcuts, verify changed values, and draw multiple strokes |
| #6941 | desktop users | Included | The computer session card and cursor make agent activity easier to follow |
| #6934 | everyone | Included | Apps built from now on can read from several sources at the same time |
| #6920 | admins | Omitted | The App repair action is behind a disabled flag |
| #6919 | everyone | Included | Apps and Workflows with async helpers can run reads concurrently |
| #6915 | everyone | Included | Opening an App no longer repeats a slow live-data read unnecessarily |
| #6932 | desktop users | Included | Computer-use cursors, drawn strokes, and replay marks are clearer |
| #6931 | desktop users | Included | With computer session history on, the live computer view opens when requested from its card |
| #6929 | desktop users | Included | Mac computer use no longer stops for unrelated window changes or moved focus |
| #6930 | desktop users | Included | The Mac agent cursor moves and highlights controls more naturally |
| #6928 | desktop users | Included | The Mac computer-use helper has its own recognizable System Settings icon |
| #6927 | desktop users | Included | Mac computer use returns a fresh view after refusing an outdated action |
| #6922 | desktop users | Included | Agents can draw longer strokes and outlines without the action being refused |
| #6925 | desktop users | Included | Large-app computer-use steps send less control-listing detail in chat |
| #6924 | desktop users | Omitted | Letting agents ask questions while continuing work is behind a disabled flag |
| #6923 | desktop users | Included | Mac agents can wait while a person answers a macOS prompt and then continue |
| #6921 | desktop users | Included | Mac computer use can finish background drags and drawing strokes |
| #6850 | admins | Included | The admin Control Center now shows skill and connector sharing numbers |
| #6916 | everyone | Included | Reopened Apps show saved data immediately and then refresh it |
| #6914 | admins | Included | Claude on Google Vertex no longer fails in Gateway tests and chats |
| #6873 | everyone | Included | Stored App data clears when a member loses access to a connection or plugin |
| #6900 | desktop users | Included | Pinned conversations survive desktop crashes and sidebar-storage errors |
| #6912 | everyone | Included | Workflow Apps, artifact controls, and failure explanations work more clearly |

#### Behavior changes and removals
- Mac computer use no longer asks again before canvas typing or app scripts once enabled in a chat; an organization's rule can still require approval before each script. File moves and copy/paste between apps can proceed without a prompt by default, with admin controls to ask first or block them.
- Browser steps now appear as simple “Used browser” chat steps instead of being grouped into the computer session card.
- The developer-only “Reset notifications” button has been removed from the session header.
- OpenCode v2 now handles history migration in place at startup. OpenWork's custom history-copy worker, lock, disk-space preflight, migration progress UI, and related controls are removed.
- Stored App data is cleared when a member loses access to a connection or plugin, and remains hidden until access has been checked.

#### Lines of code changed since previous release
169528 lines changed since `v0.18.64` (159925 insertions, 9603 deletions).
