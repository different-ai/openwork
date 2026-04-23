# GitHub Connection UX Plan

## Goal

Define the desired user experience for connecting GitHub to OpenWork in den-web (cloud), independent of the current implementation state.

This flow is for the den-api plugin connector system and GitHub App based connector onboarding.

## Desired user flow

1. User is in OpenWork den-web (cloud).
2. User sees an `Integrations` entry point.
3. User opens `Integrations`.
4. User sees a GitHub integration card.
5. User clicks `Connect` on GitHub.
6. OpenWork sends the user to the GitHub App install/authorize flow.
7. User completes the normal GitHub steps on GitHub.
8. GitHub returns the user to OpenWork.
9. OpenWork recognizes the completed GitHub App installation for the current org/user context.
10. OpenWork shows the user the list of repositories available through that installation.
11. User selects one repository.
12. OpenWork creates a new GitHub connector instance for that selected repository.
13. OpenWork configures webhook-driven sync for that repository.
14. Future pushes to the connected repository trigger OpenWork sync behavior through the connector pipeline.

## Product expectations

### Integrations surface

- den-web should expose a clear `Integrations` UI in cloud mode.
- GitHub should appear as a first-class integration option.
- The user should not need to manually paste GitHub installation ids or repository ids.

### Connect action

- Clicking `Connect` should start a GitHub App flow, not a legacy OAuth-only flow.
- The flow should preserve enough OpenWork context to return the user to the correct org and screen after GitHub finishes.
- The GitHub-side step should feel like a normal GitHub App installation flow.

### Return to OpenWork

- After GitHub redirects back, OpenWork should detect the installation that was just created or updated.
- If installation state is incomplete or ambiguous, OpenWork should guide the user instead of silently failing.
- The user should land back in the GitHub integration flow, not on a generic page with no next step.

### Repository selection

- OpenWork should list repositories available to the installation.
- The user should be able to pick one repository as the first connected source.
- Selecting a repository should create a connector instance for that repo in the current OpenWork org.
- The UX may later support branch choice and mapping choice, but repository selection is the minimum required step.

### Webhook + sync expectation

- Once connected, OpenWork should be ready to receive GitHub App webhooks for the selected repository.
- Pushes on the tracked branch should enter the connector sync pipeline.
- The system should present this as a connected integration, not as a hidden backend-only setup.

## User-facing behavior requirements

- The user should not need to know what an installation id is.
- The user should not need to call admin APIs manually.
- The user should not need to configure webhooks manually in normal product usage.
- The user should be able to understand whether GitHub is:
  - not connected
  - connected but no repository selected
  - connected and repository syncing
  - connected but needs attention

## Desired backend behavior

To support the UX above, the backend flow should conceptually do the following:

1. Generate or expose the GitHub App install URL.
2. Preserve OpenWork return context across the redirect.
3. Handle the GitHub return/callback.
4. Resolve the GitHub App installation id associated with the user action.
5. Create or update the corresponding `connector_account`.
6. List repositories accessible through that installation.
7. On repo selection, create:
   - a `connector_instance`
   - a `connector_target` for the repo/branch
   - any initial mappings needed for ingestion
8. Ensure webhook events can resolve that connector target.
9. Queue sync work when relevant webhook events arrive.

## UX principles

- Prefer a short, guided flow over a configuration-heavy admin experience.
- Favor product language like `Connect GitHub` over backend nouns like `connector account`.
- Hide raw GitHub/App identifiers from the normal UX unless needed for support/debugging.
- Keep the first-run flow focused on success: install, return, pick repo, connected.
- Advanced settings can exist later, but should not block first connection.

## Success criteria

The experience is successful when:

1. A cloud user can start from den-web without using terminal commands.
2. The user can complete GitHub App installation from the app.
3. The user returns to OpenWork automatically.
4. OpenWork shows repositories from that installation.
5. The user selects a repo.
6. OpenWork creates a connector instance for that repo.
7. GitHub webhooks for that repo can be accepted and associated to the instance.
8. The connection state is visible in the product UI.

## Non-goals for this document

- Exact API shapes for every route.
- Full ingestion/reconciliation design details.
- Delivery/install runtime behavior for connected content.
- Final UI layout or visual design.

## Next planning step

Translate this desired UX into an implementation plan that maps:

- den-web screens and states
- den-api routes and callback behavior
- GitHub App configuration requirements
- connector-account / connector-instance creation behavior
- webhook readiness and initial sync behavior
