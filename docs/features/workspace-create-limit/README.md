# Limit workspaces per person

Each workspace brings its own setup and included model budget, so Den can limit how many workspaces one person creates. The count uses the recorded founder of each workspace, so handing a workspace to someone else does not free up a slot.

## Roll it out

1. Apply the database migration and upgrade Den.
2. Optionally set the limit on Den:
   - `DEN_WORKSPACE_CREATE_LIMIT` (default `3`, `0` turns the limit off)
   - `DEN_WORKSPACE_CREATE_WINDOW_DAYS` (default `30`, `0` counts every workspace the person founded)
   - `DEN_WORKSPACE_CREATE_LIMIT_CONTACT` (default `mailto:team@openworklabs.com`, a `mailto:` or `https://` link shown to the person)
3. Give internal test and CI accounts that create many workspaces an override (below) before you turn the feature on.
4. Enable `workspaceCreateLimit` for everyone on the deployment.

## What people see

Creating a workspace, claiming a workspace an agent set up, and Better Auth's organization endpoint all check the limit. Over the limit, Den answers `403` with `error: "workspace_limit_reached"`, the limit, the window and the contact link. The web app shows "You've reached the limit of 3 workspaces. Contact us to raise it." with a Contact us link. Each refusal records a `workspace.create_limit.reached` platform audit event.

## Raise the limit for one person

A platform administrator can read and change one account's limit:

- `GET /v1/admin/users/{userId}/workspace-limit` returns the effective limit and how many workspaces the person founded inside the window.
- `PUT /v1/admin/users/{userId}/workspace-limit` with `{"limit": 10}` sets a new limit, `{"limit": null}` removes it, and `{"limit": "default"}` restores the deployment limit.
- The admin MCP tool `den_set_user_workspace_limit` makes the same change.

Deleted workspaces stop counting. The person's automatic first workspace is not limited.
