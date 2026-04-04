## Product

OpenWork helps individual create, consume, and maintain their agentic workflows.

OpenWork helps companies share their agentic workflows and provision their entire team.

The chat interfaces is where people consume the workflows.

Interfaces for consuming workflows:
- Desktop app
- Slack
- Telegram

What is a "agentic workflow":
- LLM providers
- Skills
- MCP
- Agents
- Plugins
- Tools
- Background Agents

Where are workflows created:
- Desktop app (using slash commands like `/create-skills`)
- Web App
- [We need better places for this to happen[

Where are workflows maintain:
- In OpenWork Cloud (internal name is Den).

Where are workflow hosted:
- Local Machine
- Remote via a OpenWork Host (CLI or desktop)
- Remote on OpenWork Cloud (via Den sandbox workers)

## Current OpenWork Cloud flow

- Users can sign in with the standard web auth providers or accept an org invite through the hosted join flow.
- Invite signup keeps the invited email fixed, verifies the user by email code, and then drops them into the org join path.
- Org creation can trigger checkout up front when billing is required, and launch attempts surface org limits when the current plan does not allow more workers or members.
- After a worker is ready, the user connects from the OpenWork app with `Add a worker` -> `Connect remote`, or opens the generated deep link directly.

## Team distribution

- Organizations can publish shared skill hubs so members discover approved skills from one managed place instead of collecting local-only installs by hand.
- Org admins can now manage teams directly in the hosted dashboard and grant each skill hub to the exact teams that should inherit it.
- Team members install those approved skills from the desktop Skills page through the OpenWork Cloud catalog instead of importing local files manually.
- Power users can also share an installed desktop skill back to the org hub or publish a public install link from the same Skills page.

## Actors
Bob IT guy makes the config.
Susan the accountant consumes the config.

Constraints:
- We use standards were possible
- We use opencode where possible
- We stay platform agnostic


How to decide if OpenWork should do something:
- Does it help Bob share config more easily?
- Does it help Susan consume automations more easily?
- Is this something that is coding specific?
