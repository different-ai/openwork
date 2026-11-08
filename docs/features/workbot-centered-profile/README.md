# Workbot: centred avatar and profile

Feature: `workbotCenteredProfile` · Cloud and self-hosted · Default **off** · Author: @benjaminshafii.

The centered **header** avatar/status pill is now default wherever Browser access is enabled, independently of this flag. This flag still controls the richer profile-sheet layout and tabs; it does not enable the browser experience. See [the unified browser experience](../workbot-browser-preview/README.md).

The richer profile sheet requires `workbotWorkingStatus` and `workbotProfileSheet`. With these on, Workbot's OpenWork-logo avatar sits at the top centre of the chat, with its name in a pill and its current activity inside that pill. Tapping opens the profile: a large logo, name and Connected, then five accessible icon tabs: Tasks, Permissions, Computer, Schedules, Identity. Computer opens only on request. Schedules reads the same owner-scoped Automations as Calendar; Identity reads the existing memory API. Empty/error states say what happened and offer retry, not endless skeletons. The logo and name are not editable in this release; no decorative pencil pretending to work.

On phones the header keeps navigation/search on the left and Files/account on the right; Files becomes an accessible icon so the avatar stays truly centred. Side-chat titles remain visible beneath it. Tabs support arrow keys, Home/End, focus and panel relationships.

## Mobile verification

Real WorkbotScreen, 390 × 844, in-memory conversation (not a production session). External PR evidence, retained for 72 hours:

![Five-tab profile on a phone](https://litter.catbox.moe/0uup7m.png)

## Try it

Enable the three flags for a test organization in `/admin` → organization → Features (or use the existing `den_set_org_capability` admin capability). Reload Workbot. For local UI verification run the existing chat-screen fixture with `?scenario=browsing&working=1&profile=1&centered=1&browser=1`. Evidence screenshots and the browser verification report are linked from the PR, not committed to the repository. The fixture renders the real screen; it does not prove a production browser is working.

Turning this flag off restores the original three-tab profile, and the left-aligned header only where Browser access is unavailable. Turning `workbotProfileSheet` off restores the task sheet. No saved user data or work is changed.

## Lifecycle bug fixes (not gated)

Known cancelled/stopped/abandoned turns cannot project as working. Unknown lifecycle states are not evidence of a live task. Newer foreground replies take precedence, and multiple tasks sort newest first. An unfinished job with no step for 20 minutes no longer holds the header: it remains inspectable as “No progress since …”, without pretending the system knows it finished. This is a presentation freshness guard, not cancellation. A fresh step makes it active again.
