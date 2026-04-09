# Me Routes

This folder owns routes about the currently authenticated user.

## Files

- `index.ts`: registers `/v1/me` and `/v1/me/orgs`

## Current responsibilities

- return the current authenticated user/session payload
- resolve the orgs the current user belongs to
- expose active org selection data for the current session

## Middleware expectations

- use `requireUserMiddleware` when a route needs an authenticated user
- use `resolveUserOrganizationsMiddleware` when a route needs org membership context

## Notes for future work

- Keep this folder focused on the current actor, not arbitrary user admin operations
- If more current-user subareas appear later, split them into additional files inside this folder
