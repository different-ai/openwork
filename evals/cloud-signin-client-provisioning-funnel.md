# Cloud sign-in to client provisioning funnel

This eval verifies the founder funnel from web sign-in to a provisioned desktop
client. It is intentionally product-oriented: the pass criteria cover both
whether the flow works and whether a new customer understands how value reaches
their client app.

## Goal

Validate that a workspace owner can:

- Sign in from the website.
- Create or select an organization.
- Provision one useful capability for clients, such as a skill, provider, or
  marketplace extension.
- Open the desktop app and see that provisioned capability available without
  manual local setup.
- Execute or start a task that demonstrates the capability.

## Recommended Daytona setup

Use two sandboxes so the cloud server and desktop client behave like separate
surfaces:

```bash
bash .devcontainer/test-server-on-daytona.sh dev
```

Save the printed Den Web and Den API URLs, then start Electron against them:

```bash
bash .devcontainer/test-on-daytona.sh dev \
  --den-base-url <DEN_WEB_URL> \
  --den-api-base-url <DEN_API_URL> \
  --require-signin \
  --record-video \
  --recording-name cloud-signin-client-provisioning-funnel
```

Seed demo org, members, marketplace packages, policies, and at least one
predefined skill/provider bundle before running the desktop half. Prefer a seed
profile named `client-provisioning-demo` so future evals are repeatable.

## Funnel checkpoints

Record each checkpoint with a timestamp, screenshot, and pass/fail note:

| Checkpoint | Expected signal |
| --- | --- |
| `website_signin_visible` | Website shows sign-in/create-account CTA. |
| `website_signin_complete` | User lands in an org dashboard, not a generic marketing page. |
| `org_selected` | Active organization is visible and understandable. |
| `provisioning_surface_visible` | Admin can find marketplace/plugins/skills/providers from the dashboard. |
| `capability_selected` | Selected capability explains what it will do for clients. |
| `capability_assigned` | Dashboard confirms the capability is assigned/enabled for members or clients. |
| `desktop_handoff_started` | User sees a clear route to connect the desktop client. |
| `desktop_handoff_complete` | Desktop app shows the same org/account. |
| `client_capability_visible` | Provisioned skill/plugin/provider appears in desktop with org/cloud labeling. |
| `client_task_started` | User can start a task using the provisioned capability. |
| `client_task_value` | The task produces a visible useful output or clear next action. |

## Scenario A: website sign-in to desktop handoff

1. Open Den Web in a browser from the printed `DEN_WEB_URL`.
2. Sign in with the seeded owner account.
3. Confirm the user lands on the organization dashboard.
4. Start the desktop handoff flow from the web dashboard if available.
5. In Electron, complete sign-in using the handoff URL or paste-code flow.
6. Confirm the desktop Account page shows the same organization.

Expected outcome:

- The user can tell they are signed in on both web and desktop.
- There is no ambiguous “download app” dead end in the eval. If download is
  present, note it but skip the binary download.

## Scenario B: provision a predefined skill to clients

1. In Den Web, open the provisioning or marketplace surface.
2. Select a seeded skill bundle, for example `Client Research Starter`.
3. Enable or assign it to the demo member/client group.
4. In Electron, refresh or wait for sync.
5. Open Settings -> Skills or the relevant client-visible surface.
6. Confirm the skill appears with cloud/org provenance.
7. Start a chat task that uses or references the provisioned skill.

Expected outcome:

- The desktop client sees the skill without copying files locally.
- The user understands the admin action changed what the client can do.
- The task reaches a useful response, not only a “skill installed” state.

## Scenario C: provision a marketplace extension/plugin to clients

1. In Den Web, open Marketplace or Extensions.
2. Select a seeded marketplace package.
3. Assign it to the demo member/client group.
4. In Electron, open Settings -> Extensions -> Marketplace.
5. Confirm the package appears as assigned, installed, managed, or available.
6. If setup is required, verify the client sees clear setup instructions.
7. Start a task or action that proves the extension is usable.

Expected outcome:

- The desktop client can tell what was provisioned by the organization.
- The provisioning flow has a clear final state.
- The first value moment is tied to a task or extension action, not only a list
  item changing status.

## Scenario D: provision a custom model provider to clients

1. In Den Web or through Den API, create a custom `@ai-sdk/openai-compatible`
   provider with an organization-managed API key and at least one known-working
   model.
2. In Electron, open Settings -> Cloud Providers.
3. Confirm the custom provider appears with `Cloud` provenance and `Credential
   ready`.
4. Import the provider, reload if prompted, and select its model in the session
   composer.
5. Send a short prompt that requires a real model response, for example `Reply
   exactly: Cloud custom provider value OK`.

Expected outcome:

- The model response completes successfully with the requested text or an
  equivalent useful answer.
- The session metadata shows the imported `lpr_*` provider id and selected model.
- No provider key is written to visible config or screenshots.
- The run does not fail with provider `401`, missing `Authorization`, or missing
  API key errors after the provider showed `Credential ready`.

## Works criteria

The flow works if all of these are true:

- Web sign-in succeeds with the seeded account.
- Desktop handoff succeeds.
- At least one org-provisioned skill, provider, extension, or plugin appears in
  the desktop client.
- The client can start a task using the provisioned capability.
- If the provisioned capability is a custom cloud provider, the task must reach
  a real model response, not only show the provider as connected.

## Good criteria

The flow is good if all of these are true:

- The user can explain what they provisioned and who receives it.
- The web dashboard provides a clear next step to open or connect the client.
- The desktop client explains that the capability came from the organization.
- The first useful task is available within one obvious step after provisioning.
- The flow does not require copying config, editing files, or guessing where to
  refresh.

## Self-optimizing loop

After every run, write `/daytona-artifacts/validation/cloud-signin-client-provisioning-funnel.json` with:

```json
{
  "scenario": "cloud-signin-client-provisioning-funnel",
  "commit": "<git sha>",
  "checkpoints": [
    { "name": "website_signin_visible", "ok": true, "seconds": 12 },
    { "name": "client_task_value", "ok": false, "seconds": null, "blocker": "Capability visible but no task CTA" }
  ],
  "friction": [
    { "severity": "high", "surface": "desktop", "note": "Client capability appears but does not explain what to do next." }
  ],
  "nextRunChanges": [
    "Seed a capability with an obvious sample task CTA.",
    "Assert cloud/org provenance label in desktop list item."
  ]
}
```

Use the `nextRunChanges` array to update this eval before the next run. The eval
should improve itself by capturing the shortest successful path, known blockers,
and the next assertion to add.

## Evidence package

Each run should publish these artifacts:

- Raw web recording.
- Raw desktop recording.
- Screenshots for all checkpoint states.
- Validation JSON.
- Founder summary: conversion path, blockers, time to value.
- Designer summary: screen sequence, missing guidance, copy issues.
