# Personal agent routes

`/v1/personal-agents` lets a member create and run agents of their own. Every
route needs the `personalAgents` feature for the caller's organization and
answers 404 without it; the same flag removes these operations from OpenWork
Connect's capability catalog.

- An agent is a name plus a versioned definition: a Markdown brief, a tool
  policy, a default placement and a monthly budget (stored, not enforced yet).
- A routine is a Cloud Automation with `agentId`. Its revision pins the agent
  version it runs with. Changing the agent moves its routines to the new
  version; archiving the agent archives them.
- `POST /v1/personal-agents/:id/run` is a manual Automation run of one routine.

The run itself lives in `src/automations/service.ts`: it adds the pinned brief
in front of the routine's instructions and puts the tool policy on the run's
credential as scopes (`src/mcp/workbot-turn-limits.ts`).
