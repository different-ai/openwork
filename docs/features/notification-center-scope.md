# Notification center scope: what belongs in the bell, what stays a toast

Report on the question "the Notifications panel says *No notifications yet*
while workspace events such as the archived-session toast never appear there —
is that intentional?"

## Verdict

**Intentional delivery scope, misleading empty-state copy.** The archived-session
toast is a *user-action confirmation*, and the notification center was designed
to exclude that class. The only defect is the empty-state hint, which promised
"updates from … your workspaces" without saying that confirmations of your own
actions are deliberately kept out. This change fixes the copy and adds an E2E
spec that pins the contract. No delivery behavior changed.

## Documented intent (not inferred)

- PR [#2215](https://github.com/different-ai/openwork/pull/2215) "notification
  center + auto-reload engine when idle" (merged 2026-06-13) introduced three
  delivery classes:

  | Class | Behavior | Examples named in the PR |
  | --- | --- | --- |
  | Feedback | toast only | skill installed, validation warnings, action errors |
  | Event | center entry + badge, never a popup | provider sync, reload receipts, pending updates |
  | Alert | center entry + one toast; bursts collapse into one summary toast | reload failure, updater / auto-reconnect errors |

- The entry-point module `apps/app/src/react-app/shell/notifications.ts`
  restates it in its header: "Direct feedback for user actions (e.g. 'skill
  installed') should keep using `toast` … and stay out of the center."
- PR [#4818](https://github.com/different-ai/openwork/pull/4818) (the archive
  toast identity fix, merged 2026-09-10) explicitly considered a "durable
  activity log / bulk summary" for archive actions and recorded it as "useful
  future scope, not needed here".
- No product doc in `docs/` or the bundled OpenWork documentation describes the
  in-app bell; the only prose is the Desktop Notifications settings copy, which
  calls native OS notifications "separate from the in-app notification bell".
- No GitHub issue asks for user-action confirmations in the center.

## Observed implementation (origin/dev 2fcbae60e)

- Store: `react-app/kernel/notification-store.ts`, Zustand + `localStorage`
  key `openwork:notifications:v1`, 100 entries / 30 days, unread entries with
  the same `dedupeKey` coalesce, actions are serializable descriptors
  (`open-model-picker`, `reload-engine`, `open-extensions-marketplace`,
  `install-marketplace-plugin`) so they remain valid after a restart.
- Scope: one store per app profile, shared across workspaces and accounts; no
  per-entry dismiss, closing the panel marks everything read, "Clear all"
  drops everything.
- Producers of center entries today: provider sync (`new-providers-listener`),
  engine reload receipts / pending updates / reload failure
  (`reload-coordinator`), marketplace plugin added / updated / removed
  (`extensions-store`), background failure sinks in `settings-route`
  (updater check, workspace refresh, server reconnect), and session title
  generation failure (`session-sync`).
- Archive / unarchive (`domains/session/sidebar/use-session-archive.tsx`) uses
  `toast.undo(...)` with closure-based Undo and View actions and never calls
  `notifyEvent` / `notifyAlert`. Task completion, failure, permission and
  question prompts go to native OS notifications only
  (`shell/desktop-notifications.ts`) when the window is not in view; they are
  not written to the center either.
- The user's report is therefore consistent with the code: the center is
  empty until a background event happens, and archiving never writes to it.

## Comparators (primary sources)

| Product | Ephemeral confirmation | Durable in-app inbox | Own-action confirmations in the inbox? |
| --- | --- | --- | --- |
| VS Code | Toast (auto-hides; 3 at a time, spam-protected) | Notification center keeps every notification until closed; `SILENT` priority = center only, Do Not Disturb hides non-error toasts but the center still shows them ([docs](https://code.visualstudio.com/docs/editing/getting-started/userinterface), [notification.ts](https://github.com/microsoft/vscode/blob/99489178/src/vs/platform/notification/common/notification.ts), [PR #149645](https://github.com/microsoft/vscode/pull/149645)) | Only if the producer used the notification API; ordinary editor actions do not notify. |
| Cursor | In-app completion sound; OS banner when the app is in the background for "done" and "needs attention" ([forum answer by Cursor staff](https://forum.cursor.com/t/agent-eta-completion-notification-sound/168130)) | No documented in-app inbox | Not documented. |
| Linear | Real-time desktop / mobile / Slack alerts | Inbox "for work that needs attention", subscription-driven, snooze / read / archive, 2,000-entry cap ([Inbox](https://linear.app/docs/inbox), [Notifications](https://linear.app/docs/notifications)) | Inbox is fed by key events on *subscribed* issues, not by a log of your own clicks. |
| Slack | Badge + push | Activity view: DMs, mentions, threads, reactions, invitations, apps, reminders; clear vs. mark read are distinct, cleared items remain in a "Cleared" filter ([Activity](https://slack.com/help/articles/19693583638803-Get-your-work-done-from-the-Activity-view), [new Activity](https://slack.com/help/articles/46751260742035-Introducing-the-new-Activity-view-in-Slack)) | No; Activity is other people's activity directed at you. |
| Notion | Desktop push 10 s after an @-mention; suppressed while viewing the page | Sidebar Inbox: mentions, replies, person-property assignment, reminders, invitations; read / unread / archive ([Inbox & notifications](https://www.notion.com/help/updates-and-notifications), [Notification settings](https://www.notion.com/help/notification-settings)) | No; you are not notified for your own edits. |
| Material Design | Snackbar with Undo is the recommended pattern for reversible operations ([M3 snackbar](https://m3.material.io/components/snackbar/guidelines)) | — | — |

Pattern: durable inboxes hold things that *happened to you* (background
outcomes, other people, system state) and need attention; confirmations of
what you just did are transient, ideally with Undo. Only VS Code keeps a
history of every toast, and it does so because its toasts *are* its
notifications — it has no separate feedback channel. None of these products
document logging the user's own archive-style actions to a notification inbox.

## Options evaluated

| Option | Noise | Expectation fit | Undo validity | Persistence | Isolation / privacy | Scope |
| --- | --- | --- | --- | --- | --- | --- |
| A. Keep scoped inbox, fix copy (chosen) | none added | closes the gap the copy created | n/a | unchanged | unchanged | one string + spec |
| B. Retain important errors / background completions / actionable events | low | good; matches Alert/Event classes already defined | needs serializable actions (e.g. `open-session`) | fine | task events would need workspace + session identity in a profile-wide store | new action types, new producers for task.completed / failed / permission; product decision on which events |
| C. Retain all toasts / events | high; every archive, rename, install, error becomes an unread badge | over-delivers; contradicts #2215 | closure-based Undo cannot be persisted; a persisted "Undo archive" can be stale (already restored, deleted, workspace gone) | 100-entry cap fills fast | archive titles from every workspace land in one profile-wide list | large; reverses a merged design |
| D. Separate activity / history log from attention inbox | none in the inbox | best long term | history entries are records, not actions | needs its own store and retention | needs per-workspace filtering | new surface; needs a product owner |

Option A is the smallest evidence-backed resolution. Options B and D are
reasonable follow-ups but need an explicit product decision; the parallel
archive fix (#4818) already listed D as future scope. Option C is not
recommended.

## Root cause of the mismatch

The empty-state hint `notifications.empty_hint` ("Updates from OpenWork Cloud
and your workspaces will show up here.") described the *sources* of entries
without describing the *class*. A person who just archived a session and saw a
"Session archived" toast reads "your workspaces" as covering that event, opens
the bell, and finds it empty. The hint now names what qualifies (new models,
extension changes, applied reloads, errors needing attention) and says that
confirmations of your own actions appear briefly instead. Other locales do not
define this key and fall back to English.

## Regression proof

`evals/specs/notification-center-scope.e2e.test.ts` (world
`evals/worlds/notification-center.ts`) asserts on a real desktop:

1. fresh profile: `notifications.list` is empty, the bell has no badge, the
   panel shows the new hint and not the old one;
2. archiving a session (v1 engine) shows the undoable toast and leaves
   `notifications.list` empty and the bell unbadged, before and after Undo;
3. the real provider-sync window event lands as exactly one unread
   `providers` entry with the `open-model-picker` action and a `1` badge, a
   second sync coalesces into the same entry, and a repeat of an already-seen
   provider adds nothing, with no popup for any of them;
4. the entry survives a reload unread, closing the panel marks it read and
   clears the badge, and the read state survives another reload.

Not covered here, by design: task completion / failure / permission prompts
(OS notifications, separate contract) and per-workspace isolation of the
profile-wide store (no behavior change in this PR).
