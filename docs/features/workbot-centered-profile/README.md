# Workbot: centred avatar and profile

Feature: `workbotCenteredProfile` · Cloud and self-hosted · Default **off** · Author: @benjaminshafii.

The centered **header** avatar/status pill and responsive chat navigation are now the default for everyone, independently of this flag and Browser access. This flag still controls the richer profile-sheet layout and tabs; it does not enable the browser experience. See [the unified browser experience](../workbot-browser-preview/README.md).

The richer profile-sheet mode requires `workbotWorkingStatus` and `workbotProfileSheet`. It adds a larger logo and Schedules to the Tasks, Apps and Identity tabs. Computer is no longer a profile tab: browser work opens only from its inline card. Schedules reads the same owner-scoped Automations as Calendar; Identity reads the existing gated memory API. Empty/error states say what happened and offer retry, not endless skeletons. The logo and name are not editable in this release; no decorative pencil pretending to work.

The header keeps the avatar centred on desktop and phone. Files/account live in the shared navigation, not competing header controls; side-chat titles remain beneath the avatar. The profile tabs support arrow keys, Home/End, focus and panel relationships.

## Mobile verification

Real WorkbotScreen, 390 × 844, in-memory conversation (not a production session). External PR evidence, retained for 72 hours:

![Five-tab profile on a phone](https://litter.catbox.moe/0uup7m.png)

## Try it

Enable the three flags for a test organization in `/admin` → organization → Features (or use the existing `den_set_org_capability` admin capability). Reload Workbot. For local UI verification run the existing chat-screen fixture with `?scenario=browsing&working=1&profile=1&centered=1&browser=1`. Evidence screenshots and the browser verification report are linked from the PR, not committed to the repository. The fixture renders the real screen; it does not prove a production browser is working.

Turning this flag off restores the compact three-tab profile, without changing the centred header or chat navigation. Turning `workbotProfileSheet` off leaves Tasks and Apps available; Identity explains that memory browsing is unavailable instead of requesting a blocked endpoint. No saved user data or work is changed.

## Lifecycle bug fixes (not gated)

Known cancelled/stopped/abandoned turns cannot project as working. Unknown lifecycle states are not evidence of a live task. Newer foreground replies take precedence, and multiple tasks sort newest first. An unfinished job with no step for 20 minutes no longer holds the header: it remains inspectable as “No progress since …”, without pretending the system knows it finished. This is a presentation freshness guard, not cancellation. A fresh step makes it active again.
