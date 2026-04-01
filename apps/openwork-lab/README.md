# OpenWork Lab

Single-workspace, web-first OpenWork client built from scratch and inspired by `ee/apps/den-web`.

## What it is

- one active workspace
- one clean session-first shell
- one same-origin proxy to OpenWork server
- one Electron wrapper for desktop testing

## Local development

1. Install workspace dependencies from the repo root:
   `pnpm install`
2. Start an OpenWork server for a workspace you want to use.
3. Run the lab app:
   `pnpm --filter @openwork/openwork-lab dev`
4. Open `http://localhost:3016`

## Electron wrapper

- Dev mode: `pnpm --filter @openwork/openwork-lab electron:dev`
- Local production-style wrapper: `pnpm --filter @openwork/openwork-lab build && pnpm --filter @openwork/openwork-lab electron:start`

## Required inputs

The connect screen expects:

- OpenWork server URL
- client token
- optional owner/host token for writes that require elevated approval
- optional workspace ID when the server exposes more than one workspace

## Core flows in scope

- connect to one OpenWork server workspace
- list and create sessions
- read and send prompts in a session
- answer permissions and questions
- inspect todos
- read and edit a workspace file
- reload the workspace engine
- inspect and update authorized folders
