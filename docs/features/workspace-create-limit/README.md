# Limit workspaces per person

Each workspace brings its own setup and included model budget, so Den can limit how many workspaces one person creates. The count uses the recorded founder of each workspace, so handing a workspace to someone else does not free up a slot.

Den treats email aliases as one person: it lowercases the address, removes any `+tag`, and for Gmail removes dots and treats googlemail.com as gmail.com. alice+1@gmail.com, alice+xyz@gmail.com and a.lice@gmail.com share one count across all their accounts.

## Roll it out

1. Apply the database migration and upgrade Den.
2. Optionally set the limit on Den:
   - `DEN_WORKSPACE_CREATE_LIMIT` (default `3`, `0` turns the limit off)
   - `DEN_WORKSPACE_CREATE_WINDOW_DAYS` (default `30`, `0` counts every workspace the person founded)
   - `DEN_WORKSPACE_CREATE_LIMIT_CONTACT` (default `mailto:team@openworklabs.com`, a `mailto:` or `https://` link shown to the person)
3. Give internal test and CI accounts that create many workspaces a higher limit (below) before you turn the feature on.
4. Enable `workspaceCreateLimit` for everyone on the deployment.

## What people see

Creating a workspace, claiming a workspace an agent set up, and Better Auth's organization endpoint all check the limit. Over the limit, Den answers `403` with `error: "workspace_limit_reached"`, the limit, the window and the contact link. The web app shows "You've reached the limit of 3 workspaces. Contact us to raise it." with a Contact us link. Each refusal records a `workspace.create_limit.reached` platform audit event.

## Set limits for an email or a domain

In /admin › Limits › Workspace creation, a platform administrator can add, edit and remove limits:

- **One email address**, for example alice@acme.com may create 10.
- **Each person at a domain**, for example everyone at acme.com may create 5 each. The limit is per person, not a total for the domain.

The most specific match wins: email, then domain, then the deployment default. "No limit" lets matching people create any number. Every change is recorded in the platform audit log.

The same limits are available through the admin API and MCP:

- `GET /v1/admin/limits/workspace-creation` lists the default, window and rules.
- `PUT /v1/admin/limits/workspace-creation/rules` with `{"scope": "email", "value": "alice@acme.com", "limit": 10}` adds or changes a rule. `"limit": null` means no limit.
- `DELETE /v1/admin/limits/workspace-creation/rules/{scope}/{value}` removes it.
- `GET /v1/admin/users/{userId}/workspace-limit` shows the limit that applies to one account and its current count.
- The admin MCP tool `den_set_workspace_limit_rule` makes the same changes.

Deleted workspaces stop counting. The person's automatic first workspace is not limited.
