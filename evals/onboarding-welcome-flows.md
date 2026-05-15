# Onboarding / welcome flows

End-to-end scenarios that cover the first-run onboarding experience
introduced in `feat/onboarding-welcome`. Run them before shipping any
change that touches:

- `apps/app/src/react-app/domains/onboarding/**`
- `apps/app/src/react-app/shell/welcome-route.tsx`
- `apps/app/src/react-app/shell/app-root.tsx` (route table)
- `apps/app/src/react-app/domains/workspace/create-workspace-local-panel.tsx`
- `apps/app/src/react-app/kernel/local-provider.tsx` (`hasCompletedOnboarding`)
- `apps/app/src/react-app/shell/session-route.tsx` (redirect to `/welcome`)

## Preflight

Before running any eval:

1. Reset onboarding state so the welcome screen appears:
   - Open DevTools console and run:
     ```js
     const raw = localStorage.getItem("openwork.preferences");
     const prefs = raw ? JSON.parse(raw) : {};
     prefs.hasCompletedOnboarding = false;
     localStorage.setItem("openwork.preferences", JSON.stringify(prefs));
     location.reload();
     ```
   - Alternatively: use the "Reset onboarding" button in Settings > Recovery
     (debug mode).

2. Remove all workspaces so the app detects `workspaces.length === 0`:
   - This can be done via the sidebar "Remove workspace" menu for each
     workspace, or by clearing app state entirely.

3. Reload the app. It should redirect to `/welcome`.

---

## Flow 20 — Welcome screen renders on first launch

**Why**: When a user opens OpenWork for the first time with zero
workspaces and `hasCompletedOnboarding === false`, they must see the
full-screen welcome page — not the session empty state.

Steps:
1. Ensure preflight conditions are met (no workspaces, onboarding not
   completed).
2. Navigate to `/` or `/session`.
3. Expect: URL redirects to `/welcome`.
4. Expect: full-screen page renders with:
   - "Welcome to OpenWork" heading.
   - "Your computer, but it works for you." subtitle.
   - Six capability cards: spreadsheets, browser, files, automate,
     content, APIs.
   - A "Get started" button.
5. No sidebar, no session chrome, no loading overlay.

Tool recipe:
```
chrome-devtools_take_snapshot
```

Pass criteria:
- URL is `/welcome`.
- Heading "Welcome to OpenWork" is visible.
- All six capability cards are present.
- "Get started" button is visible and clickable.
- No sidebar or session layout is rendered.

Known regressions this catches:
- Missing `/welcome` route in `app-root.tsx`.
- Redirect logic in `session-route.tsx` not firing because `loading`
  never becomes false.
- `hasCompletedOnboarding` not defaulting to `false` for new installs.

---

## Flow 21 — Get started opens workspace creation modal

**Why**: The "Get started" button is the single CTA on the welcome
page. It must open the `CreateWorkspaceModal` with the chooser screen
(local / remote / cloud).

Steps:
1. From `/welcome`, click "Get started".
2. Expect: the `CreateWorkspaceModal` overlay appears.
3. Expect: the modal shows three option cards:
   - "Local workspace"
   - "Connect custom remote"
   - "Shared workspaces"
4. Click the close button (X).
5. Expect: modal closes, welcome page is still visible.

Tool recipe:
```
chrome-devtools_take_snapshot
chrome-devtools_click { uid: <Get started button> }
chrome-devtools_take_snapshot
chrome-devtools_click { uid: <Close modal button> }
chrome-devtools_take_snapshot
```

Pass criteria:
- Modal opens on "Get started" click.
- All three workspace type options are visible.
- Closing the modal returns to the welcome page (stays on `/welcome`).

Known regressions this catches:
- `CreateWorkspaceModal` not rendering because `open` prop isn't wired.
- Modal z-index too low, hidden behind the welcome page.

---

## Flow 22 — Local workspace creation from welcome flow

**Why**: The most common first-run path: pick a local folder and
create a workspace. After creation, onboarding must be marked complete
and the user lands in the new workspace session surface.

Steps:
1. From `/welcome`, click "Get started".
2. Click "Local workspace".
3. Expect: the local panel shows:
   - "Pick a folder" heading.
   - Explanation text: "This folder becomes your workspace. OpenWork
     will be able to:"
   - Three bullet points with check icons (read, write, anything).
   - "Drop files in anytime..." hint.
   - Folder picker input (empty).
   - "Select folder" button.
4. Click "Select folder" and choose a folder.
5. Click "Create Workspace".
6. Expect: workspace is created; URL changes to
   `/workspace/<new-workspace-id>/session/<new-session-id>`.
