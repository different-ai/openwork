# Workbot: one browser experience

Browser tasks use this experience by default wherever Browser access is enabled. The presentation no longer depends on `workbotBrowserPreview`, `workbotWorkingStatus`, `workbotCenteredProfile` or `workbotQuickReply`. Browser access itself (`remoteComputers` / `browserUse`) and all viewer-ticket authorization remain unchanged.

## What people see

One Browser card appears when the task's first browser action is known and stays above its acknowledgment and follow-up replies, matching the reference layout. It updates in place from **Working** to **Completed**, or **Failed** with a plain reason. The title comes from the person's request. The card keeps its place in the stored transcript after reload; it is not reconstructed from a live connection. Browser work does not also produce a Computer card, background-computer card or Open Computer row.

The card has the live picture while working, its own last picture afterward, and one **Open preview** button. Opening is always the person's choice: neither tool `show` events nor completion open a panel. On wide screens the existing `WorkbotComputer` viewer sits beside the conversation; on phones the same component opens in a full-screen dark dialog. There is no second browser implementation.

The header contains Share, task title/status/hostname, Close, and on desktop one expand/collapse action. The status dot replaces Live. Stop task and Take control move to the footer; Hand back replaces both while the person controls the browser. Stop stops the conversation, not just its stream. Teaching remains behind its existing permission/flag and is reachable in browser chrome after Take control, not in the primary task toolbar. Browser tabs, navigation and URL input keep the existing stream implementation.

Initial connection keeps the last picture or the browser's layout skeleton. Connection failures keep actionable recovery rather than a grey Connecting screen. A historic task card's snapshot is never replaced by another task's picture. Opening an old card shows the current browser, not a replay of history.

## Pictures and privacy

Pictures are actual viewer canvas pixels, never generated placeholders. They are scoped by organization/member/chat/view/task and saved in the tab's `sessionStorage`, not localStorage or a server. They survive reload in that tab, but not closing the tab. At most four small JPEGs are retained; task pictures expire after 24 hours and live-view fallbacks after five minutes. Evicted/expired pictures disappear without removing their transcript card. A disabled/full store falls back to bounded page memory. Browser authorization still gates thumbnail display and full-view access.

## Flag scope

All four definitions remain because other code still uses them:

- `workbotBrowserPreview`: still controls the native-computer inline preview; Browser cards and task pictures are unconditional.
- `workbotWorkingStatus`: still controls quiet app/background/native-computer presentation and its broader assistant instructions. Browser turns use the one-card presentation and header status independently.
- `workbotCenteredProfile`: still controls the richer profile-sheet layout/tabs. The centered header avatar/pill is default with Browser access, without enabling the profile sheet.
- `workbotQuickReply`: still controls non-browser acceptance fallback and general first-response instructions. Browser tasks independently require a short acknowledgment before tools and a verified follow-up.

`workbotProfileSheet`, `workbotRemoteTasks`, `workbotScrollToBottom`, document and teaching rollouts remain unchanged. An ordinary task sheet opens from the avatar when the profile-sheet flag is off.

## Verification and delivery

Unit tests cover server/browser classification, failure projection, stable card placement, interrupted tasks and task-scoped reload persistence. The browser UI proof exercises the real React screen against the explicit in-memory fixture, with recorded page pixels, at iPhone and desktop sizes. This proves UI and API wiring, not production external-site reliability.

Deploy the Workbot chat web/server service to deliver these changes. Existing browser/computer worker streams and takeover/continue APIs are reused; this change requires no new worker protocol or worker image.
