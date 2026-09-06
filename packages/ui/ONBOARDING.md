# Onboarding across Desktop and Den

Use a shared visual hierarchy and readiness language while keeping each
surface's existing navigation, buttons, forms, and task execution.

| Entry | First useful outcome | Next action |
| --- | --- | --- |
| Desktop without an account | Understand file work and reach a real task with model setup explained | Discover reusable skills and tools; choose cloud or a team when useful |
| Desktop through an invitation | Discover capabilities assigned to this person | Use what is ready; authorize a personal connection when needed |
| First-use Den | Prepare a workspace that gives teammates useful capabilities | Invite people, review their starting point, then finish setup |

## Shared components

Import `OnboardingIntro` and `OnboardingResourceRow` from `@openwork/ui/react`.
Both use the consuming application's existing theme tokens. Tailwind consumers
must include `packages/ui/src` in their source scanning.

- `OnboardingIntro` provides the eyebrow, heading, description, and optional
  supporting content. Set `headingLevel={2}` when the surrounding screen
  already has its primary heading. Keep actions in the owning surface.
- `OnboardingResourceRow` presents an icon, title, description, status, and
  action. Pass the existing application `Button` or `Badge` into its slots.
  Icons are decorative; put the resource's accessible name in `title`.
  Use an enclosing list when the content is a list of resources.

These components deliberately do not fetch data, decide access, trigger task
execution, store onboarding progress, or provide another navigation shell.
Desktop keeps its app components. Den keeps `SetupFrame`, including its aligned
brand, progress, content, and footer.

## Readiness language

The calling surface must derive every state from its authorized data:

- **Ready to use** means the user can use that capability now.
- **Available from your team** means assigned or shared; it does not imply
  personal authorization or usable model access.
- **Connect your account** means the individual must authorize access.
- **Setup needed** means a required configuration is missing. Explain who can
  complete it; ordinary members should not be directed to owner-only settings.

A skill being available does not imply that its tools or model are ready. A
recommended task must account for those dependencies. Admin previews describe
the access the intended recipient will receive, not every resource the admin
can manage. Keep example content visibly labeled and separate from real
connection or execution state.

## Completion

Desktop should explain the next real task and preserve the user's work through
sign-in and model setup. A preview must not pretend to be an AI run. OpenWork
account creation and external model authorization are separate requirements.

Den should review invitations, shared capabilities, and remaining setup before
the explicit finish action opens normal workspace navigation. Downloading the
desktop app is optional, and finishing workspace setup does not authorize
teammates' personal accounts or complete missing model configuration.
