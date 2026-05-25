# Desktop policy extension flows

End-to-end scenarios for organization-managed extension policy. These flows are
the PR 2 baseline for Daytona/CDP automation and recordings.

## Flow 1: Disable built-in extensions for a member

**Goal:** An admin disables built-in OpenWork extensions and the assigned member
desktop stops showing or offering those extensions in normal UI.

### Admin setup

1. Sign in to Den as an org owner or admin.
2. Open Dashboard -> Desktop policies.
3. Create or edit a policy.
4. Turn off `Built-in Extensions`.
5. Assign the policy to the target member or a team containing that member.
6. Save the policy.

### Desktop steps

1. Sign in to the desktop app as the assigned member.
2. Open Settings -> Extensions -> My Extensions.
3. Confirm built-in extension cards such as `OpenWork Browser`, `Chrome`,
   `OpenAI Image Gen`, and `Ollama` are absent from the normal catalog.
4. Click `Show hidden`.
5. Confirm the same built-in extensions appear with `Disabled by organization`.
6. Open the composer tool menu -> Extensions.

### Expected outcome

- The member desktop receives the policy without an app restart.
- Normal My Extensions does not show built-in extension cards.
- `Show hidden` reveals blocked built-ins with `Disabled by organization`.
- Built-in extension detail modals do not expose connect/install actions.
- Composer Extensions has no built-in extension shortcuts.
- Marketplace packages, custom MCPs, skills, providers, and workers are not
  disabled by this policy.

## Flow 2: Re-enable built-in extensions for a member

**Goal:** Reverting the policy restores built-in extensions dynamically.

### Admin setup

1. As org owner or admin, edit the same desktop policy.
2. Turn on `Built-in Extensions`.
3. Save the policy.

### Desktop steps

1. Keep the assigned member desktop app open.
2. Refresh the desktop policy context by switching orgs, refreshing Cloud
   Account, or waiting for policy refresh.
3. Open Settings -> Extensions -> My Extensions.
4. Open the composer tool menu -> Extensions.

### Expected outcome

- Built-in extension cards return to the normal runtime extension list.
- Composer Extensions shows enabled built-in shortcuts again.
- Existing local hidden/disabled preferences are preserved independently of the
  org policy toggle.
