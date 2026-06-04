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

## Founder / designer review bar

These evals are not just smoke tests. A passing recording must prove two things:

- **The main flow works**: the user reaches chat, selects a usable model, runs a task, and sees a response.
- **The main flow is good**: the recording makes the user intent, product value, and friction visible without needing code context.

For each recorded onboarding scenario, capture:

- Raw video from first visible welcome screen through first completed task response.
- Screenshots at welcome, model/provider choice, provider connected, model selected, task submitted, and response complete.
- A timestamp table with: welcome visible, workspace selected, provider choice visible, provider connected, model selected, first task submitted, first response complete.
- Funnel metrics: total time to first task response, click count, reload count, blocking errors, and user-visible dead ends.
- Friction notes written in product language, for example: “user leaves chat for settings,” “reload required before value,” or “payment/sign-in appears before value is demonstrated.”
- Any automation boundary, especially native folder picker workarounds in CDP. Do not hide these from founder/design review.

Recommended first task prompt for value validation:

```text
Create a short welcome checklist for this OpenWork workspace. Use exactly three bullets and mention one thing I can do next.
```

Pass criteria for every value-flow recording:

- The user can understand why they are choosing this model/provider path.
- The flow returns to chat or keeps chat visibly accessible after provider setup.
- A usable model is selected before the task is run.
- The task is submitted from the composer with the normal “Run task” action.
- The recording shows a model response, not just provider setup.
- The summary identifies any friction severe enough to block activation.

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
   - A "Pick a folder to get started" button on desktop.
5. No sidebar, no session chrome, no loading overlay.

Tool recipe:
```
chrome-devtools_take_snapshot
```

Pass criteria:
- URL is `/welcome`.
- Heading "Welcome to OpenWork" is visible.
- All six capability cards are present.
- "Pick a folder to get started" button is visible and clickable on desktop.
- No sidebar or session layout is rendered.

Known regressions this catches:
- Missing `/welcome` route in `app-root.tsx`.
- Redirect logic in `session-route.tsx` not firing because `loading`
  never becomes false.
- `hasCompletedOnboarding` not defaulting to `false` for new installs.

---

## Flow 21 — Welcome CTA starts workspace creation

**Why**: The welcome CTA is the single first-run action. On desktop it
opens the native folder picker directly; on non-desktop it falls back to
the `CreateWorkspaceModal` chooser.

Steps:
1. From `/welcome`, click "Pick a folder to get started".
2. Desktop expect: native folder picker opens with title "Authorize folder".
3. Non-desktop expect: the `CreateWorkspaceModal` overlay appears.
4. Non-desktop expect: the modal shows two option cards:
   - "Local workspace"
   - "Connect custom remote"
5. If the modal appears, click the close button (X).
6. Expect: modal closes, welcome page is still visible.

Tool recipe:
```
chrome-devtools_take_snapshot
chrome-devtools_click { uid: <Pick a folder button> }
chrome-devtools_take_snapshot
chrome-devtools_click { uid: <Close modal button> }
chrome-devtools_take_snapshot
```

Pass criteria:
- Desktop native picker or non-desktop modal opens from the welcome CTA.
- Non-desktop modal shows both workspace type options.
- Closing the modal or cancelling the picker returns to the welcome page.

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

## Flow 27 — Bring your own API key reaches first task value

**Why**: Provider setup is not the product value. The user should connect a provider, pick a usable model, and run a first task in chat without being stranded in settings.

Steps:
1. Start from a clean first-run app at `/welcome` with no workspaces.
2. Create a local workspace through the welcome CTA.
3. On “Power your first task,” choose “Bring your own API key.”
4. Expect: the provider connector opens from the session surface and keeps composer return focus.
5. Connect OpenAI with a valid temporary key, or use an explicitly labeled test key only when validating UI copy.
6. Expect: after saving the key, the model picker opens automatically.
7. Select an OpenAI model.
8. Expect: the app returns to the composer.
9. Submit the recommended first task prompt.
10. Expect: a model response appears in the chat transcript.

Founder/designer pass criteria:
- The recording shows why the user is connecting a provider and what they do next.
- The user does not need to discover a toast to continue to model selection.
- The user reaches a completed response in chat.
- Friction is recorded if the flow leaves chat, requires a reload, or hides the next step.

---

## Flow 28 — OpenWork Models path explains payment before value

**Why**: OpenWork Models is the preferred business path, but it must make the tradeoff clear: pay/sign in through OpenWork Cloud to skip API keys, then return to task execution.

Steps:
1. Start from a clean first-run app at `/welcome` with no workspaces.
2. Create a local workspace through the welcome CTA.
3. On “Power your first task,” choose “Use OpenWork Models.”
4. Expect: the user sees the OpenWork Models value proposition and sign-in/payment CTA.
5. If a paid/signed-in test account is available, complete sign-in, select an OpenWork model, and run the recommended first task prompt.
6. If no paid/signed-in test account is available, record the exact stop point and mark the run as “funnel blocked before task value.”

Founder/designer pass criteria:
- The recording clearly shows the paid path and what value it unlocks.
- The summary states whether payment/sign-in blocks first task execution.
- If blocked, the summary proposes the smallest product fix, such as demo credits, a trial task, or an inline fallback to bring-your-own-key.

---

## Flow 29 — Ollama local model reaches first task value

**Why**: Local model onboarding should prove that users can understand setup requirements, connect an available local model, reload if needed, and still reach chat value.

Steps:
1. Start from a clean first-run app at `/welcome` with no workspaces.
2. Create a local workspace through the welcome CTA.
3. Choose “Skip and use the free model” or enter the workspace, then open Extensions.
4. Open the Ollama setup card.
5. Expect: the UI explains whether Ollama is running and lists available local models.
6. Select an available model and click “Add to workspace.”
7. If a reload is required, click “Reload now” and include that in the friction metrics.
8. Confirm AI Providers shows “Ollama (local).”
9. Select the Ollama model, return to chat, and submit the recommended first task prompt.
10. Expect: a response appears, or the summary marks model-runtime failure separately from onboarding UI failure.

Founder/designer pass criteria:
- The recording shows the local-model prerequisite in plain language.
- The reload requirement is measured as funnel friction.
- The user reaches a completed chat response when a real local model is available.
- If the eval uses a mock Ollama endpoint, the recording and summary label it clearly and do not claim model-quality success.

---

## Change log

- 2026-04-29 — initial doc for the onboarding welcome feature
  (Flows 20-26).
- 2026-06-03 — added founder/designer value-flow criteria and first task
  activation evals (Flows 27-29).