7. Navigate to `/welcome`.
8. Expect: URL redirects back to `/session` (not `/welcome`), because
   `hasCompletedOnboarding` is now true.

Tool recipe:
```
chrome-devtools_take_snapshot
chrome-devtools_click { uid: <Get started> }
chrome-devtools_click { uid: <Local workspace card> }
chrome-devtools_take_snapshot
-- verify folder explanation content --
chrome-devtools_click { uid: <Select folder> }
-- native picker interaction --
chrome-devtools_click { uid: <Create Workspace> }
chrome-devtools_wait_for { text: ["New session"], timeout: 15000 }
chrome-devtools_take_snapshot
```

Pass criteria:
- Folder explanation (bullets, hint) is visible before picking.
- After workspace creation, URL contains `/workspace/` and `/session/ses_`.
- Main panel heading is "New session".
- Composer is visible with the "Run task" action.
- Composer is focused so typing starts in "Describe your task..." without an
  extra click.
- "Select or create a session to get started." is not visible.
- Navigating to `/welcome` redirects away (onboarding flagged done).
- `localStorage` contains `hasCompletedOnboarding: true` in
  `openwork.preferences`.

Known regressions this catches:
- `hasCompletedOnboarding` not persisted after local workspace creation.
- Folder explanation i18n keys missing or untranslated.
- Welcome route not checking `hasCompletedOnboarding` on mount.

---

## Flow 23 — Folder explanation visible in local workspace panel

**Why**: The folder explanation must appear every time the local
workspace panel opens — not just from the welcome flow. Users creating
a second workspace from the session sidebar should also see it.

Steps:
1. From an existing session (at least one workspace exists), click
   "Add workspace" in the sidebar.
2. Click "Local workspace".
3. Expect: the same folder explanation is visible:
   - "Pick a folder" title.
   - "This folder becomes your workspace..." explanation.
   - Three check-mark bullet points.
   - "Drop files in anytime..." hint.

Pass criteria:
- Folder explanation is present in the local panel regardless of entry
  point (welcome flow or session sidebar).
- No layout shift or broken spacing.

Known regressions this catches:
- Explanation conditionally rendered only during onboarding.
- i18n keys only loaded in the welcome route context.

---

## Flow 24 — Remote workspace creation from welcome flow

**Why**: Users connecting to a remote OpenWork server from the welcome
flow should also have onboarding marked complete.

Steps:
1. From `/welcome`, click "Get started".
2. Click "Connect custom remote".
3. Enter a valid OpenWork server URL.
4. Click "Connect remote".
5. Expect: workspace connects; URL changes away from `/welcome`.
6. Navigate to `/welcome`.
7. Expect: URL redirects to `/session`.

Pass criteria:
- `hasCompletedOnboarding` is set to true after remote workspace
  creation.
- `/welcome` is no longer accessible after onboarding.

---

## Flow 25 — Welcome screen skipped when workspaces exist

**Why**: If a user already has workspaces, the welcome screen must
never appear — even if `hasCompletedOnboarding` is false (e.g., after
a migration from a pre-onboarding version).

Steps:
1. Ensure at least one workspace exists.
2. Set `hasCompletedOnboarding` to false in localStorage.
3. Navigate to `/session`.
4. Expect: the session page renders normally. No redirect to
   `/welcome`.

Tool recipe:
```
chrome-devtools_evaluate_script {
  function: "() => {
    const raw = localStorage.getItem('openwork.preferences');
    const prefs = raw ? JSON.parse(raw) : {};
    prefs.hasCompletedOnboarding = false;
    localStorage.setItem('openwork.preferences', JSON.stringify(prefs));
    return 'done';
  }"
}
chrome-devtools_navigate_page { type: "url", url: "<base>/session" }
chrome-devtools_take_snapshot
```

Pass criteria:
- URL stays at `/session` (no redirect to `/welcome`).
- Session page renders normally with the existing workspace.

Known regressions this catches:
- Redirect logic only checks `hasCompletedOnboarding` without also
  checking `workspaces.length === 0`.

---

## Flow 26 — Reset onboarding restores welcome screen

**Why**: The debug "Reset onboarding" button should clear the flag
so developers and testers can re-trigger the welcome flow.

Steps:
1. Go to Settings > Recovery (debug).
2. Click "Reset onboarding".
3. Remove all workspaces.
4. Reload the app.
5. Expect: URL redirects to `/welcome` and the full welcome screen
   renders.

Pass criteria:
- After reset + removing workspaces + reload, the welcome screen
  appears.
- This confirms `hasCompletedOnboarding` was cleared.

---

## Change log

- 2026-04-29 — initial doc for the onboarding welcome feature
  (Flows 20-26).
